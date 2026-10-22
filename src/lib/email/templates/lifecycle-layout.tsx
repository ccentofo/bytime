import type { ReactNode } from 'react';
import { Html, Head, Body, Container, Text, Button, Hr, Section } from '@react-email/components';

/** Shared layout for workspace lifecycle notices (trial, billing, deletion). Every notice states its dates. */
export function LifecycleLayout({ title, titleColor, cta, children }: {
  title: string;
  titleColor?: string;
  cta?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: 'system-ui, sans-serif', backgroundColor: '#f9fafb', padding: '20px' }}>
        <Container style={{ maxWidth: '480px', margin: '0 auto', backgroundColor: '#ffffff', borderRadius: '8px', padding: '32px', border: '1px solid #e5e7eb' }}>
          <Text style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '16px', color: titleColor ?? '#111827' }}>{title}</Text>
          {children}
          {cta && (
            <Section style={{ textAlign: 'center', margin: '24px 0' }}>
              <Button
                href={cta.href}
                style={{ backgroundColor: '#228be6', color: '#ffffff', padding: '12px 24px', borderRadius: '6px', textDecoration: 'none', fontSize: '14px', fontWeight: 'bold' }}
              >
                {cta.label}
              </Button>
            </Section>
          )}
          <Hr style={{ borderColor: '#e5e7eb', margin: '24px 0' }} />
          <Text style={{ fontSize: '11px', color: '#9ca3af' }}>CadenzPoint — DCAA-Compliant Timekeeping</Text>
        </Container>
      </Body>
    </Html>
  );
}

export const paragraph = { fontSize: '14px', color: '#374151', lineHeight: '1.6' } as const;
export const smallPrint = { fontSize: '12px', color: '#6b7280', lineHeight: '1.6' } as const;
