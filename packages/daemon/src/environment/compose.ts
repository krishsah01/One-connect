// SPDX-License-Identifier: Apache-2.0
// Declarative Compose reading: parse YAML only. Nothing is interpolated, built or executed here.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const MAX_COMPOSE_BYTES = 256 * 1024;

export interface ComposePort { hostIp: string | null; host: number | null; container: number | null; protocol: string; raw: string }
export interface ComposeService {
  name: string;
  image: string | null;
  build: boolean;
  ports: ComposePort[];
  healthcheck: boolean;
  volumes: string[];
  dependsOn: string[];
  profiles: string[];
}
export interface ComposeFile { file: string; project: string; services: ComposeService[]; volumes: string[]; warnings: string[] }

/** Compose's own project-name normalization: lowercase, keep [a-z0-9_-], must start alphanumeric. */
export function normalizeComposeProject(name: string): string {
  const n = name.toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[^a-z0-9]+/, '');
  return n || 'project';
}

/** Read a small regular file. Symlinks and oversized files are refused so intake cannot escape the folder. */
export function readBounded(file: string, max = MAX_COMPOSE_BYTES): string | null {
  try {
    return readScopedBytes(path.dirname(path.resolve(file)), path.resolve(file), max).toString('utf8');
  } catch {
    return null;
  }
}

export function findComposeFile(dir: string): string | null {
  for (const name of COMPOSE_FILES) {
    const f = path.join(dir, name);
    try {
      if (fs.lstatSync(f).isFile()) return f;
    } catch {
      /* next */
    }
  }
  return null;
}

function port(n: unknown): number | null {
  const v = typeof n === 'number' ? n : typeof n === 'string' && /^\d+$/.test(n) ? Number(n) : NaN;
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : null;
}

export function parsePort(entry: unknown): ComposePort {
  if (entry && typeof entry === 'object') {
    const o = entry as Record<string, unknown>;
    return { hostIp: typeof o.host_ip === 'string' ? o.host_ip : null, host: port(o.published), container: port(o.target), protocol: typeof o.protocol === 'string' ? o.protocol : 'tcp', raw: JSON.stringify(o) };
  }
  const raw = String(entry);
  const [spec, protocol = 'tcp'] = raw.split('/');
  // Interpolated values (${PORT}) and ranges are reported as unknown rather than guessed.
  if (spec.includes('$') || spec.includes('-')) return { hostIp: null, host: null, container: null, protocol, raw };
  const parts = spec.startsWith('[') ? [spec.slice(0, spec.indexOf(']') + 1), ...spec.slice(spec.indexOf(']') + 2).split(':')] : spec.split(':');
  if (parts.length === 1) return { hostIp: null, host: null, container: port(parts[0]), protocol, raw };
  if (parts.length === 2) return { hostIp: null, host: port(parts[0]), container: port(parts[1]), protocol, raw };
  return { hostIp: parts[0].replace(/^\[|\]$/g, ''), host: port(parts[1]), container: port(parts[2]), protocol, raw };
}

export function parseCompose(file: string, fallbackName: string): ComposeFile {
  const text = readBounded(file);
  if (text === null) throw new Error(`${path.basename(file)} is missing, a symlink or larger than 256 KiB`);
  const doc = YAML.parse(text, { maxAliasCount: 50 }) as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object') throw new Error(`${path.basename(file)} is not a Compose mapping`);
  const warnings: string[] = [];
  const named = typeof doc.name === 'string' && !doc.name.includes('$') ? doc.name : null;
  const project = normalizeComposeProject(named ?? fallbackName);
  const services: ComposeService[] = [];
  for (const [name, raw] of Object.entries((doc.services ?? {}) as Record<string, unknown>)) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const deps = Array.isArray(s.depends_on) ? s.depends_on.map(String) : s.depends_on && typeof s.depends_on === 'object' ? Object.keys(s.depends_on) : [];
    const volumes = (Array.isArray(s.volumes) ? s.volumes : []).map(v => (typeof v === 'string' ? v.split(':')[0] : String((v as { source?: string }).source ?? ''))).filter(v => v && !v.startsWith('.') && !v.startsWith('/') && !v.startsWith('~'));
    const ports = (Array.isArray(s.ports) ? s.ports : []).map(parsePort);
    if (ports.some(p => p.host === null && p.raw.includes(':'))) warnings.push(`${name}: a published port uses interpolation or a range; conflicts cannot be checked until it is a literal port.`);
    services.push({
      name,
      image: typeof s.image === 'string' ? s.image : null,
      build: s.build !== undefined,
      ports,
      healthcheck: Boolean(s.healthcheck && typeof s.healthcheck === 'object' && (s.healthcheck as { disable?: boolean }).disable !== true),
      volumes,
      dependsOn: deps,
      profiles: Array.isArray(s.profiles) ? s.profiles.map(String) : [],
    });
  }
  if (!services.length) warnings.push(`${path.basename(file)} declares no services.`);
  return { file, project, services, volumes: Object.keys((doc.volumes ?? {}) as object), warnings };
}

