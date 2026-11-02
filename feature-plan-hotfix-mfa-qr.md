# Hotfix: 2FA setup must never send the TOTP secret off-site

> **Status:** FINAL, 2026-10-29, lead architect. A small, self-contained security fix ahead of UX-4.
>
> **Branch:** `hotfix-mfa-qr`, cut from `main`.

## 1. Problem (verified)
- **The leak:**
  - `src/app/(app)/profile/MFASetup.tsx:87-89` builds the QR code as `<img src="https://api.qrserver.com/v1/create-qr-code/?…&data={otpauth URI}">`.
  - The otpauth URI contains the user's **TOTP shared secret**, so every 2FA enrolment sends it to a third party in an HTTP request (it can land in their logs).
  - The comment beside it ("Google Charts API (no external dependency)") is wrong on both counts.
- **Why nothing blocked it:** the CSP allows `img-src 'self' data: blob:`, but it ships in **report-only** mode by default (`next.config.ts:30-32`), so the request goes through.
- **The fix is already a dependency:** `qrcode@^1.5.4` and `@types/qrcode` are in `package.json` and currently unused.

## 2. Fix
1. **Render the QR code locally, in the browser.** The secret is already on the client to show the manual-entry key.
   ```ts
   import QRCode from 'qrcode';
   const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
   useEffect(() => {
     if (!qrUri) { setQrDataUrl(null); return; }
     let cancelled = false;
     QRCode.toDataURL(qrUri, { width: 200, margin: 1, errorCorrectionLevel: 'M' })
       .then((url) => { if (!cancelled) setQrDataUrl(url); })
       .catch(() => { if (!cancelled) setQrDataUrl(null); });
     return () => { cancelled = true; };
   }, [qrUri]);
   ```
   - Render `<img src={qrDataUrl} alt="QR code for your authenticator app" width={200} height={200} />` only when `qrDataUrl` is set.
   - Otherwise show a `Loader` with the visible text "Generating QR code…".
   - If generation fails, show "Couldn't draw the QR code. Enter the key below in your authenticator app instead." The manual key stays visible either way.
2. **Delete the `qrImageUrl` constant and its wrong comment.**
3. **Make the setup key easy to use:** keep the manual key, and add a Mantine `CopyButton` labelled "Copy key". Show it in groups of 4 characters for readability; copy the raw key.

## 3. Guards (tests)
- **`unit/no-external-images.test.ts` (static):** scan `src/**/*.{ts,tsx}` (excluding `__tests__`) for:
  - `api.qrserver.com`;
  - `chart.googleapis.com`;
  - any `src={\`https://` or `src="https://` on an `img`/`Image`.

  None may occur. **Revert check:** put the old URL back, and the test must fail.
- **`unit/mfa-setup-qr.test.tsx`:**
  - mock `qrcode`'s `toDataURL`;
  - render MFASetup in the "scan" state with a known otpauth URI;
  - assert `toDataURL` was called with that URI and the `img` `src` starts with `data:image/png`;
  - assert no element's `src` or `href` contains the secret;
  - assert a failure shows the fallback text and the manual key.

  **Revert check:** using the external URL must fail it.

## 4. Blast radius
- **Changes:** `MFASetup.tsx` only, plus the two new tests. No server change, no schema change, and the TOTP verification is untouched.
- **Existing enrolments:**
  - Any secret enrolled through this page has been seen by api.qrserver.com.
  - CadenzPoint has no production users yet (deploy pending), so no rotation is required.
  - **If any real user has enrolled 2FA** on a deployed environment, they must disable and re-enable 2FA after this ships (product owner to confirm).

## 5. Verification
- Dev: `npx tsc --noEmit && npm run lint && npm run test && npm run test:tz`.
- **Product owner browser check:**
  1. Profile → enable 2FA, with DevTools → Network open.
  2. Confirm **no request goes to any external host**, and the QR code is a `data:` image.
  3. Scan it with an authenticator app, then enter the code: 2FA turns on.
  4. Sign out and back in with a code.

## 6. Hand-off rules
- One commit. Don't push. Don't change TOTP logic, the CSP or any other page.
- Report: the commit, gates, and both revert checks.

---

