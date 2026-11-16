import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus.ts';

export function OfflineIndicator({
  queuedCount = 0,
  failedCount = 0,
}: {
  queuedCount?: number;
  failedCount?: number;
}) {
  const isOnline = useOnlineStatus();

  if (isOnline && queuedCount === 0 && failedCount === 0) return null;

  return (
    <div
      className={`fixed bottom-4 left-4 z-50 flex items-center gap-2.5 rounded-xl border px-3.5 py-2 text-xs font-semibold text-white shadow-xl ${
        failedCount > 0 && isOnline
          ? 'border-rose-500/50 bg-rose-600'
          : 'border-amber-500/40 bg-amber-600'
      }`}
    >
      <WifiOff className="h-4 w-4 shrink-0" />
      <span>
        {!isOnline
          ? 'Offline Mode — Cached SOS interface & user-scoped emergency queue active.'
          : failedCount > 0
          ? `${failedCount} queued SOS alert(s) failed after retries — please submit manually or call emergency services.`
          : `Reconnected — Syncing ${queuedCount} queued SOS alert(s)...`}
      </span>
    </div>
  );
}
