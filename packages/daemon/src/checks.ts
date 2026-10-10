// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Required checks execute committed source in a disposable Docker container. Vendor harnesses
// stay native. Host execution requires an explicit, marked disposable fixture configuration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CheckRuntimeSchema, checkRuntimeKey, parseTestOutput, redact, type CheckRuntime, type TestCounts } from '@acc/core';
import { git, gitCommonDir, revParse } from './adapters/vcs/git.ts';
import { SAFE_GIT_FLAGS, safeGitEnv } from './adapters/vcs/git-policy.ts';
import { run, type ExecOptions, type ExecResult } from './exec.ts';

export const HOST_FIXTURE_MARKER = 'one-connect-disposable-host-fixture';
export const HOST_FIXTURE_NOTICE = 'HOST FIXTURE (unsandboxed; disposable tests/demo only)';
const MAX_LOG = 256 * 1024;
const MAX_SOURCE = 128 * 1024 * 1024;
const MAX_FILES = 10_000;
export interface CheckResult {
  name: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  counts: TestCounts | null;
  logPath: string;
  durationMs: number;
  status: 'passed' | 'failed' | 'unavailable';
  sha: string | null;
  runtime: string;
  runtimeKey?: string;
  imageId?: string;
  detail: string;
}
export interface CheckOptions {
  cwd: string;
  repo: string;
  sha: string | null;
  runtime?: CheckRuntime;
  checks: { name: string; command: string }[];
  logDir: string;
  env: NodeJS.ProcessEnv;
  denylist: string[];
  timeoutMs?: number;
}
/** Injectable Docker transport for offline protocol tests. Source export always uses real Git. */
export type CheckExecutor = (cmd: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

async function blobs(cwd: string, ids: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...SAFE_GIT_FLAGS, '-c', 'protocol.allow=never', 'cat-file', '--batch'], { cwd, env: safeGitEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (b: Buffer) => {
      bytes += b.length;
      if (bytes > MAX_SOURCE + MAX_FILES * 256) { overflow = true; child.kill('SIGKILL'); }
      else chunks.push(b);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 && !overflow ? resolve(Buffer.concat(chunks)) : reject(new Error('source blobs unavailable or source export limit exceeded')); });
    child.stdin.end(ids.join('\n') + '\n');
  });
}

/** Export Git blobs, never the live checkout, untracked files, .git, filters or archive drivers. */
async function snapshot(o: CheckOptions, destination: string): Promise<string> {
  if (!o.sha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(o.sha)) throw new Error('an exact committed SHA is required');
  if (await gitCommonDir(o.cwd) !== await gitCommonDir(o.repo)) throw new Error('check worktree is outside the configured repository');
  if (await revParse(o.cwd, o.sha) !== o.sha) throw new Error('requested source SHA is unavailable locally');
  const tree = await git(o.cwd, ['ls-tree', '-r', '-z', '-l', o.sha]);
  if (tree.stdout.length >= 8 * 1024 * 1024) throw new Error('source tree listing limit exceeded');
  const entries = tree.stdout.split('\0').filter(Boolean).map(line => {
    const m = /^(\d+) (\w+) ([a-f0-9]+) +([\d-]+)\t([\s\S]+)$/.exec(line);
    if (!m) throw new Error('invalid source tree entry');
    const [, mode, kind, id, size, file] = m;
    if (!['100644', '100755'].includes(mode) || kind !== 'blob') throw new Error(`source symlinks and submodules are unsupported: ${file}`);
    if (file.includes('\\') || file.includes('\0') || file.includes('\ufffd') || path.isAbsolute(file) || file.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) throw new Error('unsafe source path');
    return { mode, id, size: Number(size), file };
  });
  if (entries.length > MAX_FILES || entries.reduce((n, e) => n + e.size, 0) > MAX_SOURCE) throw new Error('source export limit exceeded');
  fs.mkdirSync(destination, { mode: 0o755 });
  if (!entries.length) return o.sha;
  const data = await blobs(o.cwd, entries.map(e => e.id));
  let offset = 0;
  for (const e of entries) {
    const end = data.indexOf('\n', offset);
    if (end < offset || data.subarray(offset, end).toString() !== `${e.id} blob ${e.size}`) throw new Error('source object export mismatch');
    offset = end + 1;
    const content = data.subarray(offset, offset + e.size);
    if (content.length !== e.size || data[offset + e.size] !== 10) throw new Error('incomplete source object');
    const file = path.join(destination, e.file);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, content, { mode: e.mode === '100755' ? 0o755 : 0o644, flag: 'wx' });
    offset += e.size + 1;
  }
  if (offset !== data.length) throw new Error('unexpected source export data');
  return o.sha;
}

