import { matchesAny } from './glob.js';

/** Always applied; never sent to an AI provider. */
export const SENSITIVE_PATTERNS: readonly string[] = [
  '.env',
  '.env.*',
  '*.env',
  '.envrc',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.kdbx',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pypirc',
  '.netrc',
  '.pgpass',
  '.htpasswd',
  'credentials*',
  '*secret*',
  '*.tfstate',
  '*.tfstate.*',
  '*.tfvars',
  'kubeconfig*',
  'storageState*.json',
  '**/.auth/**',
  '**/.aws/**',
  '**/.ssh/**',
  '**/.gnupg/**',
  '**/.docker/config.json',
];

export const GENERATED_PATTERNS: readonly string[] = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/.ai-e2e/**',
  '**/.git/**',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.snap',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.webp',
  '*.ico',
  '*.bmp',
  '*.pdf',
  '*.zip',
  '*.gz',
  '*.tgz',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.otf',
  '*.eot',
  '*.mp4',
  '*.mp3',
  '*.wasm',
];

export type ExclusionReason = 'sensitive' | 'generated' | 'configured';

export class PathFilter {
  constructor(
    private readonly configured: readonly string[],
    private readonly excludeGenerated: boolean,
  ) {}

  classify(filePath: string): ExclusionReason | null {
    if (matchesAny(filePath, SENSITIVE_PATTERNS)) return 'sensitive';
    if (matchesAny(filePath, this.configured)) return 'configured';
    if (this.excludeGenerated && matchesAny(filePath, GENERATED_PATTERNS)) return 'generated';
    return null;
  }

  isSensitive(filePath: string): boolean {
    return matchesAny(filePath, SENSITIVE_PATTERNS) !== null;
  }
}
