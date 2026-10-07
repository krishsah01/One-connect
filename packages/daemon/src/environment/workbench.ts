// SPDX-License-Identifier: Apache-2.0
// Project Docker workbench. Every Compose command carries this project's exact name, directory
// and files; containers are controllable only when their Compose labels match that binding.
// Mutations need a human decision bound to the reviewed Compose/Dockerfile bytes (not only
// argv paths), which expires after two minutes and can be used once. On approval the binding
// is re-read; if content changed the approval is refused. Execution uses an immutable snapshot
// of the verified bytes so nothing can change between check and `docker compose`. Images are
// never pulled implicitly (`up --pull never`).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import YAML from 'yaml';
import { HUMAN, newId, type Decision } from '@acc/core';
import { run, type ExecOptions, type ExecResult } from '../exec.ts';
import type { Daemon } from '../daemon.ts';
import type { AnswerOptions } from '../decisions.ts';
import { writePrivate } from '../paths.ts';
import { dockerIgnore, privateBuildPath, readBounded, readScopedBytes, scopedPath, findComposeFile, normalizeComposeProject, parseCompose, type ComposeFile, type ComposeService } from './compose.ts';
import { DatabaseFiles, DatabaseSpecError, parseDatabaseSpec, postgresImage, volumeName, type DatabaseRecord, type PostgresSpec } from './database.ts';

export type DockerExec = (args: string[], o?: Pick<ExecOptions, 'timeoutMs' | 'maxBytes' | 'signal'>) => Promise<ExecResult>;
export type ComposeAction = 'up' | 'stop' | 'restart' | 'build' | 'pull' | 'down';
export const COMPOSE_ACTIONS: readonly ComposeAction[] = ['up', 'stop', 'restart', 'build', 'pull', 'down'];
const APPROVAL_MS = 120_000;
const LOG_LIMIT = 128 * 1024;
const NETWORK_ACTIONS: readonly ComposeAction[] = ['build', 'pull'];
const TIMEOUTS: Record<ComposeAction, number> = { up: 5 * 60_000, stop: 2 * 60_000, restart: 2 * 60_000, down: 2 * 60_000, build: 30 * 60_000, pull: 30 * 60_000 };

export class EnvironmentError extends Error {
  status: number;
  statusCode: number;
  constructor(message: string, status = 400) { super(message); this.status = status; this.statusCode = status; }
}

export interface DockerAvailability { installed: boolean; engine: boolean; compose: boolean; local: boolean; version: string | null; composeVersion: string | null; endpoint: string | null; error: string | null }
export interface ServiceStatus {
  name: string; source: 'project' | 'database'; image: string | null; build: boolean; declaredHealthcheck: boolean;
  container: { id: string; name: string; state: string; health: string | null; healthLog: string | null; startedAt: string | null; image: string } | null;
  readiness: 'ready' | 'running-unchecked' | 'starting' | 'unhealthy' | 'stopped' | 'not-created';
  readinessDetail: string;
  imagePresent: boolean | null;
  ports: { host: number | null; container: number | null; hostIp: string | null; conflict: string | null }[];
  volumes: string[];
}
export interface EnvironmentJob { id: string; decisionId: string; action: ComposeAction; services: string[]; argv: string[]; state: 'running' | 'succeeded' | 'failed' | 'interrupted'; exitCode: number | null; output: string; startedAt: string; endedAt: string | null }
interface ComposeBinding {
  project: string;
  repo: string;
  action: ComposeAction;
  services: string[];
  files: { path: string; sha256: string; content: string }[];
  inputs: { path: string; bytes: Buffer; mode: number }[];
  builds: { service: string; context: string; dockerfile: string; entries: { relative: string; bytes: Buffer; mode: number; directory?: boolean }[] }[];
  document: Settings;
  scope: string[];
}
interface PendingAction { argv: string[]; digest: string; action: ComposeAction; services: string[]; expires: number; consumed: boolean; network: boolean; snapshotDir?: string }
interface Inspected { Id: string; Name: string; Config: { Image: string; Labels: Record<string, string> | null }; State: { Status: string; StartedAt?: string; Health?: { Status: string; Log?: { Output: string }[] } } }

type Settings = Record<string, any>;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 2000;
const SERVICE_KEYS = new Set('image build command entrypoint environment env_file ports volumes healthcheck depends_on restart profiles labels working_dir user init tty stdin_open hostname stop_signal stop_grace_period expose networks secrets configs mem_limit cpus read_only tmpfs shm_size cap_drop security_opt'.split(' '));
const BUILD_KEYS = new Set('context dockerfile args target platforms network pull no_cache labels'.split(' '));
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export function portInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE' || e.code === 'EACCES'));
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(false)));
  });
}

/** Host ports published by containers outside this project, from `docker ps` Ports text. */
function publishedPorts(line: { Names?: string; Ports?: string; Labels?: string }): number[] {
  return [...String(line.Ports ?? '').matchAll(/(?:[\d.]+|\[[^\]]*\]|::):(\d+)->/g)].map(m => Number(m[1]));
}

export class ProjectEnvironment {
  readonly d: Daemon;
  readonly exec: DockerExec;
  readonly portProbe: (port: number) => Promise<boolean>;
  readonly files: DatabaseFiles;
  private readonly clock: () => number;
  private jobs: EnvironmentJob[];
  private controllers = new Set<AbortController>();
  private tasks = new Set<Promise<void>>();
  private resolving = new Set<string>();
  private closing = false;
  private availabilityCache: { at: number; value: DockerAvailability } | null = null;

