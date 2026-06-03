'use client';

import { useEffect } from 'react';
import { Container, Paper, Skeleton, Stack } from '@mantine/core';
import { TimesheetProvider, useTimesheet } from '@/components/timesheet/TimesheetContext';
import { BiWeeklyTable } from '@/components/timesheet/BiWeeklyTable';
import { DailyNoteModal } from '@/components/timesheet/DailyNoteModal';
import { PayPeriodSelector } from '@/components/timesheet/PayPeriodSelector';
import { TimesheetToolbar } from '@/components/timesheet/TimesheetToolbar';
import type { TimesheetPageData } from '@/types/timesheet';
import { seedOfflineStore } from '@/lib/offline/offline-store';
import { startSyncService, stopSyncService } from '@/lib/offline/sync-service';
import { TimesheetDashboard } from '@/components/timesheet/TimesheetDashboard';

function TimesheetContent() {
  const { state } = useTimesheet();

  return (
    <Container fluid px="md" py="xl">
      <PayPeriodSelector />
      <TimesheetToolbar />
      <Paper shadow="xs" p="md" radius="md" style={{ overflowX: 'auto' }}>
        {state.isLoadingPeriod ? (
          <Stack gap="sm">
            <Skeleton height={40} radius="sm" />
            <Skeleton height={36} radius="sm" />
            <Skeleton height={36} radius="sm" />
            <Skeleton height={36} radius="sm" />
            <Skeleton height={36} radius="sm" />
            <Skeleton height={36} radius="sm" />
            <Skeleton height={40} radius="sm" />
          </Stack>
        ) : (
          <BiWeeklyTable />
        )}
      </Paper>
      <DailyNoteModal />
    </Container>
  );
}

type Props = {
  initialData: TimesheetPageData;
};

export function BiWeeklyTimesheetClient({ initialData }: Props) {
  useEffect(() => {
    // Seed offline store with server-provided data
    // Wrapped in try/catch — IndexedDB corruption or unavailability must not crash the app
    try {
      seedOfflineStore({
        userId: initialData.userId,
        periodStart: initialData.periodStart,
        chargeCodes: initialData.chargeCodes,
        entries: initialData.entries,
        revisions: initialData.revisions ?? {},
        periodStatus: initialData.periodStatus ?? 'draft',
      }).catch(() => {
        // Async IndexedDB errors — silently ignore, app works without offline support
      });
    } catch {
      // Synchronous errors — silently ignore
    }

    // Start background sync — also wrapped to prevent IndexedDB crashes
    try {
      startSyncService(initialData.userId);
    } catch {
      // Sync service unavailable — app continues without background sync
    }

    return () => {
      try {
        stopSyncService();
      } catch {
        // Cleanup error — ignore
      }
    };
  }, [initialData.userId]);

  return (
    <>
      {initialData.dashboardData && (
        <Container fluid px="md" pt="xl">
          <TimesheetDashboard data={initialData.dashboardData} />
        </Container>
      )}
      <TimesheetProvider initialData={initialData}>
        <TimesheetContent />
      </TimesheetProvider>
    </>
  );
}
