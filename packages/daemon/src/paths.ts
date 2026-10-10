// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Durable app-data locations. Logs and evidence must survive restarts, so temp dirs are refused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DataPaths {
  root: string;
  db: string;
  runs: string;
  worktrees: string;
  hooks: string;
  secrets: string;
  installToken: string;
}

export function defaultDataDir(): string {
  if (process.env.ACC_DATA_DIR) return path.resolve(process.env.ACC_DATA_DIR);
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'AgentControlCenter');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'AgentControlCenter');
  return path.join(process.env.XDG_STATE_HOME ?? path.join(home, '.local', 'state'), 'agent-control-center');
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function isUnderTemp(dir: string): boolean {
  const target = real(dir);
  const temps = [os.tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders'].map(real);
  return temps.some((t) => target === t || target.startsWith(t + path.sep));
}

export class TempDataDirError extends Error {}

export function resolveDataPaths(root = defaultDataDir(), opts: { allowTemp?: boolean } = {}): DataPaths {
  const allowTemp = opts.allowTemp ?? process.env.ACC_ALLOW_TEMP_DATA_DIR === '1';
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (isUnderTemp(root) && !allowTemp) {
    throw new TempDataDirError(
      `Refusing to use ${root} for durable state: it is inside a temp directory that the OS wipes, which would lose run logs and evidence. Set ACC_DATA_DIR to a durable folder.`,
    );
  }
  const p: DataPaths = {
    root,
    db: path.join(root, 'acc.sqlite'),
    runs: path.join(root, 'runs'),
    worktrees: path.join(root, 'worktrees'),
    hooks: path.join(root, 'hooks'),
    secrets: path.join(root, 'secrets'),
    installToken: path.join(root, 'secrets', 'install-token'),
  };
  for (const d of [p.runs, p.worktrees, p.hooks]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.mkdirSync(p.secrets, { recursive: true, mode: 0o700 });
  fs.chmodSync(p.secrets, 0o700);
  return p;
}

export function expandHome(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/** Write a file only the current user can read (tokens). */
export function writePrivate(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
