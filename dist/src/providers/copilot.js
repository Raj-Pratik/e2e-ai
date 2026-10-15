/** Shell commands denied when the developer opts into limited shell access. */
const DENIED_SHELL = [
    'git push',
    'git commit',
    'git reset',
    'git checkout',
    'git switch',
    'git restore',
    'git stash',
    'git rebase',
    'git merge',
    'git add',
    'git rm',
    'git clean',
    'git tag',
    'git branch',
    'git config',
    'rm',
    'curl',
    'wget',
    'ssh',
    'scp',
    'npm',
    'yarn',
    'pnpm',
];
/**
 * GitHub Copilot CLI (`copilot`). Flags verified against `copilot --help` and
 * `copilot help permissions` for v1.0.94: `-p`, `--silent`, `--no-ask-user`,
 * `--allow-all-tools` (required for -p), `--deny-tool=<pattern>` (takes precedence over allow),
 * `--secret-env-vars`, `--additional-mcp-config`, `--model`.
 */
export const copilotProvider = {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    defaultCommand: 'copilot',
    supportsMcp: true,
    unsafeArgs: ['--allow-all', '--yolo', '--allow-all-paths', '--allow-all-urls', '--enable-all-github-mcp-tools'],
    verification: 'Verified against local `copilot --help` (v1.0.94).',
    buildInvocation(request) {
        const { settings } = request;
        const args = request.interactive
            ? ['-i', request.instruction, '--allow-all-tools']
            : ['-p', request.instruction, '--silent', '--no-ask-user', '--allow-all-tools'];
        const allowedShell = new Set(settings.allowedShellCommands.map((c) => c.trim()));
        if (allowedShell.size === 0 && !request.verifyCommand) {
            args.push('--deny-tool=shell');
        }
        else {
            for (const cmd of DENIED_SHELL)
                if (!allowedShell.has(cmd))
                    args.push(`--deny-tool=shell(${cmd})`);
        }
        args.push('--deny-tool=write(.env)', '--deny-tool=write(.git)');
        if (request.secretEnvNames.length)
            args.push(`--secret-env-vars=${request.secretEnvNames.join(',')}`);
        if (settings.model)
            args.push('--model', settings.model);
        if (request.mcp) {
            const mcpConfig = {
                mcpServers: {
                    [request.mcp.name]: { type: 'local', command: request.mcp.command, args: request.mcp.args, tools: ['*'] },
                },
            };
            args.push('--additional-mcp-config', JSON.stringify(mcpConfig));
        }
        args.push(...settings.extraArgs);
        return { command: settings.command ?? this.defaultCommand, args };
    },
};
