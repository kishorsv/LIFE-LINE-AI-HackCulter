import React, { useState } from 'react';
import { AlertTriangle, Building2, FlaskConical, KeyRound, MailCheck, Shield, ShieldCheck, User, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.tsx';
import { formatGoogleAuthError, FormattedGoogleAuthError } from '../lib/firebaseAuthErrors.ts';
import { UserRole } from '../types/lifeline.ts';

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  onAuthenticated: () => void;
}

export function AuthModal({ open, onClose, onAuthenticated }: AuthModalProps) {
  const {
    loginWithEmail,
    registerWithEmail,
    loginWithGoogle,
    loginDemoRole,
    demoSandboxEnabled,
    apiFetch,
    refreshAllData,
  } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup' | 'forgot' | 'verify'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [codePreview, setCodePreview] = useState('');
  const [resetEmail, setResetEmail] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState('');
  const [googleError, setGoogleError] = useState<FormattedGoogleAuthError | null>(null);
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await loginWithEmail(email, password);
      onAuthenticated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await registerWithEmail({ email, password, displayName });
      if (res.verificationCodePreview) {
        setCodePreview(res.verificationCodePreview);
      }
      setMode('verify');
      setInfo('Account created! Verify your email using the 6-digit code below (expires in 15 minutes).');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign up failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await apiFetch('/api/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ code: verificationCode }),
      });
      await refreshAllData();
      onAuthenticated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleResendVerification = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch<{ message?: string; verificationCodePreview?: string }>('/api/auth/resend-verification', {
        method: 'POST',
      });
      if (res.verificationCodePreview) setCodePreview(res.verificationCodePreview);
      setInfo(res.message || 'New verification code sent.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to resend code.');
    } finally {
      setBusy(false);
    }
  };

  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!resetCode) {
        const res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: resetEmail }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not request reset code.');
        setInfo(data.message || 'Reset code requested.');
        if (data.resetCodePreview) setCodePreview(data.resetCodePreview);
      } else {
        const res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: resetEmail, code: resetCode, newPassword }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Reset failed.');
        setInfo('Password updated. You can sign in now.');
        setMode('login');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset error.');
    } finally {
      setBusy(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setBusy(true);
    setError('');
    setGoogleError(null);
    try {
      await loginWithGoogle();
      onAuthenticated();
      onClose();
    } catch (err) {
      const formatted = formatGoogleAuthError(err, { mode: 'login' });
      setGoogleError(formatted);
    } finally {
      setBusy(false);
    }
  };

  const handleDemo = async (demoRole: UserRole) => {
    setBusy(true);
    setError('');
    try {
      await loginDemoRole(demoRole);
      onAuthenticated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Demo login failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-2xl border border-slate-200 dark:border-violet-500/30 bg-white dark:bg-[#0B1022] p-6 shadow-2xl my-8">
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-600 text-white">
              <Shield className="h-5 w-5" />
            </span>
            <div>
              <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white">Access LIFE-LINE AI</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">Role-protected safety platform & hackathon sandbox</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close authentication modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 grid gap-6 md:grid-cols-2">
          {/* Left Column: Real Auth */}
          <div>
            <div className="flex gap-1 rounded-xl bg-slate-100 dark:bg-slate-900 p-1 mb-4">
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setError('');
                }}
                className={`flex-1 rounded-lg py-1.5 text-xs font-semibold ${
                  mode === 'login' ? 'bg-white dark:bg-violet-600 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('signup');
                  setError('');
                }}
                className={`flex-1 rounded-lg py-1.5 text-xs font-semibold ${
                  mode === 'signup' ? 'bg-white dark:bg-violet-600 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                Create Account
              </button>
            </div>

            {error && (
              <div className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
                {error}
              </div>
            )}
            {info && (
              <div className="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
                {info}
              </div>
            )}

            {mode === 'login' && (
              <form onSubmit={handleLogin} className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Email</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-violet-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Password</label>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-violet-500 focus:outline-none"
                  />
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      setMode('forgot');
                      setCodePreview('');
                      setError('');
                    }}
                    className="text-xs font-medium text-violet-600 dark:text-violet-400 hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
                <button
                  type="submit"
                  disabled={busy}
                  className="w-full rounded-xl bg-violet-600 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-60"
                >
                  {busy ? 'Signing in...' : 'Sign In with Email'}
                </button>
              </form>
            )}

            {mode === 'signup' && (
              <form onSubmit={handleSignup} className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Full Name</label>
                  <input
                    type="text"
                    required
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Aanya Sharma"
                    className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-violet-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Email</label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-violet-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Password (8+ chars)</label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-violet-500 focus:outline-none"
                  />
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 px-3 py-2 text-[11px] text-slate-600 dark:text-slate-300">
                  <strong>Account Role:</strong> Regular User (Personal Safety). Emergency Operator, Support Organization,
                  and Administrator roles are assigned strictly by an Administrator.
                </div>
                <button
                  type="submit"
                  disabled={busy}
                  className="w-full rounded-xl bg-violet-600 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-60"
                >
                  {busy ? 'Creating account...' : 'Create Secure Account'}
                </button>
              </form>
            )}

            {mode === 'verify' && (
              <form onSubmit={handleVerify} className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-white">
                  <MailCheck className="h-4 w-4 text-violet-500" />
                  <span>Email Verification</span>
                </div>
                {codePreview && (
                  <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    Local Verification Code: <strong className="font-mono">{codePreview}</strong>
                  </p>
                )}
                <input
                  type="text"
                  required
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value)}
                  placeholder="Enter 6-digit code"
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm font-mono text-slate-900 dark:text-white"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={busy}
                    className="flex-1 rounded-xl bg-violet-600 py-2 text-sm font-semibold text-white hover:bg-violet-500"
                  >
                    Verify Email
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleResendVerification}
                    className="rounded-xl border border-violet-500/40 px-3 py-2 text-xs font-semibold text-violet-600 dark:text-violet-300"
                  >
                    Resend
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onAuthenticated();
                      onClose();
                    }}
                    className="rounded-xl border border-slate-300 dark:border-slate-700 px-3 py-2 text-xs text-slate-600 dark:text-slate-300"
                  >
                    Later
                  </button>
                </div>
              </form>
            )}

            {mode === 'forgot' && (
              <form onSubmit={handleForgotSubmit} className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-white">
                  <KeyRound className="h-4 w-4 text-violet-500" />
                  <span>Reset Password</span>
                </div>
                <input
                  type="email"
                  required
                  value={resetEmail}
                  onChange={(e) => setResetEmail(e.target.value)}
                  placeholder="Account email"
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm text-slate-900 dark:text-white"
                />
                {codePreview && (
                  <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                    Reset Code: <strong className="font-mono">{codePreview}</strong>
                  </p>
                )}
                {info && (
                  <>
                    <input
                      type="text"
                      value={resetCode}
                      onChange={(e) => setResetCode(e.target.value)}
                      placeholder="6-digit reset code"
                      className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm font-mono text-slate-900 dark:text-white"
                    />
                    <input
                      type="password"
                      minLength={8}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="New password (8+ chars)"
                      className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 px-3 py-2 text-sm text-slate-900 dark:text-white"
                    />
                  </>
                )}
                <button
                  type="submit"
                  disabled={busy}
                  className="w-full rounded-xl bg-violet-600 py-2 text-sm font-semibold text-white hover:bg-violet-500"
                >
                  {resetCode ? 'Update Password' : 'Send Reset Code'}
                </button>
              </form>
            )}

            {/* Official Google Sign-In Button (uses basic OpenID scopes; Workspace scopes are requested explicitly in Dashboard) */}
            <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800">
              {googleError && (
                <div
                  role="alert"
                  className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200"
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p className="font-semibold">{googleError.title}</p>
                      <p className="leading-relaxed opacity-95">{googleError.message}</p>
                      <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300 leading-relaxed">
                        {googleError.recoveryHint}
                      </p>
                    </div>
                  </div>
                </div>
              )}
              <button type="button" onClick={handleGoogleSignIn} disabled={busy} className="gsi-material-button">
                <div className="gsi-material-button-state" />
                <div className="gsi-material-button-content-wrapper">
                  <div className="gsi-material-button-icon">
                    <svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" style={{ display: 'block' }}>
                      <path
                        fill="#EA4335"
                        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                      />
                      <path
                        fill="#4285F4"
                        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                      />
                      <path
                        fill="#34A853"
                        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                      />
                      <path fill="none" d="M0 0h48v48H0z" />
                    </svg>
                  </div>
                  <span className="gsi-material-button-contents">Sign in with Google</span>
                </div>
              </button>
              <p className="mt-1.5 text-[11px] text-center text-slate-500 dark:text-slate-400">
                Uses basic profile &amp; email. Optional Google Workspace scopes connect inside Dashboard.
              </p>
            </div>
          </div>

          {/* Right Column: Hackathon Demo Sandbox */}
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 text-amber-600 dark:text-amber-300 font-semibold text-sm">
                <FlaskConical className="h-4 w-4" />
                <span>Hackathon Demonstration Sandbox</span>
              </div>
              {!demoSandboxEnabled ? (
                <p className="mt-2 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                  One-click demo sandbox login is disabled in production mode. Sign in with your verified credentials
                  or Google Workspace account.
                </p>
              ) : (
                <>
                  <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                    Judges can inspect every RBAC persona with one click. Actions inside demo accounts are explicitly tagged as{' '}
                    <strong className="font-mono">[SIMULATED]</strong> and separated from live metrics.
                  </p>

                  <div className="mt-4 space-y-2.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleDemo('regular_user')}
                      className="w-full flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700/80 bg-white dark:bg-slate-900/70 p-3 text-left hover:border-violet-500/50 transition-colors"
                    >
                      <User className="h-5 w-5 text-violet-500 shrink-0" />
                      <div>
                        <div className="text-sm font-semibold text-slate-900 dark:text-white">Maya Lin · Regular User</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">Trigger SOS, manage contacts, talk to AI agents</div>
                      </div>
                    </button>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleDemo('emergency_operator')}
                      className="w-full flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700/80 bg-white dark:bg-slate-900/70 p-3 text-left hover:border-violet-500/50 transition-colors"
                    >
                      <ShieldCheck className="h-5 w-5 text-rose-500 shrink-0" />
                      <div>
                        <div className="text-sm font-semibold text-slate-900 dark:text-white">Elena Vance · Emergency Operator</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">Live SOS queue, map pins, acknowledge & resolve</div>
                      </div>
                    </button>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleDemo('support_organization')}
                      className="w-full flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700/80 bg-white dark:bg-slate-900/70 p-3 text-left hover:border-violet-500/50 transition-colors"
                    >
                      <Building2 className="h-5 w-5 text-emerald-500 shrink-0" />
                      <div>
                        <div className="text-sm font-semibold text-slate-900 dark:text-white">Safe Haven · Support Organization</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">Responder coordination & shelter intake updates</div>
                      </div>
                    </button>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleDemo('administrator')}
                      className="w-full flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700/80 bg-white dark:bg-slate-900/70 p-3 text-left hover:border-violet-500/50 transition-colors"
                    >
                      <Shield className="h-5 w-5 text-amber-500 shrink-0" />
                      <div>
                        <div className="text-sm font-semibold text-slate-900 dark:text-white">System Governance · Admin Sandbox</div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">Audit trails, analytics & role governance</div>
                      </div>
                    </button>
                  </div>
                </>
              )}
            </div>

            {demoSandboxEnabled && (
              <p className="mt-4 text-[11px] text-slate-500 dark:text-slate-400">
                Demo credentials: <span className="font-mono">*.demo@lifeline-ai.demo</span> · <span className="font-mono">LifelineDemo2026!</span>
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
