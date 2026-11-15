/**
 * IP normalization shared by the signup IP hash (`src/lib/signup/controls.ts`) and the rate-limit identifiers
 * (`src/lib/rate-limit/identifier.ts`). No `server-only` here: the rate-limit store loads in plain Node tests
 * (feature-plan-upstash-rate-limiting.md §6.2, §6.3).
 */

/**
 * The address the hash is taken over: IPv4 as-is; IPv6 reduced to its /64 prefix (one subscriber holds a whole /64,
 * so rotating within it must not mint new buckets). Returns null for an unusable value ('unknown', empty).
 */
export function signupIpKey(ip: string): string | null {
  const raw = ip.trim().toLowerCase();
  if (!raw || raw === 'unknown') return null;
  if (!raw.includes(':')) return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw) ? raw : null; // IPv4
  let v6 = raw.replace(/^\[|\]$/g, '').split('%')[0];
  // A trailing dotted quad (::ffff:1.2.3.4, ::1.2.3.4, 64:ff9b::1.2.3.4) → two hex groups, so every form parses alike.
  const dotted = v6.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    v6 = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = v6.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = v6.includes('::') ? Array(Math.max(0, 8 - headParts.length - tailParts.length)).fill('0') : [];
  const groups = [...headParts, ...fill, ...tailParts];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const n = groups.map((g) => parseInt(g, 16));
  // Audit S8: IPv4 carried inside IPv6 is that IPv4 address — not one shared ::/64 bucket (or a refusal).
  // IPv4-mapped ::ffff:a.b.c.d / ::ffff:hhhh:hhhh, IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::/96.
  const zeros = (from: number, to: number) => n.slice(from, to).every((x) => x === 0);
  const isMapped = zeros(0, 5) && n[5] === 0xffff;
  const isCompatible = zeros(0, 6) && (n[6] !== 0 || n[7] > 1); // not :: or ::1
  const isNat64 = n[0] === 0x64 && n[1] === 0xff9b && zeros(2, 6);
  if (isMapped || isCompatible || isNat64) return `${n[6] >> 8}.${n[6] & 0xff}.${n[7] >> 8}.${n[7] & 0xff}`;
  return `${n.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}
