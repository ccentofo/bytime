import { describe, it, expect } from 'vitest';
import { getClientIp, getClientIpFromHeaders } from '@/lib/rate-limit';

/**
 * SWEEP-FINDINGS.md A1-G24: the client IP every limit keys on is the FIRST x-forwarded-for entry (the platform sets
 * it; later entries are proxies), trimmed; then x-real-ip; then 'unknown'.
 */
describe('A1-G24: the client IP', () => {
  const h = (o: Record<string, string>) => new Headers(o);

  it('the first x-forwarded-for entry, trimmed, wins over the proxies after it and over x-real-ip', () => {
    expect(getClientIpFromHeaders(h({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1, 10.0.0.2' }))).toBe('203.0.113.5');
    expect(getClientIpFromHeaders(h({ 'x-forwarded-for': '  203.0.113.6  ,10.0.0.1', 'x-real-ip': '198.51.100.1' }))).toBe('203.0.113.6');
    expect(getClientIpFromHeaders(h({ 'x-forwarded-for': '2001:db8::1, 10.0.0.1' }))).toBe('2001:db8::1');
  });

  it('then x-real-ip, then "unknown"', () => {
    expect(getClientIpFromHeaders(h({ 'x-real-ip': '198.51.100.1' }))).toBe('198.51.100.1');
    expect(getClientIpFromHeaders(h({}))).toBe('unknown');
  });

  it('getClientIp (route handlers) uses the same rule', () => {
    expect(getClientIp(new Request('https://x.test', { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } }))).toBe('203.0.113.9');
  });
});
