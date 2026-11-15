import React from 'react';
import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus.ts';

export function OfflineIndicator({ queuedCount = 0 }: { queuedCount?: number }) {
  const isOnline = useOnlineStatus();

  if (isOnline && queuedCount === 0) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2.5 rounded-xl border border-amber-500/40 bg-amber-600 px-3.5 py-2 text-xs font-semibold text-white shadow-xl">
      <WifiOff className="h-4 w-4 shrink-0" />
      <span>
        {!isOnline
          ? 'Offline Mode — Cached SOS interface & emergency contacts active.'
          : `Reconnected — Syncing ${queuedCount} queued SOS alert(s)...`}
      </span>
    </div>
  );
}
