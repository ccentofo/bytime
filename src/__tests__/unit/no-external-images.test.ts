import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * feature-plan-hotfix-mfa-qr.md §3: nothing in the app may load an image from a third-party host. The 2FA QR code used
 * to be an <img> from api.qrserver.com whose URL carried the TOTP shared secret, so every enrolment sent the secret off
 * site (the CSP ships report-only, so it didn't block it). Static scan of src/**\/*.{ts,tsx}, tests excluded.
 */

const SRC = path.resolve(__dirname, '../..');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const full = path.join(dir, n);
  if (n === '__tests__' || n === 'node_modules') return [];
  return statSync(full).isDirectory() ? walk(full) : [full];
});

const QR_SERVICES = /api\.qrserver\.com|chart\.googleapis\.com/;
/** An <img> or <Image> whose src is an absolute https URL (a literal or a template literal). */
const EXTERNAL_IMG_SRC = /<(img|Image)\b[^>]*?\bsrc=(?:"https:\/\/|'https:\/\/|\{\s*`https:\/\/|\{\s*["']https:\/\/)/;

function offenders(files: { file: string; src: string }[]): string[] {
  return files.flatMap(({ file, src }) => [
    ...(QR_SERVICES.test(src) ? [`${file}: a QR-code service URL`] : []),
    ...(EXTERNAL_IMG_SRC.test(src) ? [`${file}: an <img>/<Image> with an external https src`] : []),
  ]);
}

describe('no external images (hotfix: 2FA QR code)', () => {
  it('no QR-code service and no img/Image with an https:// src anywhere in src/', () => {
    const files = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f));
    expect(files.length).toBeGreaterThan(100);
    expect(offenders(files.map((f) => ({ file: path.relative(SRC, f), src: readFileSync(f, 'utf8') })))).toEqual([]);
  });

  it('the scan catches each shape', () => {
    const one = (src: string) => offenders([{ file: 'x.tsx', src }]);
    expect(one('const u = `https://api.qrserver.com/v1/create-qr-code/?data=${x}`;')).toHaveLength(1);
    expect(one('const u = "https://chart.googleapis.com/chart?cht=qr";')).toHaveLength(1);
    expect(one('<img src="https://example.com/a.png" alt="" />')).toHaveLength(1);
    expect(one('<Image src={`https://cdn.example.com/${id}.png`} alt="" />')).toHaveLength(1);
    expect(one('<img alt="" width={2} src={"https://example.com/a.png"} />')).toHaveLength(1);
    expect(one('<img src={qrDataUrl} alt="QR" />')).toEqual([]);
    expect(one('<img src="/logo.svg" alt="" />')).toEqual([]);
  });
});
