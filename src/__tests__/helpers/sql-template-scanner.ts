/**
 * Finds tagged template literals (e.g. sql`…`, sql<number>`…`) in TypeScript source and the `${…}` interpolations in
 * each, multi-line and nested included (launch-blockers audit R11). A small tokenizer: strings, comments and template
 * literals are skipped correctly, so a backtick or brace inside them is never mistaken for code. Regex literals are not
 * recognised (none in this codebase contain a backtick or an unbalanced brace).
 */

export interface Interpolation {
  /** The expression text inside `${…}`, trimmed. */
  expr: string;
  /** 1-based line of the `${`. */
  line: number;
  /** The template text right after the closing `}` (up to the next interpolation or the end). */
  after: string;
}

export interface TaggedTemplate {
  tag: string;
  line: number;
  interpolations: Interpolation[];
}

export function findTaggedTemplates(src: string): TaggedTemplate[] {
  const found: TaggedTemplate[] = [];
  const lineAt = (i: number) => src.slice(0, i).split('\n').length;

  /** The tag before the backtick at `i` (skipping a generic `<…>`), or null for an untagged template. */
  function tagBefore(i: number): string | null {
    let j = i - 1;
    if (src[j] === '>') {
      let depth = 0;
      for (; j >= 0; j--) {
        if (src[j] === '>') depth++;
        else if (src[j] === '<' && --depth === 0) break;
      }
      j--;
    }
    const m = src.slice(Math.max(0, j - 80), j + 1).match(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/);
    return m ? m[1] : null;
  }

  function skipString(i: number): number {
    const q = src[i];
    for (i++; i < src.length; i++) {
      if (src[i] === '\\') { i++; continue; }
      if (src[i] === q || src[i] === '\n') return i + 1;
    }
    return i;
  }

  /** Code from `i`; returns the index of the unmatched `}` (when inExpr) or the end. */
  function scanCode(i: number, inExpr: boolean): number {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
      if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
      if (c === '\'' || c === '"') { i = skipString(i); continue; }
      if (c === '`') { i = scanTemplate(i); continue; }
      if (c === '{') depth++;
      if (c === '}') {
        if (depth === 0 && inExpr) return i;
        depth--;
      }
      i++;
    }
    return i;
  }

  /** The template literal starting at backtick `start`; returns the index after its closing backtick. */
  function scanTemplate(start: number): number {
    const tag = tagBefore(start);
    const record: TaggedTemplate | null = tag ? { tag, line: lineAt(start), interpolations: [] } : null;
    if (record) found.push(record);
    let pending: { expr: string; line: number; textStart: number } | null = null;
    const flush = (textEnd: number) => {
      if (pending && record) record.interpolations.push({ expr: pending.expr, line: pending.line, after: src.slice(pending.textStart, textEnd) });
      pending = null;
    };
    let i = start + 1;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { flush(i); return i + 1; }
      if (c === '$' && src[i + 1] === '{') {
        flush(i);
        const close = scanCode(i + 2, true);
        pending = { expr: src.slice(i + 2, close).trim(), line: lineAt(i), textStart: close + 1 };
        i = close + 1;
        continue;
      }
      i++;
    }
    return i;
  }

  scanCode(0, false);
  return found;
}
