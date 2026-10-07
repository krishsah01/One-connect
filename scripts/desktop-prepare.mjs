// SPDX-License-Identifier: Apache-2.0
// Prepare a self-contained engine; production dependencies only, no vendor binaries or credentials.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeDependencies } from './native-dependencies.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'packages/desktop/src-tauri/resources/engine');
const version = '24.21.0';
const archiveName = `node-v${version}-darwin-${process.arch}.tar.gz`;
const cache = path.join(root, '.desktop-cache');
fs.mkdirSync(cache, { recursive: true });
const archive = path.join(cache, archiveName);
const checksums = path.join(cache, `node-v${version}-SHASUMS256.txt`);
if (!fs.existsSync(checksums)) execFileSync('curl', ['--fail', '--location', '--proto', '=https', '-o', checksums, `https://nodejs.org/dist/v${version}/SHASUMS256.txt`], { stdio: 'inherit' });
if (!fs.existsSync(archive)) execFileSync('curl', ['--fail', '--location', '--proto', '=https', '-o', archive, `https://nodejs.org/dist/v${version}/${archiveName}`], { stdio: 'inherit' });
const expected = fs.readFileSync(checksums, 'utf8').split('\n').find(l => l.endsWith(`  ${archiveName}`))?.split(' ')[0];
const actual = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
if (!expected || expected !== actual) throw new Error('Node archive checksum mismatch');
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
execFileSync('tar', ['xzf', archive, '-C', cache]);
fs.mkdirSync(path.join(out, 'runtime'));
fs.copyFileSync(path.join(cache, `node-v${version}-darwin-${process.arch}/bin/node`), path.join(out, 'runtime/node'));
fs.chmodSync(path.join(out, 'runtime/node'), 0o755);
fs.copyFileSync(path.join(cache, `node-v${version}-darwin-${process.arch}/LICENSE`), path.join(out, 'runtime/LICENSE'));
for (const sub of ['packages/core', 'packages/daemon', 'examples', 'scripts/demo.mjs', 'packages/web/dist']) {
  fs.cpSync(path.join(root, sub), path.join(out, sub), { recursive: true, filter: p => {
    const parts = path.relative(path.join(root, sub), p).split(path.sep);
    return !parts.some(x => ['node_modules', '.git'].includes(x)) && !(sub.startsWith('packages/') && parts.includes('test'));
  } });
}
// Runtime package links mirror pnpm's isolation, but contain only the reachable production tree.
const copied = new Map();
function link(from, to) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.symlinkSync(path.relative(path.dirname(to), from), to, 'dir'); }
function findDependency(start, name) {
  for (let p = start; ; p = path.dirname(p)) {
    const candidate = path.join(p, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
    if (p === path.dirname(p)) throw new Error(`Cannot resolve ${name} from ${start}`);
  }
}
function copyPackage(src) {
  src = fs.realpathSync(src);
  if (src === path.join(root, 'packages/core')) return path.join(out, 'packages/core');
  if (copied.has(src)) return copied.get(src);
  const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json')));
  const dest = path.join(out, 'node_modules/.vendor', `${pkg.name.replaceAll('/', '+')}@${pkg.version}-${createHash('sha256').update(path.relative(root, src)).digest('hex').slice(0, 6)}`);
  copied.set(src, dest);
  fs.cpSync(src, dest, { recursive: true, filter: p => !path.relative(src, p).split(path.sep).includes('node_modules') });
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    try { link(copyPackage(findDependency(src, dep)), path.join(dest, 'node_modules', dep)); }
    catch (e) { if (!pkg.optionalDependencies?.[dep]) throw e; }
  }
  return dest;
}
for (const local of ['core', 'daemon']) {
  const src = path.join(root, 'packages', local);
  const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json')));
  for (const dep of Object.keys(pkg.dependencies ?? {})) link(copyPackage(findDependency(src, dep)), path.join(out, 'packages', local, 'node_modules', dep));
}
for (const f of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(root, f), path.join(out, f));
for (const crate of nativeDependencies()) {
  const source = path.dirname(crate.manifest_path);
  const target = path.join(out, 'native-notices', `${crate.name}-${crate.version}`);
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(crate.manifest_path, path.join(target, 'Cargo.toml'));
  for (const name of fs.readdirSync(source)) if (/^(licen[cs]e|copying|notice|copyright)/i.test(name)) {
    fs.cpSync(path.join(source, name), path.join(target, name), { recursive: true });
  }
  if (crate.license === 'MPL-2.0') fs.cpSync(source, path.join(out, 'native-sources', `${crate.name}-${crate.version}`), { recursive: true });
}
// Tauri's resource copier skips directory symlinks. An archive preserves pnpm-style links.
const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? 0);
if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Invalid SOURCE_DATE_EPOCH');
const archiveFiles = [];
function normalize(file) {
  const stat = fs.lstatSync(file);
  archiveFiles.push(path.relative(path.dirname(out), file));
  if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) normalize(path.join(file, name));
  if (stat.isSymbolicLink()) fs.lutimesSync(file, epoch, epoch);
  else fs.utimesSync(file, epoch, epoch);
}
normalize(out);
const list = path.join(cache, 'engine-files.txt');
fs.writeFileSync(list, archiveFiles.sort().join('\n') + '\n');
execFileSync('/usr/bin/tar', ['czf', path.join(path.dirname(out), 'engine.tar.gz'), '--no-xattrs', '--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root', '--no-recursion', '-C', path.dirname(out), '-T', list], { stdio: 'inherit' });
console.log(`Prepared ${copied.size} runtime packages and Node ${version} (${process.arch}) at ${out}`);
