import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  AppUser,
  EmergencyIncident,
  NotificationItem,
  TrustedContact,
  UserPreferencesData,
  UserProfileData,
  UserRole,
} from '../types/lifeline.ts';
import {
  clearInMemoryGoogleToken,
  getInMemoryGoogleToken,
  signInWithGoogleWorkspace,
  signOutFirebase,
} from '../lib/firebase.ts';

interface AuthContextValue {
  user: AppUser | null;
  profile: UserProfileData | null;
  preferences: UserPreferencesData | null;
  token: string | null;
  googleAccessToken: string | null;
  loading: boolean;
  demoMode: boolean;
  setDemoMode: (v: boolean) => void;
  contacts: TrustedContact[];
  incidents: EmergencyIncident[];
  operatorIncidents: EmergencyIncident[];
  notifications: NotificationItem[];
  mapsApiKey: string;
  realtimeConnected: boolean;
  apiFetch: <T = unknown>(url: string, options?: RequestInit) => Promise<T>;
  loginWithEmail: (email: string, password: string) => Promise<void>;
  registerWithEmail: (input: {
    email: string;
    password: string;
    displayName: string;
    role: 'regular_user' | 'emergency_operator' | 'support_organization';
  }) => Promise<{ verificationCodePreview?: string }>;
  loginWithGoogle: () => Promise<void>;
  connectWorkspaceOAuth: () => Promise<string | null>;
  loginDemoRole: (role: UserRole) => Promise<void>;
  logout: () => Promise<void>;
  refreshAllData: () => Promise<void>;
  setUser: React.Dispatch<React.SetStateAction<AppUser | null>>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const TOKEN_STORAGE_KEY = 'lifeline_session_token';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [profile, setProfile] = useState<UserProfileData | null>(null);
  const [preferences, setPreferences] = useState<UserPreferencesData | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_STORAGE_KEY));
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [demoMode, setDemoMode] = useState<boolean>(() => localStorage.getItem('lifeline_demo_mode') === 'true');
  const [contacts, setContacts] = useState<TrustedContact[]>([]);
  const [incidents, setIncidents] = useState<EmergencyIncident[]>([]);
  const [operatorIncidents, setOperatorIncidents] = useState<EmergencyIncident[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [mapsApiKey, setMapsApiKey] = useState<string>(() => import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '');
  const [realtimeConnected, setRealtimeConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    localStorage.setItem('lifeline_demo_mode', String(demoMode));
  }, [demoMode]);

  // Load public Maps client key fallback if not injected via VITE_ at build time
  useEffect(() => {
    if (!mapsApiKey) {
      fetch('/api/config/public')
        .then((r) => r.json())
        .then((data: { mapsApiKey?: string }) => {
          if (data.mapsApiKey) setMapsApiKey(data.mapsApiKey);
        })
        .catch(() => {});
    }
  }, [mapsApiKey]);

  const apiFetch = useCallback(
    async <T = unknown,>(url: string, options: RequestInit = {}): Promise<T> => {
      const headers = new Headers(options.headers || {});
      if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
        headers.set('Content-Type', 'application/json');
      }
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      const gToken = getInMemoryGoogleToken();
      if (gToken) {
        headers.set('x-google-access-token', gToken);
      }

      const resp = await fetch(url, { ...options, headers });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        if (resp.status === 429 || (data as { error?: { status?: string } })?.error?.status === 'RESOURCE_EXHAUSTED') {
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
        }
        const message =
          (data as { error?: string | { message?: string } })?.error &&
          typeof (data as { error?: unknown }).error === 'string'
            ? (data as { error: string }).error
            : (data as { error?: { message?: string } })?.error?.message || `Request failed (${resp.status})`;
        throw new Error(message);
      }
      return data as T;
    },
    [token]
  );

  const refreshAllData = useCallback(async () => {
    if (!token) return;
    try {
      const me = await apiFetch<{ user: AppUser; profile: UserProfileData; preferences: UserPreferencesData }>('/api/auth/me');
      setUser(me.user);
      setProfile(me.profile);
      setPreferences(me.preferences);
      if (me.user.isDemoAccount) setDemoMode(true);

      const [cRes, iRes, nRes] = await Promise.all([
        apiFetch<{ contacts: TrustedContact[] }>('/api/contacts'),
        apiFetch<{ incidents: EmergencyIncident[] }>('/api/incidents'),
        apiFetch<{ notifications: NotificationItem[] }>('/api/notifications'),
      ]);
      setContacts(cRes.contacts);
      setIncidents(iRes.incidents);
      setNotifications(nRes.notifications);

      if (['emergency_operator', 'support_organization', 'administrator'].includes(me.user.role)) {
        const opRes = await apiFetch<{ incidents: EmergencyIncident[] }>('/api/operator/incidents');
        setOperatorIncidents(opRes.incidents);
      } else {
        setOperatorIncidents([]);
      }
    } catch {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      setToken(null);
      setUser(null);
    }
  }, [token, apiFetch]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      if (token) {
        await refreshAllData();
      }
      setLoading(false);
    })();
  }, [token, refreshAllData]);

  // Real-time WebSocket connection for instant SOS & operator synchronization
  useEffect(() => {
    if (!token || !user) {
      wsRef.current?.close();
      wsRef.current = null;
      setRealtimeConnected(false);
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/realtime?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;

    ws.onopen = () => setRealtimeConnected(true);
    ws.onclose = () => setRealtimeConnected(false);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as { type?: string; incident?: EmergencyIncident };
        if (msg.type === 'incident:created' || msg.type === 'incident:updated') {
          if (msg.incident) {
            const inc = msg.incident;
            setIncidents((prev) => {
              if (inc.userId !== user.id) return prev;
              const exists = prev.some((i) => i.id === inc.id);
              return exists ? prev.map((i) => (i.id === inc.id ? inc : i)) : [inc, ...prev];
            });
            setOperatorIncidents((prev) => {
              if (!['emergency_operator', 'support_organization', 'administrator'].includes(user.role)) return prev;
              const exists = prev.some((i) => i.id === inc.id);
              return exists ? prev.map((i) => (i.id === inc.id ? inc : i)) : [inc, ...prev];
            });
          }
          apiFetch<{ notifications: NotificationItem[] }>('/api/notifications')
            .then((res) => setNotifications(res.notifications))
            .catch(() => {});
        } else if (msg.type === 'notification:new') {
          apiFetch<{ notifications: NotificationItem[] }>('/api/notifications')
            .then((res) => setNotifications(res.notifications))
            .catch(() => {});
        }
      } catch {
        // ignore malformed message
      }
    };

    return () => {
      ws.close();
    };
  }, [token, user, apiFetch]);

  const persistToken = (newToken: string) => {
    localStorage.setItem(TOKEN_STORAGE_KEY, newToken);
    setToken(newToken);
  };

  const loginWithEmail = async (email: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    persistToken(data.token);
    setUser(data.user);
  };

  const registerWithEmail = async (input: {
    email: string;
    password: string;
    displayName: string;
    role: 'regular_user' | 'emergency_operator' | 'support_organization';
  }) => {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    persistToken(data.token);
    setUser(data.user);
    return { verificationCodePreview: data.verificationCodePreview };
  };

  const loginWithGoogle = async () => {
    const result = await signInWithGoogleWorkspace();
    setGoogleAccessToken(result.accessToken);
    persistToken(result.idToken);
  };

  const connectWorkspaceOAuth = async (): Promise<string | null> => {
    const result = await signInWithGoogleWorkspace();
    setGoogleAccessToken(result.accessToken);
    return result.accessToken;
  };

  const loginDemoRole = async (role: UserRole) => {
    const res = await fetch('/api/auth/demo-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Demo login failed');
    setDemoMode(true);
    persistToken(data.token);
    setUser(data.user);
  };

  const logout = async () => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    clearInMemoryGoogleToken();
    setGoogleAccessToken(null);
    setToken(null);
    setUser(null);
    setProfile(null);
    setContacts([]);
    setIncidents([]);
    setOperatorIncidents([]);
    setNotifications([]);
    await signOutFirebase().catch(() => {});
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        preferences,
        token,
        googleAccessToken,
        loading,
        demoMode,
        setDemoMode,
        contacts,
        incidents,
        operatorIncidents,
        notifications,
        mapsApiKey,
        realtimeConnected,
        apiFetch,
        loginWithEmail,
        registerWithEmail,
        loginWithGoogle,
        connectWorkspaceOAuth,
        loginDemoRole,
        logout,
        refreshAllData,
        setUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