/** Resolve only repository-owned paths, checking every ancestor rather than just the leaf. */
export function scopedPath(root: string, file: string): string {
  root = path.resolve(root);
  const dest = path.resolve(root, file);
  const relative = path.relative(root, dest);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path escapes the approved project scope');
  const parts = relative ? relative.split(path.sep) : [];
  let current = root;
  for (const part of ['', ...parts]) {
    if (part) current = path.join(current, part);
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink()) throw new Error('Symlinks are not approved inputs or mounts');
  }
  return dest;
}

/** Capture bytes from a pinned descriptor; detect replacements, ancestor swaps and writes. */
export function readScopedBytes(root: string, file: string, max: number): Buffer {
  root = path.resolve(root);
  const dest = scopedPath(root, file);
  const chain: { file: string; stat: fs.Stats }[] = [];
  for (let current = dest; ; current = path.dirname(current)) {
    chain.push({ file: current, stat: fs.lstatSync(current) });
    if (current === root) break;
  }
  const before = chain[0].stat;
  if (!before.isFile() || before.nlink !== 1 || before.size > max) throw new Error('Input must be a bounded regular file with no hard links');
  const fd = fs.openSync(dest, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const same = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  try {
    if (!same(before, fs.fstatSync(fd))) throw new Error('Input changed while being captured');
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, count);
      if (!n) break;
      count += n;
    }
    if (count !== before.size || !same(before, fs.fstatSync(fd))) throw new Error('Input changed while being captured');
    for (const entry of chain) {
      const after = fs.lstatSync(entry.file);
      if (after.isSymbolicLink() || after.dev !== entry.stat.dev || after.ino !== entry.stat.ino) throw new Error('Input path changed while being captured');
    }
    if (!same(before, fs.lstatSync(dest))) throw new Error('Input changed while being captured');
    return bytes.subarray(0, count);
  } finally { fs.closeSync(fd); }
}

/** A deliberately bounded .dockerignore subset. Unsupported syntax fails closed, never guesses.
 * Root-relative literals, *, ?, ** and ordered ! rules are supported. We walk ignored directories
 * too, so an explicit re-inclusion cannot hide a secret. Docker still receives the original file.
 */
export function dockerIgnore(text: string): (file: string) => boolean {
  const rules = text.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => {
    let pattern = line.trim();
    const include = pattern.startsWith('!');
    if (include) pattern = pattern.slice(1);
    if (/[\[\]\\]/.test(pattern) || pattern.split('/').includes('..') || !pattern) throw new Error('Unsupported .dockerignore pattern; use root-relative literals, *, ?, ** and !');
    pattern = pattern.replace(/^\/+|\/+$/g, '');
    if (pattern === '.') return null;
    let source = '';
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === '*' && pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; source += '(?:.*/)?'; } else source += '.*';
      } else if (c === '*') source += '[^/]*';
      else if (c === '?') source += '[^/]';
      else source += c.replace(/[.*+?^${}()|\[\]\\]/g, '\\$&');
    }
    return { include, regex: new RegExp(`^${source}(?:/.*)?$`) };
  }).filter((r): r is { include: boolean; regex: RegExp } => r !== null);
  return file => {
    let ignored = false;
    for (const rule of rules) if (rule.regex.test(file)) ignored = !rule.include;
    return ignored;
  };
}

export function privateBuildPath(file: string): boolean {
  return file.split('/').some(part => /^(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.git-credentials|\.config|\.codex|\.agents|secrets?|credentials?(?:\..*)?|id_(?:rsa|ed25519)|\.npmrc|\.netrc|\.pypirc|\.docker)$/i.test(part))
    || /(?:\.(?:pem|key|p12|pfx|sqlite(?:3)?|db)|(?:^|[-_.])(?:password|token|credential|secret)(?:[-_.]|$))/i.test(path.basename(file));
}
