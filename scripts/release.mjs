import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version) || lock.version !== version || lock.packages[''].version !== version ||
    pkg.name !== 'pushpilot' || lock.name !== pkg.name) throw new Error('Package and lock versions/names must match.');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) throw new Error('Release tag must match package version.');
if (process.argv[2] === 'check') {
  console.log(`PushPilot ${version}: release metadata valid.`);
  process.exit(0);
}
if (process.argv[2] === 'manifests') {
  // Renders the Homebrew formula and Scoop manifest from packaging/*.in using the real
  // .sha256 sidecars of the published archives in the given directory.
  const dir = process.argv[3] ?? 'release';
  const out = process.argv[4] ?? path.join('release', 'manifests');
  const values = {
    VERSION: version,
    BASE_URL: process.env.RELEASE_BASE_URL ?? `https://github.com/Raj-Pratik/e2e-ai/releases/download/v${version}`,
  };
  const archives = { WIN32_X64_SHA256: `pushpilot-${version}-win32-x64.zip`, SHA256: `pushpilot-${version}.tar.gz` };
  for (const [key, archive] of Object.entries(archives)) {
    const [hash] = fs.readFileSync(path.join(dir, `${archive}.sha256`), 'utf8').split(/\s+/);
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`Invalid checksum for ${archive}.`);
    values[key] = hash;
  }
  for (const [template, output] of [['packaging/pushpilot.rb.in', 'Formula/pushpilot.rb'], ['packaging/pushpilot.scoop.json.in', 'bucket/pushpilot.json']]) {
    const text = fs.readFileSync(template, 'utf8').replace(/@([A-Z0-9_]+)@/g, (_, key) => {
      if (!(key in values)) throw new Error(`No value for @${key}@ in ${template}.`);
      return values[key];
    });
    fs.mkdirSync(path.join(out, path.dirname(output)), { recursive: true });
    fs.writeFileSync(path.join(out, output), text);
    console.log(`Wrote ${path.join(out, output)}`);
  }
  process.exit(0);
}
if (process.argv[2] !== 'bundle') throw new Error('Usage: node scripts/release.mjs check|manifests [archives-dir] [out-dir]|bundle');
// PUSHPILOT_NO_RUNTIME=1 builds one platform-independent archive without Node, for package
// managers that supply Node themselves (the Homebrew formula depends on Homebrew's node).
const noRuntime = process.env.PUSHPILOT_NO_RUNTIME === '1';
if (!noRuntime && !process.env.NODE_LICENSE) throw new Error('Set NODE_LICENSE to the official license for the bundled Node version.');
const platform = noRuntime ? 'any' : process.platform;
const arch = process.arch;
const name = noRuntime ? `pushpilot-${version}` : `pushpilot-${version}-${platform}-${arch}`;
const root = path.join('release', name);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.cpSync('dist/src', path.join(root, 'dist/src'), { recursive: true });
fs.copyFileSync('package.json', path.join(root, 'package.json'));
fs.copyFileSync('README.md', path.join(root, 'README.md'));
if (noRuntime) {
  fs.writeFileSync(path.join(root, 'pushpilot'), '#!/bin/sh\nroot="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec node "$root/dist/src/cli.js" "$@"\n', { mode: 0o755 });
} else {
  fs.copyFileSync(process.env.NODE_LICENSE, path.join(root, 'NODE-LICENSE'));
  fs.copyFileSync(process.execPath, path.join(root, platform === 'win32' ? 'node.exe' : 'node'));
  fs.writeFileSync(path.join(root, 'pushpilot'), '#!/bin/sh\nroot="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$root/node" "$root/dist/src/cli.js" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'pushpilot.cmd'), '@echo off\r\n"%~dp0node.exe" "%~dp0dist\\src\\cli.js" %*\r\n');
}
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else files.push({ name: path.relative(root, file).split(path.sep).join('/'), data: fs.readFileSync(file) });
  }
}
walk(root);
// Fixed metadata and sorted entries make archives reproducible for identical inputs.
function tar() {
  const parts = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    const name = `${namePrefix()}${file.name}`;
    if (Buffer.byteLength(name) > 100) throw new Error(`Tar path too long: ${name}`);
    header.write(name, 0, 100);
    const octal = (value, offset, size) => header.write(value.toString(8).padStart(size - 1, '0') + '\0', offset, size);
    octal(file.name === 'node' || file.name === 'pushpilot' ? 0o755 : 0o644, 100, 8);
    octal(0, 108, 8); octal(0, 116, 8);
    octal(file.data.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    octal(header.reduce((sum, byte) => sum + byte, 0), 148, 8);
    parts.push(header, file.data, Buffer.alloc((512 - file.data.length % 512) % 512));
  }
  return zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]), { level: 9 });
}
function namePrefix() { return `${name}/`; }
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip() {
  const local = [], central = [];
  let offset = 0;
  for (const file of files) {
    const filename = Buffer.from(namePrefix() + file.name);
    const checksum = crc32(file.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(file.data.length, 18);
    header.writeUInt32LE(file.data.length, 22); header.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(33, 14); entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(file.data.length, 20); entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, filename, file.data); central.push(entry, filename);
    offset += header.length + filename.length + file.data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const archive = `${name}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
const bytes = platform === 'win32' ? zip() : tar();
fs.writeFileSync(path.join('release', archive), bytes);
const hash = crypto.createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(path.join('release', `${archive}.sha256`), `${hash}  ${archive}\n`);
console.log(`${archive}: ${hash}`);
