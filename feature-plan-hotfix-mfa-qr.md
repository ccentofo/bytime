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
