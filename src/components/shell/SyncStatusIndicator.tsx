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
  const [status, setStatus] = useState<SyncStatus>({
    pendingCount: 0,
    isSyncing: false,
    lastError: null,
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  });

  useEffect(() => {
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