export async function runChecks(o: CheckOptions, execute: CheckExecutor = run): Promise<CheckResult[]> {
  let logFailure = '';
  try { fs.mkdirSync(o.logDir, { recursive: true, mode: 0o700 }); }
  catch { logFailure = 'check log directory unavailable'; }
  const results: CheckResult[] = [];
  let root: string | undefined;
  let sourceSha: string | null = null;
  let runtime: CheckRuntime | undefined;
  let unavailable = '';
  let imageId = '';
  const runtimeLabel = o.runtime?.mode === 'host-fixture' ? HOST_FIXTURE_NOTICE : 'Docker (local, offline, committed source)';
  let docker: (args: string[], timeoutMs?: number) => Promise<ExecResult>;
  try {
    runtime = CheckRuntimeSchema.parse(o.runtime);
    if (logFailure) throw new Error(logFailure);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-connect-check-'));
    if (/[\x00-\x1f,]/.test(root)) throw new Error('unsafe temporary source mount path');
    const source = path.join(root, 'source');
    sourceSha = await snapshot(o, source);
    if (runtime.mode === 'host-fixture') {
      const repo = fs.realpathSync(o.repo);
      if (fs.realpathSync(runtime.fixture_repo) !== repo) throw new Error('host fixture config must identify this exact disposable repository');
      const marker = path.join(await gitCommonDir(repo), HOST_FIXTURE_MARKER);
      const st = fs.lstatSync(marker);
      if (!st.isFile() || st.isSymbolicLink() || fs.readFileSync(marker, 'utf8') !== HOST_FIXTURE_NOTICE + '\n') throw new Error('explicit disposable host fixture marker is required');
    } else {
      // --host and an empty Docker config prevent inherited contexts, credentials and CLI plugins.
      const env = { PATH: o.env.PATH ?? process.env.PATH, HOME: root, DOCKER_CONFIG: path.join(root, 'docker-config'), LC_ALL: 'C' };
      fs.mkdirSync(env.DOCKER_CONFIG, { mode: 0o700 });
      docker = (args, timeoutMs = 10_000) => execute(runtime!.mode === 'docker' ? runtime!.binary ?? 'docker' : 'docker', ['--host', (runtime as Extract<CheckRuntime, { mode: 'docker' }>).endpoint, ...args], { cwd: root, env, timeoutMs, maxBytes: MAX_LOG });
      const engine = await docker(['version', '--format', '{{.Server.Version}}']);
      if (engine.code !== 0 || engine.timedOut || engine.error) throw new Error(`local Docker runtime unavailable: ${engine.error ?? engine.stderr}`);
      const image = await docker(['image', 'inspect', runtime.image]);
      if (image.code !== 0 || image.timedOut || image.error) throw new Error(`Docker image must already be installed: ${image.error ?? image.stderr}`);
      const info = JSON.parse(image.stdout)[0];
      imageId = String(info?.Id ?? '');
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Docker image identity is unavailable');
      if (Object.keys(info?.Config?.Volumes ?? {}).length) throw new Error('check images with declared volumes are unsupported');
    }
  } catch (e) { unavailable = o.runtime ? String((e as Error).message) : 'project.check_runtime is missing; configure a local installed Docker image and Unix endpoint'; }
  try {
    for (const [index, c] of o.checks.entries()) {
      const t0 = Date.now();
      let r: ExecResult = { code: null, stdout: '', stderr: unavailable, timedOut: false };
      let status: CheckResult['status'] = 'unavailable';
      let cleanupError = '';
      if (!c.command.trim()) r.stderr = 'required check command is missing';
      else if (!unavailable && root && runtime) {
        if (runtime.mode === 'host-fixture') {
          // No vendor keys, daemon tokens, shell startup variables or repo-local node_modules.
          // Separate writable committed-source copy for each fixture command.
          const work = path.join(root, `fixture-${index}`);
          fs.cpSync(path.join(root, 'source'), work, { recursive: true });
          r = await run('/bin/sh', ['-c', c.command], { cwd: work, env: { PATH: o.env.PATH ?? process.env.PATH, HOME: root, CI: '1', FORCE_COLOR: '0' }, timeoutMs: o.timeoutMs ?? 900_000, maxBytes: MAX_LOG });
          status = r.code === 0 && !r.timedOut && !r.error ? 'passed' : 'failed';
        } else {
          const name = `one-connect-check-${randomUUID()}`;
          // Container gets only a read-only owned source snapshot, no checkout/.git/socket/home.
          const args = ['create', '--name', name, '--label', `one-connect.check=${name}`, '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534', `--pids-limit=${runtime.pids}`, `--cpus=${runtime.cpus}`, `--memory=${runtime.memory_mb}m`, `--memory-swap=${runtime.memory_mb}m`, '--ulimit=nofile=1024:1024', '--log-driver=none', '--mount', `type=bind,src=${path.join(root, 'source')},dst=/source,readonly`, '--tmpfs', `/workspace:rw,exec,nosuid,nodev,size=${runtime.workspace_mb}m,mode=1777`, '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777', '--workdir=/workspace', '--env=CI=1', '--env=FORCE_COLOR=0', '--env=HOME=/tmp', '--entrypoint=/bin/sh', imageId, '-c', 'cp -R /source/. /workspace/ && cd /workspace && exec /bin/sh -c "$1"', 'one-connect-check', c.command];
          try {
            r = await docker!(args);
            if (r.code === 0 && !r.timedOut && !r.error && /^[a-f0-9]{64}\s*$/.test(r.stdout)) {
              r = await docker!(['start', '--attach', name], o.timeoutMs ?? runtime.timeout_seconds * 1000);
              status = r.code === 0 && !r.timedOut && !r.error ? 'passed' : 'failed';
              // start --attach's CLI status is not proof of the process exit. Inspect the
              // stopped container explicitly, including OOM/engine errors, before going green.
              if (status === 'passed') {
                const state = await docker!(['inspect', '--format', '{{json .State}}', name]);
                try {
                  const value = JSON.parse(state.stdout);
                  if (state.code !== 0 || state.timedOut || state.error || value.Running !== false || !Number.isInteger(value.ExitCode) || value.OOMKilled || value.Error) throw new Error('container exit proof unavailable');
                  r.code = value.ExitCode;
                  status = value.ExitCode === 0 ? 'passed' : 'failed';
                } catch { r.code = null; r.error = 'container exit proof unavailable'; status = 'unavailable'; }
              }
            } else if (r.code === 0) r = { ...r, code: null, error: 'Docker did not return a container identity' };
          } catch (e) { r = { code: null, stdout: '', stderr: String(e), timedOut: false }; }
          finally {
            // Attempt cleanup even when create times out after the engine accepted the request.
            try {
              const removed = await docker!(['rm', '--force', name]);
              if (removed.code !== 0 && !/No such container/i.test(removed.stderr)) cleanupError = 'owned check container cleanup failed';
            } catch { cleanupError = 'owned check container cleanup failed'; }
          }
        }
      }
      if (cleanupError) status = 'failed';
      const output = redact(`${r.stdout}\n${r.stderr}\n${r.error ?? ''}\n${cleanupError}`, { denylist: o.denylist }).text.slice(0, MAX_LOG);
      const safeCommand = redact(c.command, { denylist: o.denylist }).text;
      let detail = redact(cleanupError || r.error || r.stderr || (r.timedOut ? 'timed out' : status), { denylist: o.denylist }).text.slice(0, 2000);
      // Numeric index prevents collisions and traversal, including a check named '..'.
      let logPath = path.join(o.logDir, `${index}-${c.name.replace(/[^\w.-]/g, '_').slice(0, 80)}.log`);
      let exitCode = status === 'passed' ? 0 : r.code === 0 ? null : r.code;
      try {
        if (logFailure) throw new Error(logFailure);
        const fd = fs.openSync(logPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
        try {
          fs.fchmodSync(fd, 0o600);
          fs.writeFileSync(fd, `[${runtimeLabel}] SHA ${sourceSha ?? o.sha ?? 'unavailable'}\n$ ${safeCommand.slice(0, MAX_LOG)}\n${output}\n[${status}; exit ${exitCode ?? 'none'}${r.timedOut ? ', timed out' : ''}]\n`);
        } finally { fs.closeSync(fd); }
      } catch { status = 'unavailable'; exitCode = null; detail = 'private check log unavailable'; logPath = ''; }

      results.push({ name: c.name, command: safeCommand, exitCode, timedOut: r.timedOut, counts: status === 'unavailable' ? null : parseTestOutput(output), logPath, durationMs: Date.now() - t0, status, sha: sourceSha ?? o.sha, runtime: runtimeLabel, runtimeKey: checkRuntimeKey(runtime), imageId: imageId || undefined, detail });
    }
    return results;
  } finally { if (root) fs.rmSync(root, { recursive: true, force: true }); }
}
