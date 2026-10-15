import type { AiProvider, Invocation, ProviderRequest } from './types.js';

const DEFAULT_MAX_TURNS = 40;

/**
 * Claude Code CLI (`claude`). Flags follow the documented CLI reference
 * (https://code.claude.com/docs/en/cli-reference). Interactive runs pass the prompt positionally so
 * the session stays open for plan approval and questions; `-p` print mode is only used without a
 * terminal, where `--output-format`, `--max-turns` and `--no-session-persistence` apply.
 */
export const claudeProvider: AiProvider = {
  id: 'claude',
  displayName: 'Claude Code CLI',
  defaultCommand: 'claude',
  supportsMcp: true,
  unsafeArgs: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', 'bypassPermissions', '--add-dir'],
  verification: 'Based on the documented CLI reference and local `claude --help` (2.1).',

  buildInvocation(request: ProviderRequest): Invocation {
    const { settings } = request;
    // The prompt is positional: keep it first, before any variadic flag.
    const args = request.interactive
      ? [request.instruction, '--permission-mode', 'acceptEdits']
      : [
          '-p',
          request.instruction,
          '--output-format',
          'text',
          '--permission-mode',
          'acceptEdits',
          '--no-session-persistence',
          '--max-turns',
          String(settings.maxTurns ?? DEFAULT_MAX_TURNS),
        ];
    if (request.interactive && settings.maxTurns) args.push('--max-turns', String(settings.maxTurns));
    if (settings.model) args.push('--model', settings.model);
    if (request.mcp) {
      const mcpConfig = { mcpServers: { [request.mcp.name]: { command: request.mcp.command, args: request.mcp.args } } };
      args.push('--mcp-config', JSON.stringify(mcpConfig), '--strict-mcp-config', '--allowedTools', `mcp__${request.mcp.name}`);
    }
    const allowedShell = settings.allowedShellCommands.map((c) => `Bash(${c.trim()} *)`);
    // The verify loop must always be runnable without a permission prompt.
    if (request.verifyCommand) allowedShell.push(`Bash(${request.verifyCommand})`);
    for (const rule of allowedShell) args.push('--allowedTools', rule);
    if (allowedShell.length === 0) args.push('--disallowedTools', 'Bash');
    args.push('--disallowedTools', 'WebFetch', '--disallowedTools', 'WebSearch');
    args.push(...settings.extraArgs);
    return { command: settings.command ?? this.defaultCommand, args };
  },
};
