import fs from 'node:fs';
import path from 'node:path';
import { AiE2eError, errorMessage } from './errors.js';
export const CONFIG_FILE = '.ai-e2e.json';
export function defaultProviderSettings() {
    return {
        command: null,
        model: null,
        fallbackModels: [],
        extraArgs: [],
        allowUnsafeArgs: false,
        allowedShellCommands: ['node', 'npm', 'npx', 'python', 'python3', 'pytest', 'uv'],
        maxTurns: null,
    };
}
export function defaultConfig() {
    return {
        enabled: true,
        provider: 'copilot',
        providers: {
            copilot: defaultProviderSettings(),
            claude: defaultProviderSettings(),
        },
        prompt: { timeoutSeconds: 60 },
        generation: {
            timeoutSeconds: 900,
            maxOutputBytes: 1024 * 1024,
            allowModifyExistingTests: true,
            outputDir: null,
            interactive: true,
            commitGeneratedTests: true,
        },
        playwright: { configPath: null, testDir: null, runGeneratedTests: true, testCommand: null, testTimeoutSeconds: 600 },
        mcp: { playwright: { enabled: false, command: 'npx', args: ['@playwright/mcp@latest'], baseUrl: null } },
        context: {
            maxFiles: 60,
            maxCommits: 50,
            maxDiffBytesPerFile: 20_000,
            maxTotalDiffBytes: 120_000,
            maxPromptBytes: 200_000,
            maxRelatedTests: 3,
            exclude: [],
            excludeGenerated: true,
        },
        jobs: { duplicate: 'skip', stateDir: '.ai-e2e', keep: 30 },
    };
}
function fail(at, expected) {
    throw new AiE2eError(`Invalid configuration: "${at}" must be ${expected}.`);
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const bool = (v, at) => (typeof v === 'boolean' ? v : fail(at, 'a boolean'));
const int = (min, max) => (v, at) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fail(at, `an integer between ${min} and ${max}`);
const str = (v, at) => (typeof v === 'string' && v.trim() !== '' ? v : fail(at, 'a non-empty string'));
const nullable = (check) => (v, at) => v === null ? null : check(v, at);
const strArray = (v, at) => {
    if (!Array.isArray(v))
        fail(at, 'an array of strings');
    return v.map((item, i) => str(item, `${at}[${i}]`));
};
const nonEmptyStrArray = (v, at) => {
    const arr = strArray(v, at);
    return arr.length > 0 ? arr : fail(at, 'a non-empty array of strings');
};
const oneOf = (...values) => (v, at) => typeof v === 'string' && values.includes(v) ? v : fail(at, `one of ${values.map((x) => `"${x}"`).join(', ')}`);
const httpUrl = (v, at) => {
    const s = str(v, at);
    try {
        const url = new URL(s);
        if (url.protocol === 'http:' || url.protocol === 'https:')
            return s;
    }
    catch {
        // reported below
    }
    return fail(at, 'an http(s) URL');
};
const obj = (shape) => (v, at) => {
    if (!isPlainObject(v))
        fail(at, 'an object');
    const out = {};
    for (const [key, value] of Object.entries(v)) {
        const check = shape[key];
        if (!check)
            throw new AiE2eError(`Invalid configuration: unknown key "${at}.${key}".`);
        out[key] = check(value, `${at}.${key}`);
    }
    return out;
};
const providerId = /^[a-z][a-z0-9-]{0,40}$/;
const record = (check) => (v, at) => {
    if (!isPlainObject(v))
        fail(at, 'an object');
    const out = {};
    for (const [key, value] of Object.entries(v)) {
        if (!providerId.test(key))
            throw new AiE2eError(`Invalid configuration: "${at}.${key}" is not a valid provider id.`);
        out[key] = check(value, `${at}.${key}`);
    }
    return out;
};
const providerSchema = obj({
    command: nullable(str),
    model: nullable(str),
    fallbackModels: strArray,
    extraArgs: strArray,
    allowUnsafeArgs: bool,
    allowedShellCommands: strArray,
    maxTurns: nullable(int(1, 1000)),
});
const schema = obj({
    $schema: str,
    enabled: bool,
    provider: (v, at) => (typeof v === 'string' && providerId.test(v) ? v : fail(at, 'a provider id such as "copilot"')),
    providers: record(providerSchema),
    prompt: obj({ timeoutSeconds: int(1, 3600) }),
    generation: obj({
        timeoutSeconds: int(10, 6 * 3600),
        maxOutputBytes: int(1024, 64 * 1024 * 1024),
        allowModifyExistingTests: bool,
        outputDir: nullable(str),
        interactive: bool,
        commitGeneratedTests: bool,
    }),
    playwright: obj({
        configPath: nullable(str),
        testDir: nullable(str),
        runGeneratedTests: bool,
        testCommand: nullable(nonEmptyStrArray),
        testTimeoutSeconds: int(10, 6 * 3600),
    }),
    mcp: obj({
        playwright: obj({ enabled: bool, command: str, args: strArray, baseUrl: nullable(httpUrl) }),
    }),
    context: obj({
        maxFiles: int(1, 5000),
        maxCommits: int(1, 10_000),
        maxDiffBytesPerFile: int(100, 10 * 1024 * 1024),
        maxTotalDiffBytes: int(100, 50 * 1024 * 1024),
        maxPromptBytes: int(2000, 50 * 1024 * 1024),
        maxRelatedTests: int(0, 50),
        exclude: strArray,
        excludeGenerated: bool,
    }),
    jobs: obj({ duplicate: oneOf('skip', 'allow'), stateDir: str, keep: int(1, 10_000) }),
});
function deepMerge(base, override) {
    if (!isPlainObject(base) || !isPlainObject(override))
        return (override === undefined ? base : override);
    const out = { ...base };
    for (const [key, value] of Object.entries(override)) {
        out[key] = key in out ? deepMerge(out[key], value) : value;
    }
    return out;
}
export function validateConfig(raw) {
    const partial = schema(raw, 'config');
    delete partial.$schema;
    const merged = deepMerge(defaultConfig(), partial);
    for (const [id, settings] of Object.entries(merged.providers)) {
        merged.providers[id] = deepMerge(defaultProviderSettings(), settings);
    }
    return merged;
}
export function loadConfig(repoRoot) {
    const file = path.join(repoRoot, CONFIG_FILE);
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return { config: defaultConfig(), path: file, exists: false, raw: {} };
        }
        throw new AiE2eError(`Cannot read ${CONFIG_FILE}: ${errorMessage(error)}`);
    }
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch (error) {
        throw new AiE2eError(`${CONFIG_FILE} is not valid JSON: ${errorMessage(error)}`);
    }
    return { config: validateConfig(raw), path: file, exists: true, raw: raw };
}
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
function keySegments(key) {
    const segments = key.split('.');
    if (segments.some((s) => s === '' || FORBIDDEN_KEYS.has(s)))
        throw new AiE2eError(`Invalid configuration key "${key}".`);
    return segments;
}
export function getConfigValue(config, key) {
    let current = config;
    for (const segment of keySegments(key)) {
        if (!isPlainObject(current) || !Object.hasOwn(current, segment))
            throw new AiE2eError(`Unknown configuration key "${key}".`);
        current = current[segment];
    }
    return current;
}
/** Returns an updated copy of the raw config; throws if the result would be invalid. */
export function setConfigValue(raw, key, value) {
    const copy = structuredClone(raw);
    const segments = keySegments(key);
    let current = copy;
    for (const segment of segments.slice(0, -1)) {
        const next = current[segment];
        if (next === undefined)
            current[segment] = {};
        else if (!isPlainObject(next))
            throw new AiE2eError(`Cannot set "${key}": "${segment}" is not an object.`);
        current = current[segment];
    }
    current[segments.at(-1)] = value;
    validateConfig(copy);
    return copy;
}
export function parseConfigValue(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
export function writeConfig(file, raw) {
    fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
}
export function stateDirPath(repoRoot, config) {
    return path.resolve(repoRoot, config.jobs.stateDir);
}
/** Minimal starter configuration written by `ai-e2e init`. */
export function starterConfig() {
    return {
        enabled: true,
        provider: 'copilot',
        playwright: { runGeneratedTests: true },
        mcp: { playwright: { enabled: false } },
        context: { exclude: [] },
    };
}
