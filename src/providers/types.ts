import type { ProviderSettings } from '../config.js';

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
}

export interface ProviderRequest {
  repoRoot: string;
  /** Short instruction pointing the agent at the task file; kept small for argv limits. */
  instruction: string;
  settings: ProviderSettings;
  mcp: McpServerSpec | null;
  /** Names (never values) of environment variables that look secret. */
  secretEnvNames: string[];
  interactive?: boolean;
  /** Exact `pushpilot verify` command line the agent must be allowed to run. */
  verifyCommand?: string;
}

export interface Invocation {
  command: string;
  args: string[];
}

export interface AiProvider {
  readonly id: string;
  readonly displayName: string;
  readonly defaultCommand: string;
  readonly supportsMcp: boolean;
  /** Flags that disable the tool's own safety prompts; rejected unless allowUnsafeArgs is set. */
  readonly unsafeArgs: readonly string[];
  /** How the invocation contract was verified, surfaced by `ai-e2e providers`. */
  readonly verification: string;
  buildInvocation(request: ProviderRequest): Invocation;
}
