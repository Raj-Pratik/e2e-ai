const DEFAULT_MAX_TURNS = 40;
/**
 * Claude Code CLI (`claude`). Not installed on the development machine; flags follow the
 * documented CLI reference (https://code.claude.com/docs/en/cli-reference): `-p`,
 * `--output-format text`, `--permission-mode acceptEdits`, `--disallowedTools`,
 * `--allowedTools`, `--mcp-config`, `--strict-mcp-config`, `--max-turns`,
 * `--no-session-persistence`, `--model`.
 */
export const claudeProvider = {
    id: 'claude',
    displayName: 'Claude Code CLI',
    defaultCommand: 'claude',
    supportsMcp: true,
    unsafeArgs: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', 'bypassPermissions', '--add-dir'],
    verification: 'Based on the documented CLI reference; not verified against a local install.',
    buildInvocation(request) {
        const { settings } = request;
        // The prompt is positional: keep it directly after -p, before any variadic flag.
        const args = [
            '-p',
            request.instruction,
            '--output-format',
            'text',
            '--permission-mode',
            'acceptEdits',
            ...(request.interactive ? [] : ['--no-session-persistence']),
            '--max-turns',
            String(settings.maxTurns ?? DEFAULT_MAX_TURNS),
        ];
        if (settings.model)
            args.push('--model', settings.model);
        if (request.mcp) {
            const mcpConfig = { mcpServers: { [request.mcp.name]: { command: request.mcp.command, args: request.mcp.args } } };
            args.push('--mcp-config', JSON.stringify(mcpConfig), '--strict-mcp-config', '--allowedTools', `mcp__${request.mcp.name}`);
        }
        const allowedShell = settings.allowedShellCommands.map((c) => `Bash(${c.trim()} *)`);
        for (const rule of allowedShell)
            args.push('--allowedTools', rule);
        if (allowedShell.length === 0)
            args.push('--disallowedTools', 'Bash');
        args.push('--disallowedTools', 'WebFetch', '--disallowedTools', 'WebSearch');
        args.push(...settings.extraArgs);
        return { command: settings.command ?? this.defaultCommand, args };
    },
};
