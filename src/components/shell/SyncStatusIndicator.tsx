'use client';

import { useState, useEffect } from 'react';
import { Badge, Tooltip } from '@mantine/core';
import { IconCloud, IconCloudOff, IconRefresh, IconAlertTriangle, IconCheck } from '@tabler/icons-react';
import { onSyncStatusChange } from '@/lib/offline/sync-service';

type SyncStatus = {
  pendingCount: number;
  isSyncing: boolean;
  lastError: string | null;
  isOnline: boolean;
};

export function SyncStatusIndicator() {
  // Client-only guard: this component renders real-time network status
  // which is meaningless on the server. Rendering null on SSR prevents
  // hydration mismatches caused by navigator.onLine and Badge CSS variables.
  // DO NOT REMOVE this guard — it prevents a recurring hydration error.
  const [mounted, setMounted] = useState(false);
  const [status, setStatus] = useState<SyncStatus>({
    pendingCount: 0,
    isSyncing: false,
    lastError: null,
    isOnline: true,
  });

  useEffect(() => {
    setMounted(true);
    // Set initial online status now that we're on the client
    setStatus((s) => ({ ...s, isOnline: navigator.onLine }));
    onSyncStatusChange(setStatus);

    function handleOnline() {
      setStatus((s) => ({ ...s, isOnline: true }));
    }
    function handleOffline() {
      setStatus((s) => ({ ...s, isOnline: false }));
    }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Don't render on server — prevents hydration mismatch
  if (!mounted) return null;

  // Determine display state
  let icon = <IconCheck size={14} />;
  let color = 'green';
  let label = 'Synced';
  let tooltip = 'All data is saved to the server';

  if (!status.isOnline) {
    icon = <IconCloudOff size={14} />;
    color = 'gray';
    label = 'Offline';
    tooltip = 'You are working offline. Changes will sync when connection returns.';
  } else if (status.lastError) {
    icon = <IconAlertTriangle size={14} />;
    color = 'red';
    label = 'Sync Error';
    tooltip = status.lastError;
  } else if (status.isSyncing) {
    icon = <IconRefresh size={14} />;
    color = 'blue';
    label = 'Syncing...';
    tooltip = `Uploading ${status.pendingCount} pending entries`;
  } else if (status.pendingCount > 0) {
    icon = <IconCloud size={14} />;
    color = 'yellow';
    label = `${status.pendingCount} pending`;
    tooltip = `${status.pendingCount} entries waiting to sync`;
  }

  return (
    <Tooltip label={tooltip} withArrow>
      <Badge
        variant="light"
        color={color}
        size="sm"
        leftSection={icon}
        style={{ cursor: 'default' }}
      >
        {label}
      </Badge>
    </Tooltip>
  );
}
