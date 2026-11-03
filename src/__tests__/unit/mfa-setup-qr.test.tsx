// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

/**
 * feature-plan-hotfix-mfa-qr.md §3: the 2FA QR code is drawn in the browser (qrcode's toDataURL) from the otpauth URI —
 * a data:image/png — and no element's src or href carries the TOTP secret, so it is never sent anywhere. While drawing:
 * "Generating QR code…"; if drawing fails: the fallback text, and the manual key stays. The key shows in groups of 4 and
 * "Copy key" copies the raw key.
 */

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/CadenzPoint:jane%40example.com?secret=${SECRET}&issuer=CadenzPoint`;
const h = vi.hoisted(() => ({ toDataURL: vi.fn() }));
vi.mock('qrcode', () => ({ default: { toDataURL: h.toDataURL }, toDataURL: h.toDataURL }));
vi.mock('@/server/actions/mfa', () => ({
  initMFASetup: vi.fn(async () => ({ ok: true, data: { secret: SECRET, uri: URI } })),
  completeMFASetup: vi.fn(),
  disableMFA: vi.fn(),
}));
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }));

import { MFASetup } from '@/app/(app)/profile/MFASetup';
import { buttonByText, click, installDomStubs, mount, unmount, wait, type Mounted } from '../helpers/dom';

beforeAll(installDomStubs);
let m: Mounted | undefined;
// A block body: a function RETURNED from beforeEach is a cleanup hook (vitest would call the mock after each test).
beforeEach(() => { h.toDataURL.mockReset(); });
afterEach(() => { unmount(m); m = undefined; vi.unstubAllGlobals(); });

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
/** Mount, press "Enable 2FA" and reach the scan state. */
async function scanState() {
  m = await mount(<MFASetup mfaEnabled={false} recoveryCodesRemaining={0} />);
  await click(buttonByText('Enable 2FA'));
  await wait(20);
}
const qrBox = () => document.querySelector('[data-testid="mfa-qr"]') as HTMLElement;
const leaks = () => [...document.querySelectorAll('[src], [href]')]
  .map((el) => `${el.getAttribute('src') ?? ''} ${el.getAttribute('href') ?? ''}`)
  .filter((v) => v.includes(SECRET) || v.includes(encodeURIComponent(SECRET)));

describe('2FA setup QR code is drawn locally (hotfix)', () => {
  it('toDataURL gets the otpauth URI; the img is a data:image/png; no src or href carries the secret', async () => {
    h.toDataURL.mockResolvedValue(PNG);
    await scanState();
    expect(h.toDataURL).toHaveBeenCalledWith(URI, expect.objectContaining({ width: 200, margin: 1, errorCorrectionLevel: 'M' }));
    const img = qrBox().querySelector('img')!;
    expect(img.getAttribute('src')!.startsWith('data:image/png')).toBe(true);
    expect(img.getAttribute('alt')).toBe('QR code for your authenticator app');
    expect([...document.querySelectorAll('img')].every((i) => (i.getAttribute('src') ?? '').startsWith('data:'))).toBe(true);
    expect(leaks()).toEqual([]);
  });

  it('while drawing: a loader with "Generating QR code…" and no image; the manual key is already there', async () => {
    let finish!: (url: string) => void;
    h.toDataURL.mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));
    await scanState();
    expect(qrBox().textContent).toContain('Generating QR code…');
    expect(qrBox().querySelector('img')).toBeNull();
    expect(document.querySelector('[data-testid="mfa-setup-key"]')!.textContent).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    // Then the drawing lands and replaces the loader.
    finish(PNG);
    await wait(20);
    expect(qrBox().querySelector('img')!.getAttribute('src')).toBe(PNG);
  });

  it('a drawing failure shows the fallback text, no image, and the manual key (grouped by 4); no src or href carries the secret', async () => {
    h.toDataURL.mockRejectedValue(new Error('canvas unavailable'));
    await scanState();
    expect(qrBox().textContent).toContain("Couldn't draw the QR code. Enter the key below in your authenticator app instead.");
    expect(qrBox().querySelector('img')).toBeNull();
    expect(document.querySelector('[data-testid="mfa-setup-key"]')!.textContent).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    expect(leaks()).toEqual([]);
  });

  it('"Copy key" copies the raw key (no spaces)', async () => {
    h.toDataURL.mockResolvedValue(PNG);
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await scanState();
    await click(buttonByText('Copy key'));
    expect(writeText).toHaveBeenCalledWith(SECRET);
  });
});
