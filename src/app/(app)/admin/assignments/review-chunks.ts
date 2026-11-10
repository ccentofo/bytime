/** reviewMigratedScopes takes at most this many rows per call (the server's limit). */
export const REVIEW_CHUNK = 500;

/**
 * APPROVAL-SCOPE-AUDIT.md L10: the review split into calls of ≤ `size` rows (default REVIEW_CHUNK), each with its keep /
 * remove ids. Client-safe; its own module so a test can shrink the chunk size.
 */
export function reviewChunks(ids: string[], toRemove: ReadonlySet<string>, size: number = REVIEW_CHUNK): Array<{ keep: string[]; remove: string[] }> {
  const out: Array<{ keep: string[]; remove: string[] }> = [];
  for (let i = 0; i < ids.length; i += size) {
    const part = ids.slice(i, i + size);
    out.push({ keep: part.filter((id) => !toRemove.has(id)), remove: part.filter((id) => toRemove.has(id)) });
  }
  return out;
}
