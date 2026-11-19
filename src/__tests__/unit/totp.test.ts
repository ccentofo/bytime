import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  generateTOTPSecret,
  verifyTOTPCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from '@/lib/totp';
import * as OTPAuth from 'otpauth';

describe('generateTOTPSecret', () => {
  it('returns a base32 secret and otpauth URI', () => {
    const result = generateTOTPSecret('test@example.com');

    expect(result.secret).toBeDefined();
    expect(result.secret.length).toBeGreaterThan(0);
    // Base32 characters only
    expect(result.secret).toMatch(/^[A-Z2-7]+=*$/);

    expect(result.uri).toBeDefined();
    expect(result.uri).toContain('otpauth://totp/');
    expect(result.uri).toContain('CadenzPoint');
    expect(result.uri).toContain('test%40example.com');
  });

  it('generates unique secrets for each call', () => {
    const result1 = generateTOTPSecret('user1@test.com');
    const result2 = generateTOTPSecret('user2@test.com');

    expect(result1.secret).not.toBe(result2.secret);
  });
});

describe('verifyTOTPCode', () => {
  it('validates a correct TOTP code', () => {
    const { secret } = generateTOTPSecret('test@example.com');

    // Generate the current valid code using the same library
    const totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(secret),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });
    const validCode = totp.generate();

    expect(verifyTOTPCode(secret, validCode)).toBe(true);
  });

  it('rejects an invalid code', () => {
    const { secret } = generateTOTPSecret('test@example.com');

    expect(verifyTOTPCode(secret, '000000')).toBe(false);
    expect(verifyTOTPCode(secret, 'abcdef')).toBe(false);
    expect(verifyTOTPCode(secret, '')).toBe(false);
  });

  it('handles malformed secret gracefully', () => {
    expect(verifyTOTPCode('not-a-valid-secret!!!', '123456')).toBe(false);
  });

  it('accepts codes with spaces (user-friendly input)', () => {
    const { secret } = generateTOTPSecret('test@example.com');
    const totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(secret),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });
    const validCode = totp.generate();

    // Add spaces — should still work
    const spacedCode = validCode.slice(0, 3) + ' ' + validCode.slice(3);
    expect(verifyTOTPCode(secret, spacedCode)).toBe(true);
  });
});

describe('generateRecoveryCodes', () => {
  it('returns exactly 10 codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
  });

  it('each code is 8 characters', () => {
    const codes = generateRecoveryCodes();
    for (const code of codes) {
      expect(code).toHaveLength(8);
    }
  });

  it('codes are uppercase alphanumeric', () => {
    const codes = generateRecoveryCodes();
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-F]+$/);
    }
  });

  it('generates unique codes', () => {
    const codes = generateRecoveryCodes();
    const unique = new Set(codes);
    expect(unique.size).toBe(10);
  });

  it('different calls produce different codes', () => {
    const codes1 = generateRecoveryCodes();
    const codes2 = generateRecoveryCodes();
    // At least some codes should differ
    const allSame = codes1.every((c, i) => c === codes2[i]);
    expect(allSame).toBe(false);
  });
});

describe('hashRecoveryCode', () => {
  it('returns a 64-character hex hash', () => {
    const hash = hashRecoveryCode('ABCD1234');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('is case-insensitive', () => {
    const hash1 = hashRecoveryCode('ABCD1234');
    const hash2 = hashRecoveryCode('abcd1234');
    expect(hash1).toBe(hash2);
  });

  it('trims whitespace', () => {
    const hash1 = hashRecoveryCode('ABCD1234');
    const hash2 = hashRecoveryCode('  ABCD1234  ');
    expect(hash1).toBe(hash2);
  });

  it('different codes produce different hashes', () => {
    const hash1 = hashRecoveryCode('ABCD1234');
    const hash2 = hashRecoveryCode('EFGH5678');
    expect(hash1).not.toBe(hash2);
  });
});

describe('verifyRecoveryCode', () => {
  it('finds a matching recovery code', () => {
    const codes = generateRecoveryCodes();
    const hashedCodes = codes.map(hashRecoveryCode);

    // Verify each code matches
    for (let i = 0; i < codes.length; i++) {
      expect(verifyRecoveryCode(codes[i], hashedCodes)).toBe(i);
    }
  });

  it('returns -1 for non-matching code', () => {
    const codes = generateRecoveryCodes();
    const hashedCodes = codes.map(hashRecoveryCode);

    expect(verifyRecoveryCode('ZZZZZZZZ', hashedCodes)).toBe(-1);
    expect(verifyRecoveryCode('', hashedCodes)).toBe(-1);
  });

  it('is case-insensitive for verification', () => {
    const codes = generateRecoveryCodes();
    const hashedCodes = codes.map(hashRecoveryCode);

    // Lowercase version should still match
    const lowerCode = codes[0].toLowerCase();
    expect(verifyRecoveryCode(lowerCode, hashedCodes)).toBe(0);
  });
});

describe('A1-G20 (SWEEP-FINDINGS.md): getTOTPStep accepts ±1 step and returns that step', () => {
  // A fixed secret and a fixed clock (mid-step), so every code below is deterministic.
  const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const NOW_MS = Date.UTC(2026, 10, 19, 12, 0, 15); // 15 s into a 30 s step
  const STEP = Math.floor(NOW_MS / 1000 / 30);
  const codeAt = (step: number) => new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(SECRET), algorithm: 'SHA1', digits: 6, period: 30 })
    .generate({ timestamp: step * 30_000 + 1_000 });

  let getTOTPStep: (secret: string, code: string) => number | null;
  beforeAll(async () => { ({ getTOTPStep } = await import('@/lib/totp')); });
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW_MS); });
  afterEach(() => { vi.useRealTimers(); });

  it('the current code → the current step; one step old → step − 1; one ahead → step + 1', () => {
    expect(getTOTPStep(SECRET, codeAt(STEP))).toBe(STEP);
    expect(getTOTPStep(SECRET, codeAt(STEP - 1))).toBe(STEP - 1);
    expect(getTOTPStep(SECRET, codeAt(STEP + 1))).toBe(STEP + 1);
  });

  it('a code two steps old (or two ahead) is rejected', () => {
    for (const s of [STEP - 2, STEP + 2, STEP - 3]) {
      if ([STEP - 1, STEP, STEP + 1].some((ok) => codeAt(ok) === codeAt(s))) continue; // a 1-in-a-million code collision
      expect(getTOTPStep(SECRET, codeAt(s)), `step offset ${s - STEP}`).toBeNull();
    }
  });

  it('spaces in the typed code are ignored; the step is the same', () => {
    const c = codeAt(STEP);
    expect(getTOTPStep(SECRET, `${c.slice(0, 3)} ${c.slice(3)}`)).toBe(STEP);
  });
});
