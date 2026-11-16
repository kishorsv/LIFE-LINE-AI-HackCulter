import { useState } from 'react';
import { ShieldAlert, CheckCircle2, X } from 'lucide-react';
import { WorkspaceConfirmPayload } from '../types/lifeline.ts';

interface Props {
  payload: WorkspaceConfirmPayload | null;
  onClose: () => void;
}

export function WorkspaceConfirmModal({ payload, onClose }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!payload) return null;

  const handleConfirm = async () => {
    setSubmitting(true);
    setError('');
    try {
      await payload.onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Workspace action failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl border border-violet-500/30 bg-white dark:bg-[#0E1428] p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-600/15 text-violet-600 dark:text-violet-400">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-display text-lg font-bold text-slate-900 dark:text-white">{payload.title}</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">Google Workspace Authorization Required</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close confirmation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-4 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">{payload.description}</p>

        <div className="mt-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 p-3.5 space-y-1.5">
          {payload.details.map((line, i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300">
              <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-violet-500" />
              <span>{line}</span>
            </div>
          ))}
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
            {error}
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-xl border border-slate-300 dark:border-slate-700 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting}
            className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-60"
          >
            {submitting ? 'Authorizing...' : 'Confirm & Execute'}
          </button>
        </div>
      </div>
    </div>
  );
}