  constructor(d: Daemon, o: { exec?: DockerExec; portProbe?: (port: number) => Promise<boolean>; now?: () => number } = {}) {
    this.d = d;
    this.exec = o.exec ?? ((args, x) => {
      // Compose must not discover override files, implicit .env files, profiles or inherited values.
      const env = Object.fromEntries(Object.entries(this.d.baseEnv()).filter(([key]) => ['PATH', 'HOME', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'SSH_AUTH_SOCK'].includes(key)));
      return run('docker', args, { cwd: this.repo, timeoutMs: x?.timeoutMs ?? 20_000, maxBytes: x?.maxBytes ?? 512 * 1024, signal: x?.signal, env: { ...env, DOCKER_CLI_HINTS: 'false', COMPOSE_DISABLE_ENV_FILE: 'true' } });
    });
    this.portProbe = o.portProbe ?? (p => portInUse(p));
    this.clock = o.now ?? Date.now;
    this.files = new DatabaseFiles(d.paths.root);
    const saved = JSON.parse(d.store.kvGet('environment:jobs') ?? '[]') as EnvironmentJob[];
    // A job cannot survive the daemon that awaited it; report it honestly instead of guessing.
    this.jobs = saved.map(j => j.state === 'running' ? { ...j, state: 'interrupted', output: `${j.output}\n[daemon restarted before this action reported a result; check service status]`, endedAt: j.endedAt ?? d.nowIso() } : j);
    this.saveJobs();
    this.cleanupSnapshots();
    for (const r of this.databases()) if (r.spec.kind === 'postgres') { const p = this.files.readSecret(r.spec.service); if (p) d.addSecret(p); }
  }

  // ---- binding -----------------------------------------------------------------------------

  get project(): string { return normalizeComposeProject(this.d.config.project.docker_project ?? this.d.config.project.name); }
  get repo(): string { return this.d.config.project.repo; }

  databases(): DatabaseRecord[] { return JSON.parse(this.d.store.kvGet('environment:databases') ?? '[]'); }

  /** The project's own compose file (inside the repository) plus the generated database file. */
  composeFiles(): { project: ComposeFile | null; generated: ComposeFile | null; errors: string[] } {
    const errors: string[] = [];
    let project: ComposeFile | null = null, generated: ComposeFile | null = null;
    const file = fs.existsSync(this.repo) ? findComposeFile(this.repo) : null;
    if (file) { try { project = parseCompose(file, this.project); } catch (e) { errors.push((e as Error).message); } }
    if (fs.existsSync(this.files.composeFile)) { try { generated = parseCompose(this.files.composeFile, this.project); } catch (e) { errors.push((e as Error).message); } }
    return { project, generated, errors };
  }

  baseArgs(): string[] {
    const { project, generated } = this.composeFiles();
    const files = [project?.file, generated?.file].filter((f): f is string => Boolean(f));
    if (!files.length) throw new EnvironmentError('This project has no Compose file. Add compose.yaml to the repository or create a database with the wizard.', 409);
    return ['compose', '--project-name', this.project, '--project-directory', this.repo, ...files.flatMap(f => ['-f', f])];
  }

  // ---- reads -------------------------------------------------------------------------------

