import { useState } from 'react';
import { AlertTriangle, Check, Copy, Mail, RefreshCw, ShieldAlert, X } from 'lucide-react';
import {
  buildAccessRequestMessage,
  buildDeveloperContactMailto,
  PersistedAuthBlockedAlert,
} from '../lib/firebaseAuthErrors.ts';

interface FirebaseAuthBlockedAlertProps {
  alert: PersistedAuthBlockedAlert;
  developerContactEmail?: string;
  variant?: 'banner' | 'inline';
  onUseEmailAuth?: () => void;
  onRetryGoogle?: () => void;
  onDismiss: () => void;
}

export function FirebaseAuthBlockedAlert({
  alert,
  developerContactEmail,
  variant = 'inline',
  onUseEmailAuth,
  onRetryGoogle,
  onDismiss,
}: FirebaseAuthBlockedAlertProps) {
  const [copied, setCopied] = useState(false);

  const handleCopyRequest = async () => {
    try {
      await navigator.clipboard.writeText(buildAccessRequestMessage(alert));
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  const contactEmail = (developerContactEmail || '').trim();
  const isBanner = variant === 'banner';

  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid={`firebase-auth-blocked-alert-${variant}`}
      className={
        isBanner
          ? 'border-b border-amber-500/35 bg-amber-50/95 dark:bg-[#161326] text-amber-950 dark:text-amber-100 shadow-sm'
          : 'rounded-xl border border-amber-500/40 bg-amber-50/90 dark:bg-amber-950/25 p-3.5 text-xs text-amber-950 dark:text-amber-100'
      }
    >
      <div className={isBanner ? 'mx-auto max-w-7xl px-4 py-3.5 sm:px-6 lg:px-8' : ''}>
        <div className="flex items-start gap-3">
          <span
            className={`mt-0.5 flex shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-amber-600 dark:text-amber-300 ${
              isBanner ? 'h-9 w-9' : 'h-7 w-7'
            }`}
          >
            {alert.testingMode ? <ShieldAlert className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          </span>

          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className={`font-semibold ${isBanner ? 'text-sm' : 'text-xs'}`}>{alert.title}</h3>
              {alert.testingMode && (
                <span className="inline-flex items-center rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-200">
                  Testing Mode
                </span>
              )}
              <span className="inline-flex items-center rounded border border-slate-300 dark:border-slate-700 bg-white/70 dark:bg-slate-900/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-700 dark:text-slate-300">
                {alert.rawCode}
              </span>
            </div>

            <p className={`${isBanner ? 'text-xs' : 'text-[11px]'} leading-relaxed opacity-95`}>{alert.message}</p>

            <p className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-200/90">
              <strong>How to proceed or contact the developer:</strong> {alert.recoveryHint}{' '}
              {contactEmail ? (
                <>
                  You can reach the developer directly at{' '}
                  <a
                    href={buildDeveloperContactMailto(contactEmail, alert)}
                    className="font-semibold underline hover:text-amber-600 dark:hover:text-amber-100"
                  >
                    {contactEmail}
                  </a>
                  .
                </>
              ) : (
                <>
                  Share the copied request details below with the application owner or repository maintainer so they can
                  whitelist your Google email under <strong>OAuth consent screen → Test users</strong>.
                </>
              )}
            </p>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              {onUseEmailAuth && (
                <button
                  type="button"
                  onClick={onUseEmailAuth}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-violet-500 transition-colors"
                >
                  Use Email &amp; Password Sign-In
                </button>
              )}

              {contactEmail && (
                <a
                  href={buildDeveloperContactMailto(contactEmail, alert)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/45 bg-white/80 dark:bg-slate-900/70 px-2.5 py-1.5 text-[11px] font-semibold text-amber-900 dark:text-amber-200 hover:bg-amber-500/15 transition-colors"
                >
                  <Mail className="h-3.5 w-3.5" />
                  <span>Contact Developer</span>
                </a>
              )}

              <button
                type="button"
                onClick={handleCopyRequest}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/35 bg-white/60 dark:bg-slate-900/50 px-2.5 py-1.5 text-[11px] font-medium text-amber-900 dark:text-amber-200 hover:bg-amber-500/15 transition-colors"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                <span>{copied ? 'Copied Details' : 'Copy Access Request'}</span>
              </button>

              {onRetryGoogle && (
                <button
                  type="button"
                  onClick={onRetryGoogle}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-800 dark:text-amber-300 hover:underline px-1.5 py-1"
                >
                  <RefreshCw className="h-3 w-3" />
                  <span>Retry</span>
                </button>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss authentication alert"
            className="rounded-lg p-1 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition-colors shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
