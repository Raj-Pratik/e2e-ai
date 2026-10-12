import { AiE2eError } from './errors.js';

export interface PushRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

export type RefKind = 'delete' | 'new' | 'update';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function isZeroSha(sha: string): boolean {
  return /^0+$/.test(sha);
}

export function refKind(ref: PushRef): RefKind {
  if (isZeroSha(ref.localSha)) return 'delete';
  if (isZeroSha(ref.remoteSha)) return 'new';
  return 'update';
}

/** Parses the lines Git writes to a pre-push hook's stdin. */
export function parsePrePushInput(input: string): PushRef[] {
  const refs: PushRef[] = [];
  const lines = input.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) throw new AiE2eError(`Malformed pre-push input on line ${index + 1}.`);
    const [localRef, localSha, remoteRef, remoteSha] = parts as [string, string, string, string];
    if (!SHA.test(localSha) || !SHA.test(remoteSha)) {
      throw new AiE2eError(`Malformed object id in pre-push input on line ${index + 1}.`);
    }
    refs.push({ localRef, localSha: localSha.toLowerCase(), remoteRef, remoteSha: remoteSha.toLowerCase() });
  });
  return refs;
}

export function formatPrePushInput(refs: PushRef[]): string {
  return refs.map((r) => `${r.localRef} ${r.localSha} ${r.remoteRef} ${r.remoteSha}\n`).join('');
}
