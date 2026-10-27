/**
 * Shared TypeScript source scanner for the static tests (server-action-guards, action-results-static).
 */

// R2-6: start of a DB write's payload — `.values(` or `.set(`. Its argument must never be a
// caller-supplied parameter, whole or spread, or the caller can set columns the form never offered.
export const DB_WRITE_CALL_PATTERN = /\.(values|set)\s*\(/g;

/**
 * R2-12: strip comments before matching, so a comment that happens to mention a guard name or
 * a banned identity parameter can't fool these checks into thinking real code is present.
 * A `//` inside a same-line string literal (e.g. a URL: "https://…") is NOT a comment and is kept
 * (UX-1 audit L9). Quotes are tracked per line only — a JSX-text apostrophe can open a "string",
 * in which case the line is kept whole (errs toward keeping text, never toward dropping code).
 * Block comments are removed first, without string awareness.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(stripLineComment).join('\n');
}

function stripLineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

// ---------------------------------------------------------------------------
// Minimal brace-matching source scanner. We can't pull in a real TS parser
// dependency just for this, and regex-per-line is too fragile given multi-line
// parameter object types — so walk the source char-by-char.
// ---------------------------------------------------------------------------

export interface ParsedFunction {
  name: string;
  paramText: string;
  bodyText: string;
}

export function parseExportedFunctions(source: string): ParsedFunction[] {
  const results: ParsedFunction[] = [];
  // Also matches plain `export function` (internal helpers, feature-plan-launch-blockers.md P4).
  const fnRegex = /export\s+(?:async\s+)?function\s+(\w+)\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = fnRegex.exec(source)) !== null) {
    const name = match[1];
    const parenStart = match.index + match[0].length - 1; // index of the opening '('

    // Find the matching close paren for the parameter list.
    let depth = 0;
    let i = parenStart;
    for (; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const paramText = source.slice(parenStart + 1, i);

    // Find the function body's opening brace. Can't just take the first '{' after the
    // param list — a return type like `Promise<{ secret: string }>` has its own braces.
    // Walk forward tracking <>/()/[] nesting so a brace is only "the body" when none of
    // those are open and we're not already inside a nested {} from the type annotation.
    let angleDepth = 0;
    let parenDepth2 = 0;
    let bracketDepth = 0;
    let typeBraceDepth = 0;
    let bodyStart = -1;
    for (let k = i + 1; k < source.length; k++) {
      const ch = source[k];
      if (ch === '<') angleDepth++;
      else if (ch === '>') {
        if (angleDepth > 0) angleDepth--;
      } else if (ch === '(') parenDepth2++;
      else if (ch === ')') parenDepth2--;
      else if (ch === '[') bracketDepth++;
      else if (ch === ']') bracketDepth--;
      else if (ch === '{') {
        if (angleDepth === 0 && parenDepth2 === 0 && bracketDepth === 0 && typeBraceDepth === 0) {
          bodyStart = k;
          break;
        }
        typeBraceDepth++;
      } else if (ch === '}') {
        typeBraceDepth--;
      }
    }
    if (bodyStart === -1) continue;

    // Find the matching close brace for the body.
    let braceDepth = 0;
    let j = bodyStart;
    for (; j < source.length; j++) {
      if (source[j] === '{') braceDepth++;
      else if (source[j] === '}') {
        braceDepth--;
        if (braceDepth === 0) break;
      }
    }
    const bodyText = source.slice(bodyStart, j + 1);

    results.push({ name, paramText, bodyText });
  }

  return results;
}

/** Top-level parameter names of a function's parameter list (`a: T, b?: { x: U } = {}` → a, b). */
export function parameterNames(paramText: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of paramText + ',') {
    if ('({[<'.includes(ch)) depth++;
    else if (')}]>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      const m = current.trim().match(/^(\w+)/);
      if (m) names.push(m[1]);
      current = '';
    } else {
      current += ch;
    }
  }
  return names;
}

/** The argument text of every `.values(...)` / `.set(...)` call in a function body. */
export function writePayloads(bodyText: string): string[] {
  const payloads: string[] = [];
  let match: RegExpExecArray | null;
  DB_WRITE_CALL_PATTERN.lastIndex = 0;
  while ((match = DB_WRITE_CALL_PATTERN.exec(bodyText)) !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < bodyText.length; i++) {
      if (bodyText[i] === '(') depth++;
      else if (bodyText[i] === ')' && --depth === 0) break;
    }
    payloads.push(bodyText.slice(open + 1, i));
  }
  return payloads;
}
