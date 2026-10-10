// SPDX-License-Identifier: Apache-2.0
// Compose file secrets/configs are bind mounts. Their sealed sources must outlive `up -d`
// and daemon restarts; temporary approval/build snapshots cannot own their lifetime.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readScopedBytes, scopedPath } from './compose.ts';

export class RuntimeInputs {
  private root: string;
  private addSecret: (value: string) => void;
  constructor(root: string, addSecret: (value: string) => void) {
    this.root = root;
    this.addSecret = addSecret;
    const dir = path.join(root, 'runtime-secrets');
    if (!fs.existsSync(dir)) return;
    scopedPath(root, dir);
    for (const name of fs.readdirSync(dir)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      // Never follow a replaced symlink or read arbitrary files when restoring redaction.
      try { this.addSecret(readScopedBytes(dir, path.join(dir, name), 1024 * 1024).toString('utf8')); }
      catch { /* Invalid inputs are refused if a later approval tries to reuse them. */ }
    }
  }

  seal(kind: 'secrets' | 'configs', bytes: Buffer): string {
    const dir = path.join(this.root, `runtime-${kind}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    scopedPath(this.root, dir);
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, createHash('sha256').update(bytes).digest('hex'));
    try { fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o400 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    if (!readScopedBytes(dir, file, 1024 * 1024).equals(bytes)) throw new Error('A retained runtime input changed; refusing to launch');
    fs.chmodSync(file, 0o400);
    if (kind === 'secrets') this.addSecret(bytes.toString('utf8'));
    return file;
  }
}
