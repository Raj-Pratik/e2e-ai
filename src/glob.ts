const cache = new Map<string, RegExp>();

/**
 * Minimal gitignore-like glob: `*`, `?`, `**`. Patterns without a slash match the
 * basename anywhere; patterns with a slash are anchored at the repository root.
 */
export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;

  let p = pattern.trim().replace(/\\/g, '/');
  if (p.startsWith('/')) p = p.slice(1);
  if (p.endsWith('/')) p += '**';
  const anchored = p.includes('/');

  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        const atSegmentStart = i === 0 || p[i - 1] === '/';
        if (atSegmentStart && p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  const regex = new RegExp(anchored ? `^${re}$` : `^(?:.*/)?${re}$`, 'i');
  cache.set(pattern, regex);
  return regex;
}

export function matchesAny(filePath: string, patterns: readonly string[]): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  for (const pattern of patterns) {
    if (globToRegExp(pattern).test(normalized)) return pattern;
  }
  return null;
}
