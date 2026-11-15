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
  signInWithGoogleBasic,
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
  demoSandboxEnabled: boolean;
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
const CONTACTS_SNAPSHOT_PREFIX = 'lifeline_contacts_snapshot_';

function clearUserOfflineSnapshots() {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(CONTACTS_SNAPSHOT_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    // ignore storage access issues
  }
  if (typeof caches !== 'undefined') {
    caches.delete('emergency-api-cache').catch(() => {});
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [profile, setProfile] = useState<UserProfileData | null>(null);
  const [preferences, setPreferences] = useState<UserPreferencesData | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_STORAGE_KEY));
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [demoMode, setDemoMode] = useState<boolean>(() => localStorage.getItem('lifeline_demo_mode') === 'true');
  const [demoSandboxEnabled, setDemoSandboxEnabled] = useState<boolean>(true);
  const [contacts, setContacts] = useState<TrustedContact[]>([]);
  const [incidents, setIncidents] = useState<EmergencyIncident[]>([]);
  const [operatorIncidents, setOperatorIncidents] = useState<EmergencyIncident[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [mapsApiKey, setMapsApiKey] = useState<string>(() => import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '');
  const [realtimeConnected, setRealtimeConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const lastEventSeqRef = useRef<number>(0);

  useEffect(() => {
    localStorage.setItem('lifeline_demo_mode', String(demoMode));
  }, [demoMode]);

  // Load public non-secret configuration (Maps client key fallback & demo sandbox availability)
  useEffect(() => {
    fetch('/api/config/public')
      .then((r) => r.json())
      .then((data: { mapsApiKey?: string; demoSandboxEnabled?: boolean }) => {
        if (!mapsApiKey && data.mapsApiKey) setMapsApiKey(data.mapsApiKey);
        if (typeof data.demoSandboxEnabled === 'boolean') {
          setDemoSandboxEnabled(data.demoSandboxEnabled);
        }
      })
      .catch(() => {});
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

      // Save user-scoped offline contact snapshot strictly under the active user's UID
      try {
        localStorage.setItem(`${CONTACTS_SNAPSHOT_PREFIX}${me.user.uid}`, JSON.stringify(cRes.contacts));
      } catch {
        // ignore quota errors
      }

      if (['emergency_operator', 'support_organization', 'administrator'].includes(me.user.role)) {
        const opRes = await apiFetch<{ incidents: EmergencyIncident[] }>('/api/operator/incidents');
        setOperatorIncidents(opRes.incidents);
      } else {
        setOperatorIncidents([]);
      }
    } catch {
      // Do not clear session if we are merely offline; restore user-scoped snapshot only if token is still valid later
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        return;
      }
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

  // Real-time WebSocket connection with heartbeat, exponential-backoff reconnect & missed-event recovery
  useEffect(() => {
    if (!token || !user) {
      wsRef.current?.close();
      wsRef.current = null;
      setRealtimeConnected(false);
      return;
    }

    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let attempt = 0;
    let hasConnectedOnce = false;

    const connectSocket = () => {
      if (disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const sinceParam = lastEventSeqRef.current > 0 ? `&since=${lastEventSeqRef.current}` : '';
      const ws = new WebSocket(
        `${proto}//${window.location.host}/ws/realtime?token=${encodeURIComponent(token)}${sinceParam}`
      );
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) {
          ws.close();
          return;
        }
        const reconnecting = hasConnectedOnce;
        hasConnectedOnce = true;
        attempt = 0;
        setRealtimeConnected(true);

        if (reconnecting) {
          void refreshAllData();
        }

        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 20_000);
      };

      ws.onclose = (ev) => {
        setRealtimeConnected(false);
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        // Do not retry if server closed due to failed authentication (1008)
        if (disposed || ev.code === 1008) return;
        const backoffMs = Math.min(30_000, 1000 * Math.pow(2, attempt));
        attempt += 1;
        reconnectTimer = setTimeout(connectSocket, backoffMs);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as {
            type?: string;
            seq?: number;
            latestSeq?: number;
            incident?: EmergencyIncident;
          };
          if (typeof msg.seq === 'number' && msg.seq > lastEventSeqRef.current) {
            lastEventSeqRef.current = msg.seq;
          }
          if (typeof msg.latestSeq === 'number' && msg.latestSeq > lastEventSeqRef.current) {
            lastEventSeqRef.current = msg.latestSeq;
          }
          if (msg.type === 'pong') return;

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
    };

    connectSocket();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (pingTimer) clearInterval(pingTimer);
      wsRef.current?.close();
    };
  }, [token, user, apiFetch, refreshAllData]);

  const persistToken = (newToken: string) => {
    lastEventSeqRef.current = 0;
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
  }) => {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        displayName: input.displayName,
        role: 'regular_user',
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    persistToken(data.token);
    setUser(data.user);
    return { verificationCodePreview: data.verificationCodePreview };
  };

  const loginWithGoogle = async () => {
    const result = await signInWithGoogleBasic();
    const res = await fetch('/api/auth/firebase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: result.idToken }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      token?: string;
      user?: AppUser;
      error?: string;
    };
    if (!res.ok || !data.token || !data.user) {
      await signOutFirebase().catch(() => {});
      throw new Error(data.error || 'Server verification of Google session failed.');
    }
    persistToken(data.token);
    setUser(data.user);
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
    lastEventSeqRef.current = 0;
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    clearUserOfflineSnapshots();
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
        demoSandboxEnabled,
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