## 7. Addendum (2026-11-02): 2FA sign-in never reaches the code step (HIGH)

**Found:** in the product owner's §5 browser check. After enabling 2FA, signing in with email and password shows "Invalid code. Please try again." and never shows the code field. Typing the code into the password field then gives "Invalid email or password". **Every account with 2FA is locked out of the app,** and each attempt counts toward the 5-failure, 15-minute lockout (`server/internal/login-attempts.ts:8-9`).

**Root cause (verified):**
- `LoginForm.tsx:70-75` calls `signIn('credentials', { …, mfaCode: mfaRequired ? … : undefined })`.
- next-auth/react builds the POST body with `new URLSearchParams({ ...signInParams })` (`node_modules/next-auth/react.js:159-160`), and `URLSearchParams` turns `undefined` into the **string `"undefined"`**: `node -e "new URLSearchParams({mfaCode: undefined}).toString()"` gives `mfaCode=undefined`.
- `authorizeCredentials` (`src/auth.ts:36, 70`) receives `mfaCode = "undefined"`, which is non-empty, so it skips `MFARequiredSignin` and verifies "undefined" as a code. That gives `MFAInvalidSignin` → "Invalid code", while `mfaRequired` stays false, so the code field never appears.
- **Why the tests missed it:** the unit tests mock `signIn` and never inspect the body, and the integration tests call `authorizeCredentials` directly with a real `undefined`. This has been present since `89bda1d` (P0 security hardening).

**Fix (two layers):**
1. **Client** (`LoginForm.tsx`): send the `mfaCode` key **only** when a code is being submitted:
   ```ts
   const code = mfaRequired ? (useRecoveryCode ? recoveryCode.trim() : mfaCode.trim()) : '';
   const result = await signIn('credentials', {
     email: email.toLowerCase().trim(),
     password,
     ...(mfaRequired ? { mfaCode: code } : {}),
     redirect: false,
   });
   ```
2. **Server** (`authorizeCredentials`, defence in depth, so any client or form serialiser behaves): treat a missing, blank or non-string `mfaCode`, or the literal strings `"undefined"` / `"null"`, as **no code submitted**, which throws `MFARequiredSignin` and **records no failed attempt**:
   ```ts
   const rawMfa = credentials.mfaCode;
   const mfaCode = typeof rawMfa === 'string' && !['', 'undefined', 'null'].includes(rawMfa.trim()) ? rawMfa.trim() : undefined;
   ```
   Add a one-line comment saying why (URLSearchParams serialises `undefined`).

**Explicitly unchanged:**
- TOTP verification, replay protection (`totpLastUsedStep`), recovery codes, and the lockout counts for genuinely wrong codes or passwords.
- The two-step design itself: password first, then the code field appears in place. That's the standard pattern and matches the product owner's expectation once it works.
- A "Use a different account" option at the code step is UX-4b (the auth card), not this hotfix.

**Tests (each must fail without its fix):**
- **`unit/login-form.test.tsx`:**
  - "first submit for a 2FA account sends no `mfaCode` key": assert the `signIn` mock's second argument has no `mfaCode` property.
  - "after `mfa_required`, the code field appears and the second submit sends `mfaCode: '123456'`".
  - "`mfa_invalid` on the code step keeps the code field and shows 'Invalid code'".
- **`integration/mfa-signin.test.ts`:**
  - "`mfaCode: 'undefined'` / `''` / `'null'` → `mfa_required`, and no failed attempt is recorded" (lockout count unchanged);
  - "a valid TOTP still signs in; `'000000'` is still `mfa_invalid` and still counts".
- **Optional, recommended:** a unit test that builds the body exactly as next-auth does (`new URLSearchParams({ ...params })`) from the form's first-step params and asserts it has no `mfaCode=`.

**Verification (product owner):**
1. Sign in as the admin with 2FA on. Email and password are accepted, then the "Enter the 6-digit code" field appears. Enter the authenticator code, and you're signed in.
2. A wrong code shows "Invalid code" and keeps the code field.
3. A recovery code works once.
4. If the account is currently locked from earlier attempts, wait 15 minutes first; the lockout clears itself.

**Hand-off:** this goes in **a second commit on `hotfix-mfa-qr`**, so the PR ships both fixes together. Don't push.
