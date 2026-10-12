const REDACTED = '[REDACTED]';

type Replacer = (match: string, ...groups: string[]) => string;

const RULES: Array<{ pattern: RegExp; replace: Replacer }> = [
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: () => REDACTED,
  },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => REDACTED },
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g, replace: () => REDACTED },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: () => REDACTED },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => REDACTED },
  { pattern: /\b[sr]k_live_[0-9A-Za-z]{16,}\b/g, replace: () => REDACTED },
  { pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, replace: () => REDACTED },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: () => REDACTED },
  { pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi, replace: (_m, prefix) => `${prefix}${REDACTED}` },
  {
    pattern:
      /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token)["']?\s*[:=]\s*)(["'])[^"'\r\n]{6,}\2/gi,
    replace: (_m, prefix, quote) => `${prefix}${quote}${REDACTED}${quote}`,
  },
  { pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@/\s]+@/gi, replace: (_m, prefix) => `${prefix}${REDACTED}@` },
];

export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let result = text;
  for (const rule of RULES) {
    result = result.replace(rule.pattern, (...args: unknown[]) => {
      count++;
      const groups = args.slice(1).filter((g): g is string => typeof g === 'string');
      return rule.replace(String(args[0]), ...groups);
    });
  }
  return { text: result, count };
}

export function redact(text: string): string {
  return redactSecrets(text).text;
}