  async availability(force = false): Promise<DockerAvailability> {
    if (!force && this.availabilityCache && this.clock() - this.availabilityCache.at < 10_000) return this.availabilityCache.value;
    const out: DockerAvailability = { installed: false, engine: false, compose: false, local: false, version: null, composeVersion: null, endpoint: null, error: null };
    const v = await this.exec(['version', '--format', '{{json .}}'], { timeoutMs: 8000 });
    if (v.code === null && /ENOENT/.test(v.error ?? '')) { out.error = 'Docker is not installed. Install Docker Desktop yourself to use the workbench; One Connect never installs it.'; return this.cache(out); }
    out.installed = true;
    try {
      const j = JSON.parse(v.stdout.trim().split('\n')[0] || '{}') as { Client?: { Version?: string }; Server?: { Version?: string } | null };
      out.version = j.Server?.Version ?? j.Client?.Version ?? null;
      out.engine = Boolean(j.Server?.Version) && v.code === 0;
    } catch { out.engine = false; }
    if (!out.engine) { out.error = v.timedOut ? 'Docker did not answer within 8 seconds.' : 'Docker is installed but its engine is not running. Start Docker Desktop.'; return this.cache(out); }
    const c = await this.exec(['compose', 'version', '--short'], { timeoutMs: 8000 });
    out.compose = c.code === 0;
    out.composeVersion = out.compose ? c.stdout.trim() : null;
    const ctx = await this.exec(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], { timeoutMs: 8000 });
    const envHost = this.d.baseEnv().DOCKER_HOST;
    // DOCKER_CONTEXT takes precedence over DOCKER_HOST in the CLI itself.
    let endpoint: string | null = this.d.baseEnv().DOCKER_CONTEXT ? null : envHost ?? null;
    if (!endpoint && ctx.code === 0) { try { endpoint = JSON.parse(ctx.stdout.trim()); } catch { endpoint = null; } }
    out.endpoint = endpoint;
    out.local = endpoint !== null && /^(unix|npipe):\/\//.test(endpoint);
    if (!out.compose) out.error = 'Docker Compose v2 is not available (`docker compose`).';
    else if (!out.local) out.error = `Docker endpoint ${endpoint ?? 'unknown'} is not a local socket. One Connect only changes a local engine, so it cannot touch shared or production hosts.`;
    return this.cache(out);
  }

  private cache(value: DockerAvailability) { this.availabilityCache = { at: this.clock(), value }; return value; }

  private async containers(): Promise<{ bound: Inspected[]; foreign: { id: string; name: string; workingDir: string | null }[] }> {
    const ps = await this.exec(['ps', '-a', '--no-trunc', '--filter', `label=com.docker.compose.project=${this.project}`, '--format', '{{.ID}}']);
    if (ps.code !== 0) throw new EnvironmentError(this.d.redactText(ps.stderr.trim() || ps.error || 'docker ps failed'), 502);
    const ids = ps.stdout.split('\n').map(s => s.trim()).filter(id => /^[a-f0-9]{12,64}$/.test(id));
    if (!ids.length) return { bound: [], foreign: [] };
    const r = await this.exec(['inspect', '--type', 'container', ...ids]);
    if (r.code !== 0) throw new EnvironmentError('docker inspect failed', 502);
    const all = JSON.parse(r.stdout) as Inspected[];
    let repo: string | null = null;
    try { repo = fs.realpathSync(this.repo); } catch { /* every container is then foreign */ }
    const bound: Inspected[] = [], foreign: { id: string; name: string; workingDir: string | null }[] = [];
    for (const c of all) {
      const labels = c.Config.Labels ?? {};
      const wd = labels['com.docker.compose.project.working_dir'] ?? null;
      let same = false;
      try { same = wd !== null && repo !== null && fs.realpathSync(wd) === repo; } catch { same = false; }
      if (labels['com.docker.compose.project'] === this.project && same) bound.push(c);
      else foreign.push({ id: c.Id.slice(0, 12), name: c.Name.replace(/^\//, ''), workingDir: wd });
    }
    return { bound, foreign };
  }

  private async imagePresent(image: string): Promise<boolean> {
    const r = await this.exec(['image', 'inspect', '--format', '{{.Id}}', image], { timeoutMs: 10_000 });
    return r.code === 0;
  }

  async status(refresh = false) {
    const availability = await this.availability(refresh);
    const files = this.composeFiles();
    const declared: (ComposeService & { source: 'project' | 'database' })[] = [
      ...(files.project?.services ?? []).map(s => ({ ...s, source: 'project' as const })),
      ...(files.generated?.services ?? []).map(s => ({ ...s, source: 'database' as const })),
    ];
    const base = { project: this.project, repo: this.repo, files: [files.project?.file, files.generated?.file].filter(Boolean), warnings: [...files.errors, ...(files.project?.warnings ?? [])], databases: this.connections(), jobs: this.jobs.slice(-10).reverse(), approvalSeconds: APPROVAL_MS / 1000 };
    if (!availability.engine) return { availability, ...base, services: declared.map(s => this.serviceStatus(s, null, null, [])), foreign: [] };
    const { bound, foreign } = await this.containers();
    const others = await this.exec(['ps', '--format', '{{json .}}']);
    const ownIds = new Set(bound.map(c => c.Id));
    const otherPorts = new Map<number, string>();
    if (others.code === 0) for (const line of others.stdout.split('\n').filter(Boolean)) {
      try {
        const row = JSON.parse(line) as { ID: string; Names?: string; Ports?: string };
        if ([...ownIds].some(id => id.startsWith(row.ID))) continue;
        for (const p of publishedPorts(row)) otherPorts.set(p, row.Names ?? row.ID);
      } catch { /* skip malformed row */ }
    }
    const images = new Map<string, boolean>();
    for (const s of declared) if (s.image && !s.build && !images.has(s.image)) images.set(s.image, await this.imagePresent(s.image));
    const hostPorts = declared.flatMap(s => s.ports.map(p => p.host).filter((p): p is number => p !== null));
    const services: ServiceStatus[] = [];
    for (const s of declared) {
      const c = bound.find(x => x.Config.Labels?.['com.docker.compose.service'] === s.name) ?? null;
      const conflicts: (string | null)[] = [];
      for (const p of s.ports) {
        if (p.host === null) { conflicts.push(null); continue; }
        if (hostPorts.filter(h => h === p.host).length > 1) { conflicts.push(`Host port ${p.host} is declared by more than one service in this project.`); continue; }
        if (otherPorts.has(p.host)) { conflicts.push(`Host port ${p.host} is published by another container (${otherPorts.get(p.host)}).`); continue; }
        const ours = c?.State.Status === 'running';
        conflicts.push(!ours && (await this.portProbe(p.host)) ? `Host port ${p.host} is already in use by another process on this Mac.` : null);
      }
      services.push(this.serviceStatus(s, c, s.image && !s.build ? images.get(s.image) ?? null : null, conflicts));
    }
    return { availability, ...base, services, foreign };
  }

  private serviceStatus(s: ComposeService & { source: 'project' | 'database' }, c: Inspected | null, imagePresent: boolean | null, conflicts: (string | null)[]): ServiceStatus {
    const health = c?.State.Health?.Status ?? null;
    const state = c?.State.Status ?? null;
    let readiness: ServiceStatus['readiness'], readinessDetail: string;
    if (!c) { readiness = 'not-created'; readinessDetail = 'No container yet.'; }
    else if (state !== 'running') { readiness = 'stopped'; readinessDetail = `Container is ${state}.`; }
    else if (health === 'healthy') { readiness = 'ready'; readinessDetail = 'Healthcheck passing.'; }
    else if (health === 'starting') { readiness = 'starting'; readinessDetail = 'Healthcheck has not passed yet.'; }
    else if (health === 'unhealthy') { readiness = 'unhealthy'; readinessDetail = 'Healthcheck failing.'; }
    else { readiness = 'running-unchecked'; readinessDetail = 'Running, but no healthcheck is declared, so readiness is unknown.'; }
    const log = c?.State.Health?.Log?.at(-1)?.Output ?? null;
    return {
      name: s.name, source: s.source, image: s.image, build: s.build, declaredHealthcheck: s.healthcheck,
      container: c ? { id: c.Id.slice(0, 12), name: c.Name.replace(/^\//, ''), state: state!, health, healthLog: log ? this.d.redactText(log.slice(-500)) : null, startedAt: c.State.StartedAt ?? null, image: c.Config.Image } : null,
      readiness, readinessDetail, imagePresent,
      ports: s.ports.map((p, i) => ({ host: p.host, container: p.container, hostIp: p.hostIp, conflict: conflicts[i] ?? null })),
      volumes: s.volumes.map(v => `${this.project}_${v}`),
    };
  }

  private declaredServices(): string[] {
    const f = this.composeFiles();
    return [...(f.project?.services ?? []), ...(f.generated?.services ?? [])].map(s => s.name);
  }

  async logs(service: string) {
    if (!this.declaredServices().includes(service)) throw new EnvironmentError('Unknown service for this project', 404);
    const r = await this.exec([...this.baseArgs(), 'logs', '--no-color', '--timestamps', '--tail', '300', service], { timeoutMs: 15_000, maxBytes: 2 * LOG_LIMIT });
    const text = this.d.redactText(r.stdout + r.stderr);
    const truncated = Buffer.byteLength(text) > LOG_LIMIT;
    return { service, text: truncated ? text.slice(-LOG_LIMIT) : text, truncated, exitCode: r.code, limit: 'last 300 lines, at most 128 KiB' };
  }

  // ---- gated actions -----------------------------------------------------------------------

  /** Captured buffers are the sole source for both the approval digest and executable inputs. */
  private readComposeBinding(action: ComposeAction, serviceNames: string[]): ComposeBinding {
    try {
      const repo = fs.realpathSync(this.repo);
      const files: ComposeBinding['files'] = [];
      const inputs: ComposeBinding['inputs'] = [];
      const builds: ComposeBinding['builds'] = [];
      const document: Settings = { services: {} };
      let inputBytes = 0, inputEntries = 0;
      const account = (bytes: number) => {
        inputBytes += bytes; inputEntries++;
        if (inputEntries > MAX_FILES || inputBytes > MAX_INPUT_BYTES) throw new Error('Approved inputs exceed 2000 entries or 64 MiB');
      };
      const source = new Map<string, string>();
      const projectFile = findComposeFile(repo);
      const candidates = [projectFile, fs.existsSync(this.files.composeFile) ? this.files.composeFile : null].filter((f): f is string => Boolean(f));
      if (!candidates.length) throw new Error('No Compose files');
      for (const file of candidates) {
        const root = file === projectFile ? repo : this.files.dir;
        const content = readScopedBytes(root, file, 256 * 1024).toString('utf8');
        files.push({ path: file, sha256: sha(content), content });
        const doc = YAML.parse(content, { maxAliasCount: 50 }) as Settings;
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Compose must be a mapping');
        for (const key of Object.keys(doc)) {
          if (!['name', 'services', 'volumes', 'networks', 'secrets', 'configs'].includes(key) && !key.startsWith('x-')) throw new Error(`Unsupported Compose field ${key}`);
        }
        for (const [name, svc] of Object.entries(doc.services ?? {})) {
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || document.services[name]) throw new Error('Invalid or duplicate Compose service');
          document.services[name] = svc;
          source.set(name, file);
        }
        for (const key of ['volumes', 'networks', 'secrets', 'configs']) {
          for (const [name, value] of Object.entries(doc[key] ?? {})) {
            document[key] ??= {};
            if (name in document[key]) throw new Error(`Duplicate ${key} definition`);
            document[key][name] = value;
          }
        }
      }
      const scope = serviceNames.length ? [...serviceNames] : Object.keys(document.services).filter(name => !document.services[name]?.profiles?.length);
      if (!scope.length || scope.some(s => !source.has(s))) throw new Error('Service scope changed');
      document.services = Object.fromEntries(scope.map(name => [name, document.services[name]]));
      const used: Record<string, Set<string>> = Object.fromEntries(['volumes', 'networks', 'secrets', 'configs'].map(k => [k, new Set<string>()]));
      const capture = (root: string, file: string) => {
        const dest = scopedPath(root, file);
        if (!inputs.some(i => i.path === dest)) {
          const bytes = readScopedBytes(root, dest, 256 * 1024);
          account(bytes.length);
          inputs.push({ path: dest, bytes, mode: 0o400 });
        }
        return dest;
      };
      const literals = (value: unknown) => {
        if (typeof value === 'string' && /\$(?:\{|[A-Za-z_])/.test(value.replace(/\$\$/g, ''))) throw new Error('Compose interpolation and inherited environment are not sealed; use literal settings and explicit env_file values');
        if (Array.isArray(value)) value.forEach(literals);
        else if (value && typeof value === 'object') Object.values(value).forEach(literals);
      };
      for (const name of scope) {
        const svc = document.services[name] as Settings;
        if (!svc || typeof svc !== 'object' || Array.isArray(svc)) throw new Error('Service must be a mapping');
        for (const key of Object.keys(svc)) if (!SERVICE_KEYS.has(key) && !key.startsWith('x-')) throw new Error(`Unsupported or unsafe service field ${name}.${key}`);
        literals(svc);
        if (svc.security_opt && (!Array.isArray(svc.security_opt) || svc.security_opt.some((s: unknown) => s !== 'no-new-privileges:true'))) throw new Error('Only no-new-privileges:true is allowed');
        const deps = Array.isArray(svc.depends_on) ? svc.depends_on : Object.keys(svc.depends_on ?? {});
        if (deps.some((dep: string) => !scope.includes(dep))) throw new Error('Dependencies must be explicitly included in the approved service scope');
        if (Array.isArray(svc.environment)) {
          if (svc.environment.some((e: unknown) => typeof e !== 'string' || !e.includes('='))) throw new Error('Inherited environment is not approved; supply explicit values');
        } else if (svc.environment && Object.values(svc.environment).some(v => v === null)) throw new Error('Inherited environment is not approved; supply explicit values');
        if (svc.env_file) {
          svc.env_file = (Array.isArray(svc.env_file) ? svc.env_file : [svc.env_file]).map((entry: unknown) => {
            const raw = typeof entry === 'string' ? { path: entry } : entry as Settings;
            if (!raw || typeof raw.path !== 'string' || Object.keys(raw).some(k => !['path', 'required', 'format'].includes(k))) throw new Error('Unsupported env_file');
            const dest = path.resolve(repo, raw.path);
            if (raw.required === false && !fs.existsSync(dest)) throw new Error('Optional missing env files cannot be sealed');
            const file = capture(repo, dest);
            // Keep Compose env-file parsing, but never let it read the host interpolation environment.
            if (raw.format !== 'raw') literals(inputs.find(i => i.path === file)!.bytes.toString('utf8'));
            return { ...raw, path: file };
          });
        }
        svc.volumes = (svc.volumes ?? []).map((entry: unknown) => {
          const raw: Settings = typeof entry === 'string' ? (() => {
            const parts = entry.split(':');
            if (parts.length > 3) throw new Error('Unsupported volume syntax');
            if (parts.length === 1) return { type: 'volume', target: parts[0] };
            const [src, target, options] = parts;
            if (options && !['ro', 'rw'].includes(options)) throw new Error('Unsupported volume options');
            return { type: src.startsWith('.') || path.isAbsolute(src) ? 'bind' : 'volume', source: src, target, read_only: options === 'ro' };
          })() : entry as Settings;
          if (!raw || Object.keys(raw).some(k => !['type', 'source', 'target', 'read_only', 'bind', 'volume'].includes(k))) throw new Error('Unsupported volume');
          if (raw.type === 'bind') {
            if (typeof raw.source !== 'string' || raw.bind && Object.keys(raw.bind).some(k => k !== 'create_host_path')) throw new Error('Unsupported bind mount');
            const dest = scopedPath(repo, raw.source);
            if (privateBuildPath(path.relative(repo, dest).split(path.sep).join('/')) || /(?:^|\/)docker\.sock$/.test(dest) || ![true, false, undefined].includes(raw.read_only)) throw new Error('Private paths and Docker sockets cannot be mounted');
            let visited = 0;
            const checkMount = (file: string) => {
              if (++visited > 20_000) throw new Error('Bind mount traversal exceeds 20000 entries');
              scopedPath(repo, file);
              const stat = fs.lstatSync(file);
              if (stat.isDirectory()) for (const child of fs.readdirSync(file)) checkMount(path.join(file, child));
              else if (!stat.isFile() || stat.nlink !== 1) throw new Error('Bind mounts cannot include sockets, special files or hard links');
            };
            checkMount(dest);
            return { ...raw, source: dest, bind: { create_host_path: false } };
          }
          if (raw.type !== 'volume') throw new Error('Only project binds and named volumes are supported');
          if (raw.volume && Object.keys(raw.volume).some(k => k !== 'nocopy')) throw new Error('Volume subpaths and driver options are refused');
          if (raw.source) used.volumes.add(raw.source);
          return raw;
        });
        for (const key of ['networks', 'secrets', 'configs']) {
          for (const ref of Array.isArray(svc[key]) ? svc[key] : Object.keys(svc[key] ?? {})) used[key].add(typeof ref === 'string' ? ref : ref.source);
        }
        if (svc.build !== undefined) {
          const raw: Settings = typeof svc.build === 'string' ? { context: svc.build } : svc.build;
          if (!raw || typeof raw !== 'object' || Object.keys(raw).some(k => !BUILD_KEYS.has(k))) throw new Error('Unsupported build inputs (remote contexts, SSH, secrets, extra contexts, caches and entitlements are refused)');
          if (raw.network && !['default', 'none'].includes(raw.network)) throw new Error('Host build networking is refused');
          if (raw.args && this.d.denylist().some(secret => secret.length >= 6 && JSON.stringify(raw.args).includes(secret))) throw new Error('Secret build arguments are refused');
          if (raw.args && (Array.isArray(raw.args) ? raw.args.some((a: unknown) => typeof a !== 'string' || !a.includes('=')) : Object.values(raw.args).some(v => v === null))) throw new Error('Inherited build arguments are refused');
          const ctx = raw.context ?? '.';
          const df = raw.dockerfile ?? 'Dockerfile';
          if (typeof ctx !== 'string' || typeof df !== 'string' || /^(?:[a-z]+:\/\/|git@|~)/i.test(ctx)) throw new Error('Only local scoped build contexts are supported');
          const context = scopedPath(repo, ctx);
          if (!fs.lstatSync(context).isDirectory()) throw new Error('Build context must be a directory');
          if (privateBuildPath(path.relative(repo, context).split(path.sep).join('/'))) throw new Error('Private directories cannot be build contexts');
          const dockerfile = scopedPath(context, df);
          const dockerfileBytes = readScopedBytes(context, dockerfile, 256 * 1024);
          if (/--(?:network=host|security=insecure)(?:\s|$)/i.test(dockerfileBytes.toString('utf8'))) throw new Error('Privileged Dockerfile instructions are refused');
          const specificIgnore = `${dockerfile}.dockerignore`;
          const ignoreFile = fs.existsSync(specificIgnore) ? specificIgnore : path.join(context, '.dockerignore');
          const ignoreBytes = fs.existsSync(ignoreFile) ? readScopedBytes(context, ignoreFile, 256 * 1024) : Buffer.alloc(0);
          const ignored = dockerIgnore(ignoreBytes.toString('utf8'));
          const entries: ComposeBinding['builds'][number]['entries'] = [];
          let visited = 0;
          const walk = (dir: string) => {
            scopedPath(context, dir);
            const before = fs.lstatSync(dir);
            for (const child of fs.readdirSync(dir).sort()) {
              if (++visited > 20_000) throw new Error('Build context traversal exceeds 20000 entries');
              const file = path.join(dir, child), relative = path.relative(context, file).split(path.sep).join('/');
              const st = fs.lstatSync(file);
              // Ignore rules are evaluated before reads; ignored symlinks/credentials are never followed.
              if (st.isDirectory()) {
                if (!ignored(relative)) {
                  if (privateBuildPath(relative)) throw new Error('Build context includes private/secret files; exclude them explicitly with .dockerignore');
                  account(0);
                  entries.push({ relative, bytes: Buffer.alloc(0), mode: 0o555, directory: true });
                }
                walk(file); continue;
              }
              const forced = file === dockerfile || file === ignoreFile;
              if (ignored(relative) && !forced) continue;
              if (privateBuildPath(relative)) throw new Error('Build context includes private/secret files; exclude them explicitly with .dockerignore');
              const bytes = file === dockerfile ? dockerfileBytes : file === ignoreFile ? ignoreBytes : readScopedBytes(context, file, MAX_FILE_BYTES);
              if (this.d.denylist().some(secret => secret.length >= 6 && bytes.includes(Buffer.from(secret))) || /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:AWS_SECRET_ACCESS_KEY|(?:PASSWORD|TOKEN|SECRET|API_KEY))\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{8,}/i.test(bytes.toString('utf8'))) throw new Error('Build context includes secret content');
              account(bytes.length);
              entries.push({ relative, bytes, mode: 0o444 | (st.mode & 0o111) });
            }
            const after = fs.lstatSync(dir);
            if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs) throw new Error('Build context changed while being captured');
          };
          walk(context);
          builds.push({ service: name, context, dockerfile, entries });
          svc.build = { ...raw, context, dockerfile: path.relative(context, dockerfile) };
        }
      }
      if (document.networks?.default && Object.values(document.services).some(svc => !(svc as Settings).networks)) used.networks.add('default');
      for (const key of Object.keys(used)) {
        const definitions: Settings = {};
        for (const name of [...used[key]].sort()) {
          const value = document[key]?.[name];
          if (value === undefined) throw new Error(`Missing ${key} definition`);
          const def = value ?? {};
          literals(def);
          if (key === 'volumes' && Object.keys(def).some(k => k !== 'labels')) throw new Error('External volumes and volume drivers are refused');
          if (key === 'networks' && Object.keys(def).some(k => !['driver', 'internal', 'labels', 'enable_ipv6'].includes(k)) || key === 'networks' && def.driver && def.driver !== 'bridge') throw new Error('External or host networks are refused');
          if (key === 'configs' || key === 'secrets') {
            if (typeof def.file !== 'string' || Object.keys(def).some(k => k !== 'file')) throw new Error('Only scoped file configs/secrets are supported');
            const root = key === 'secrets' && this.databases().some(r => r.spec.kind === 'postgres' && def.file === this.files.secretFile(r.spec.service)) ? this.files.dir : repo;
            def.file = capture(root, def.file);
          }
          definitions[name] = def;
        }
        if (Object.keys(definitions).length) document[key] = definitions;
        else delete document[key];
      }
      return { project: this.project, repo, action, services: [...serviceNames], files, inputs, builds, document, scope };
    } catch (e) { throw new EnvironmentError(`Cannot seal Compose content: ${(e as Error).message}`, 409); }
  }

  private digestOf(binding: ComposeBinding): string {
    return sha(JSON.stringify({
      project: binding.project, repo: binding.repo, action: binding.action, services: binding.services,
      files: binding.files.map(f => ({ path: f.path, sha256: f.sha256 })),
      inputs: binding.inputs.map(i => ({ path: i.path, sha256: sha(i.bytes), mode: i.mode })),
      builds: binding.builds.map(b => ({ service: b.service, context: b.context, dockerfile: b.dockerfile, entries: b.entries.map(e => ({ path: e.relative, sha256: sha(e.bytes), mode: e.mode, directory: e.directory ?? false })) })),
      document: binding.document,
    }));
  }

  private removeSnapshot(dir: string) {
    if (path.dirname(dir) !== path.join(this.files.dir, 'approval-snapshots')) return;
    scopedPath(this.files.dir, path.dirname(dir));
    const thaw = (current: string) => {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      fs.chmodSync(current, 0o700);
      for (const child of fs.readdirSync(current)) thaw(path.join(current, child));
    };
    if (fs.existsSync(dir)) { thaw(dir); fs.rmSync(dir, { recursive: true, force: true }); }
  }

  private cleanupSnapshots() {
    const root = path.join(this.files.dir, 'approval-snapshots');
    if (!fs.existsSync(root)) return;
    scopedPath(this.files.dir, root);
    for (const name of fs.readdirSync(root)) this.removeSnapshot(path.join(root, name));
  }

  /** Relocate only immutable build/env/config inputs. Binds still resolve against the repo;
   * --project-directory stays there to retain Compose identity and project-owned volumes. */
  private materializeSnapshot(binding: ComposeBinding, decisionId: string): { dir: string; composeFiles: string[]; envFile: string } {
    const root = path.join(this.files.dir, 'approval-snapshots');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    scopedPath(this.files.dir, root);
    const dir = fs.mkdtempSync(path.join(root, `${decisionId}-`));
    try {
      const document = structuredClone(binding.document);
      const locations = new Map<string, string>();
      const write = (file: string, bytes: Buffer, mode = 0o400) => {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, bytes, { flag: 'wx', mode });
        fs.chmodSync(file, mode);
      };
      for (const [i, input] of binding.inputs.entries()) {
        const dest = path.join(dir, 'inputs', String(i));
        write(dest, input.bytes);
        locations.set(input.path, dest);
      }
      for (const [i, build] of binding.builds.entries()) {
        const context = path.join(dir, 'builds', String(i));
        fs.mkdirSync(context, { recursive: true, mode: 0o700 });
        for (const entry of build.entries) {
          if (entry.directory) fs.mkdirSync(path.join(context, entry.relative), { recursive: true, mode: 0o700 });
          else write(path.join(context, entry.relative), entry.bytes, entry.mode);
        }
        document.services[build.service].build.context = context;
      }
      for (const svc of Object.values(document.services) as Settings[]) {
        if (svc.env_file) for (const entry of svc.env_file) entry.path = locations.get(entry.path);
      }
      for (const key of ['secrets', 'configs']) for (const def of Object.values(document[key] ?? {}) as Settings[]) def.file = locations.get(def.file);
      const composeFile = path.join(dir, 'compose.yaml');
      const envFile = path.join(dir, 'empty.env');
      write(composeFile, Buffer.from(YAML.stringify(document)));
      write(envFile, Buffer.alloc(0));
      const seal = (current: string) => {
        if (!fs.statSync(current).isDirectory()) return;
        for (const child of fs.readdirSync(current)) seal(path.join(current, child));
        fs.chmodSync(current, 0o500);
      };
      seal(dir);
      return { dir, composeFiles: [composeFile], envFile };
    } catch (e) { this.removeSnapshot(dir); throw e; }
  }

  private argvForSnapshot(composeFiles: string[], envFile: string, action: ComposeAction, services: string[]): string[] {
    const tail: Record<ComposeAction, string[]> = { up: ['up', '--detach', '--no-deps', '--no-build', '--pull', 'never'], stop: ['stop'], restart: ['restart', '--no-deps'], build: ['build'], pull: ['pull'], down: ['down'] };
    return ['docker', 'compose', '--project-name', this.project, '--project-directory', fs.realpathSync(this.repo), '--env-file', envFile, ...composeFiles.flatMap(f => ['-f', f]), ...tail[action], ...services];
  }

  commandFor(action: ComposeAction, services: string[]): string[] {
    if (!COMPOSE_ACTIONS.includes(action)) throw new EnvironmentError('Unsupported Docker action');
    const known = this.declaredServices();
    for (const s of services) if (!known.includes(s)) throw new EnvironmentError(`Service ${s} is not declared in this project`, 404);
    if (action === 'down' && services.length) throw new EnvironmentError('Down applies to the whole project; volumes are kept.');
    const tail: Record<ComposeAction, string[]> = { up: ['up', '--detach', '--no-deps', '--no-build', '--pull', 'never'], stop: ['stop'], restart: ['restart', '--no-deps'], build: ['build'], pull: ['pull'], down: ['down'] };
    return ['docker', ...this.baseArgs(), ...tail[action], ...services];
  }

  /** Reasons a prepared action would fail or reach the network unexpectedly, shown before approval. */
  async blockers(action: ComposeAction, services: string[]): Promise<string[]> {
    const a = await this.availability(true);
    if (!a.engine || !a.compose || !a.local) return [a.error ?? 'Docker is unavailable'];
    if (action !== 'up') return [];
    const s = await this.status();
    const targets = s.services.filter(x => !services.length || services.includes(x.name));
    return [
      ...targets.filter(x => x.imagePresent === false).map(x => `${x.name}: image ${x.image} is not present locally. Approve a separate pull first; up never pulls.`),
      ...targets.flatMap(x => x.ports.map(p => p.conflict).filter((c): c is string => Boolean(c)).map(c => `${x.name}: ${c}`)),
    ];
  }

  async request(actionInput: string, servicesInput: unknown = []) {
    if (this.closing) throw new EnvironmentError('Environment is shutting down', 409);
    const action = actionInput as ComposeAction;
    const services = Array.isArray(servicesInput) ? [...new Set(servicesInput.map(String))] : [];
    const argv = this.commandFor(action, services);
    const binding = this.readComposeBinding(action, services);
    const blockers = await this.blockers(action, binding.scope);
    if (blockers.length) return { decision: null, argv, blockers };
    const network = NETWORK_ACTIONS.includes(action);
    const digest = this.digestOf(binding);
    const decision: Decision = { id: newId('decision'), question: `Run ${argv.join(' ')}?${network ? ' This explicitly permits network access for this build/pull only.' : ''}`, options: ['approve', 'deny'], recommendation: null, evidenceLinks: [], urgency: 'normal', irreversible: action === 'down', answer: null, answeredAt: null, channel: null, createdAt: this.d.nowIso(), kind: 'environment', confirmOptions: action === 'down' || network ? ['approve'] : [], risk: action === 'down' || network ? 'high' : 'medium' };
    const pending: PendingAction = { argv, digest, action, services, expires: this.clock() + APPROVAL_MS, consumed: false, network };
    this.d.commit([{ type: 'decision.created', actor: HUMAN, data: { decision } }], [], () => this.d.store.kvSet(`env-action:${decision.id}`, JSON.stringify(pending)));
    return { decision, argv, digest, network, expiresAt: new Date(pending.expires).toISOString(), blockers: [] };
  }

  async resolve(decisionId: string, answer: string, digest: string, o: AnswerOptions = {}) {
    if (this.closing || this.resolving.has(decisionId)) throw new EnvironmentError('Approval already being resolved or environment shutting down', 409);
    this.resolving.add(decisionId);
    let snapshotDir: string | undefined;
    try {
      const raw = this.d.store.kvGet(`env-action:${decisionId}`);
      const decision = this.d.state.decisions[decisionId];
      if (!raw || !decision || decision.answeredAt) throw new EnvironmentError('Approval missing or already used', 409);
      const p = JSON.parse(raw) as PendingAction;
      if (!['approve', 'deny'].includes(answer)) throw new EnvironmentError('Choose approve or deny');
      if (p.consumed || p.expires <= this.clock()) throw new EnvironmentError('Approval expired or already used. Request the action again.', 409);
      if (answer === 'approve' && digest !== p.digest) throw new EnvironmentError('This approval is for a different command. Review the current command and approve again.', 409);
      // Second confirmation / option checks from the shared Decisions inbox, before any Docker call.
      this.d.decisions.validateAnswer(decisionId, answer, o);
      let execution = p;
      if (answer === 'approve') {
        // Verify before any Docker call, and again after the asynchronous local-engine check.
        const unchanged = () => {
          const binding = this.readComposeBinding(p.action, p.services);
          if (this.digestOf(binding) !== p.digest) throw new EnvironmentError('The project Compose content changed after this request. Review the files and request the action again.', 409);
          return binding;
        };
        unchanged();
        const a = await this.availability(true);
        if (!a.local || !a.engine || !a.compose) throw new EnvironmentError(a.error ?? 'Docker unavailable', 409);
        if (this.closing || this.d.closed || p.expires <= this.clock()) throw new EnvironmentError('Approval expired or environment shutting down', 409);
        const binding = unchanged();
        const snap = this.materializeSnapshot(binding, decisionId);
        snapshotDir = snap.dir;
        execution = { ...p, argv: this.argvForSnapshot(snap.composeFiles, snap.envFile, p.action, p.action === 'down' ? [] : binding.scope), snapshotDir: snap.dir };
      }
      if (this.d.state.decisions[decisionId].answeredAt) throw new EnvironmentError('Approval already used', 409);
      // Answer, consumed marker and the exact execution record commit together (atomic API).
      this.d.decisions.answerAtomic(decisionId, answer, { channel: 'dashboard', ...o }, HUMAN, [], () => this.d.store.kvSet(`env-action:${decisionId}`, JSON.stringify({ ...execution, consumed: true })));
      if (answer === 'deny') return { executed: false, job: null };
      const job: EnvironmentJob = { id: newId('job'), decisionId, action: execution.action, services: execution.services, argv: execution.argv, state: 'running', exitCode: null, output: '', startedAt: this.d.nowIso(), endedAt: null };
      this.jobs.push(job);
      this.saveJobs();
      const task = this.runJob(job, execution);
      this.tasks.add(task);
      void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
      snapshotDir = undefined; // The job owns cleanup from here, including failure/abort.
      return { executed: true, job };
    } finally {
      if (snapshotDir) this.removeSnapshot(snapshotDir);
      this.resolving.delete(decisionId);
    }
  }

  private async runJob(job: EnvironmentJob, p: PendingAction) {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      let r: ExecResult;
      try { r = await this.exec(p.argv.slice(1), { timeoutMs: TIMEOUTS[p.action], maxBytes: 2 * LOG_LIMIT, signal: controller.signal }); }
      catch (e) { r = { code: null, stdout: '', stderr: '', error: (e as Error).message, timedOut: false }; }
      const exitCode = controller.signal.aborted ? null : r.code;
      const output = this.d.redactText(`${r.stdout}${r.stderr}${r.error ? `\n${r.error}` : ''}${controller.signal.aborted ? '\n[action client interrupted; check service status]' : r.timedOut ? '\n[timed out; check service status]' : ''}`).slice(-16 * 1024);
      Object.assign(job, { state: controller.signal.aborted ? 'interrupted' : !r.timedOut && r.code === 0 ? 'succeeded' : 'failed', exitCode, output, endedAt: this.d.nowIso() });
      this.availabilityCache = null;
      if (!this.d.closed) {
        this.saveJobs();
        this.d.commit([{ type: 'docker.action', actor: HUMAN, data: { decisionId: job.decisionId, command: p.argv, exitCode, output } }]);
      }
    } finally {
      if (p.snapshotDir) this.removeSnapshot(p.snapshotDir);
      this.controllers.delete(controller);
    }
  }

  private saveJobs() {
    if (this.d.closed) return;
    this.jobs = this.jobs.slice(-25);
    this.d.store.kvSet('environment:jobs', JSON.stringify(this.jobs));
  }

  async close() {
    this.closing = true;
    for (const c of this.controllers) c.abort();
    await Promise.allSettled([...this.tasks]);
    this.controllers.clear();
  }

  // ---- databases ---------------------------------------------------------------------------

  /** Preview only: files, commands and connection details. Nothing is written or run. */
  async planDatabase(input: unknown) {
    let spec;
    try { spec = parseDatabaseSpec(input); } catch (e) { throw new EnvironmentError((e as DatabaseSpecError).message); }
    if (spec.kind === 'sqlite') {
      const file = this.files.sqliteFile(spec.name);
      return { spec, files: [{ path: file, mode: '0600', contents: null, note: 'Empty SQLite database file (WAL mode).' }], steps: [], connection: { url: `sqlite://${file}`, file }, warnings: fs.existsSync(file) ? ['This SQLite file already exists and is kept as is.'] : [] };
    }
    const existing = this.databases().filter(r => !(r.spec.kind === 'postgres' && r.spec.service === spec.service));
    const projectServices = this.composeFiles().project?.services.map(s => s.name) ?? [];
    if (projectServices.includes(spec.service)) throw new EnvironmentError(`The repository's Compose file already declares a service named ${spec.service}. Choose another name.`, 409);
    const otherPg = existing.map(r => r.spec).filter((s): s is PostgresSpec => s.kind === 'postgres');
    if (otherPg.some(s => s.port === spec.port)) throw new EnvironmentError(`Port ${spec.port} is already used by another generated database.`, 409);
    const records = [...existing, { spec, createdAt: this.d.nowIso() }];
    const warnings: string[] = [];
    const a = await this.availability();
    const image = postgresImage(spec);
    const present = a.engine ? await this.imagePresent(image) : null;
    if (!a.engine) warnings.push(a.error ?? 'Docker is unavailable');
    else if (!a.local) warnings.push(a.error!);
    if (await this.portProbe(spec.port)) warnings.push(`Host port ${spec.port} is already in use on this Mac. Choose another port.`);
    const compose = this.files.compose(this.project, records);
    const base = ['docker', 'compose', '--project-name', this.project, '--project-directory', this.repo, ...[this.composeFiles().project?.file, this.files.composeFile].filter(Boolean).flatMap(f => ['-f', f!])];
    return {
      spec,
      files: [
        { path: this.files.composeFile, mode: '0600', contents: compose, note: 'Generated Compose file for One Connect databases in this project.' },
        { path: this.files.secretFile(spec.service), mode: '0600', contents: null, note: 'Random password. Its contents are never shown, logged or sent to agents.' },
      ],
      steps: [
        { id: 'image', title: present ? `Image ${image} is present locally` : `Pull ${image}`, network: !present, argv: [...base, 'pull', spec.service], needed: present === false, action: 'pull' as const },
        { id: 'up', title: `Start ${spec.service} with healthcheck`, network: false, argv: [...base, 'up', '--detach', '--no-deps', '--no-build', '--pull', 'never', spec.service], needed: true, action: 'up' as const },
      ],
      connection: this.connection(spec),
      volume: `${this.project}_${volumeName(spec)}`,
      warnings,
    };
  }

  /** Write the reviewed files. Docker steps still need their own approvals. */
  async createDatabase(input: unknown) {
    const plan = await this.planDatabase(input);
    const spec = plan.spec;
    const records = this.databases().filter(r => !(r.spec.kind === spec.kind && (r.spec.kind === 'postgres' ? r.spec.service === (spec as PostgresSpec).service : r.spec.name === (spec as { name: string }).name)));
    records.push({ spec, createdAt: this.d.nowIso() });
    if (spec.kind === 'sqlite') this.files.createSqlite(spec.name);
    else {
      this.d.addSecret(this.files.ensureSecret(spec.service));
      this.files.writeCompose(this.project, records);
    }
    this.d.store.kvSet('environment:databases', JSON.stringify(records));
    this.d.commit([{ type: 'docker.action', actor: HUMAN, data: { decisionId: 'database-files', command: ['one-connect', 'database', 'create', spec.kind, spec.kind === 'postgres' ? spec.service : spec.name], exitCode: 0, output: `Wrote ${plan.files.map(f => path.basename(f.path)).join(', ')} (0600)` } }]);
    return { database: this.connection(spec), plan };
  }

  connection(spec: DatabaseRecord['spec']) {
    if (spec.kind === 'sqlite') { const file = this.files.sqliteFile(spec.name); return { kind: 'sqlite' as const, name: spec.name, url: `sqlite://${file}`, file, exists: fs.existsSync(file) }; }
    const base = ['docker', 'compose', '--project-name', this.project, '--project-directory', this.repo, ...[this.composeFiles().project?.file, this.files.composeFile].filter(Boolean).flatMap(f => ['-f', f!])];
    return {
      kind: 'postgres' as const, service: spec.service, host: '127.0.0.1', port: spec.port, database: spec.database, user: spec.user,
      password: 'hidden' as const, passwordFile: this.files.secretFile(spec.service),
      url: `postgresql://${spec.user}:<password>@127.0.0.1:${spec.port}/${spec.database}`,
      volume: `${this.project}_${volumeName(spec)}`,
      shell: [...base, 'exec', spec.service, 'psql', '-U', spec.user, '-d', spec.database],
    };
  }

  connections() { return this.databases().map(r => this.connection(r.spec)); }
}
