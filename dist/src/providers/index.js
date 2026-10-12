import { AiE2eError } from '../errors.js';
import { resolveCommand, runProcess } from '../proc.js';
import { claudeProvider } from './claude.js';
import { copilotProvider } from './copilot.js';
const registry = new Map([copilotProvider, claudeProvider].map((p) => [p.id, p]));
export function listProviders() {
    return [...registry.values()];
}
export function getProvider(id) {
    const provider = registry.get(id);
    if (!provider) {
        throw new AiE2eError(`Unknown provider "${id}". Supported: ${[...registry.keys()].join(', ')}.`);
    }
    return provider;
}
const VERSION_TIMEOUT_MS = 15_000;
export async function detectProvider(provider, settings, cwd) {
    const command = settings.command ?? provider.defaultCommand;
    const resolvedPath = resolveCommand(command, cwd);
    if (!resolvedPath)
        return { available: false, command, reason: `"${command}" was not found on PATH.` };
    const result = await runProcess(resolvedPath, ['--version'], { cwd, timeoutMs: VERSION_TIMEOUT_MS, maxOutputBytes: 64 * 1024 });
    if (result.error || result.exitCode !== 0) {
        const reason = result.timedOut ? 'timed out' : (result.error?.message ?? `exit code ${result.exitCode}`);
        return { available: false, command, resolvedPath, reason: `"${command} --version" failed (${reason}).` };
    }
    const version = (result.stdout || result.stderr).trim().split('\n')[0]?.slice(0, 200);
    return { available: true, command, resolvedPath, ...(version ? { version } : {}) };
}
export function assertSafeExtraArgs(provider, settings) {
    if (settings.allowUnsafeArgs)
        return;
    const unsafe = settings.extraArgs.filter((arg) => provider.unsafeArgs.some((u) => arg === u || arg.startsWith(`${u}=`) || arg === u.replace(/^--/, '')));
    if (unsafe.length) {
        throw new AiE2eError(`providers.${provider.id}.extraArgs contains permission-bypassing flags (${unsafe.join(', ')}). ` +
            `Set providers.${provider.id}.allowUnsafeArgs to true to permit them.`);
    }
}
const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;
export function secretEnvNames(env) {
    return Object.keys(env)
        .filter((name) => SECRET_ENV.test(name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        .sort();
}
