'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Center, Loader, Text, Stack } from '@mantine/core';
import { MFAVerifyForm } from '@/app/login/MFAVerifyForm';

function MFAPageContent() {
  const searchParams = useSearchParams();
  const userId = searchParams.get('userId') ?? '';
  const email = searchParams.get('email') ?? '';

  if (!userId || !email) {
    return (
      <Center mih="100vh">
        <Stack align="center">
          <Text c="red">Invalid MFA session. Please log in again.</Text>
        </Stack>
      </Center>
    );
  }

  return <MFAVerifyForm userId={userId} email={decodeURIComponent(email)} />;
}

export default function MFAPage() {
  return (
    <Suspense
      fallback={
        <Center mih="100vh">
          <Stack align="center" gap="md">
            <Loader size="lg" />
            <Text c="dimmed">Loading...</Text>
          </Stack>
        </Center>
      }
    >
      <MFAPageContent />
    </Suspense>
  );
}
