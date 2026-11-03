/**
 * The timesheet PDF's Content-Disposition (feature-plan-ux-page-fixes.md C15, R5): RFC 6266 with an RFC 5987 extended
 * parameter, because the employee's name may hold any character (Zoë, quotes, apostrophes):
 * `attachment; filename="<ascii>"; filename*=UTF-8''<encoded>`. The ASCII fallback replaces everything outside
 * [A-Za-z0-9._-]; the extended form percent-encodes UTF-8 plus the RFC 5987 extras ' ( ) *. CR/LF can't survive either.
 * (Not in the route file: Next only allows its own route exports there.)
 */
export function pdfContentDisposition(fullName: string, periodStart: string): string {
  const base = `timesheet-${fullName.trim().replace(/\s+/g, '-')}-${periodStart}.pdf`;
  const ascii = base.replace(/[^A-Za-z0-9._-]/g, '_');
  const enc = encodeURIComponent(base).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${enc}`;
}
