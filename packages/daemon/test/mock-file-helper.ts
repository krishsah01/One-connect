// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Build only our small trusted helper for offline macOS test fixtures. Production desktop uses
// its own executable's early helper mode; no compiler is needed by the packaged application.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './helpers.ts';
export function ensureNativeMockHelper() {
  if (process.platform !== 'darwin' || process.env.ACC_NATIVE_FILE_HELPER) return;
  const binary = path.join(tmpDir('mock-file-helper'), 'helper');
  const source = path.resolve(import.meta.dirname, '../../desktop/src-tauri/src/mock_file.rs');
  const compiler = '/Library/Developer/CommandLineTools/usr/bin/clang';
  const env = { ...process.env };
  const args = ['--edition=2021', source, '-o', binary];
  if (fs.existsSync(compiler)) {
    env.DEVELOPER_DIR = '/Library/Developer/CommandLineTools';
    env.SDKROOT = '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk';
    args.push('-C', `linker=${compiler}`);
  }
  execFileSync('rustc', args, { cwd: path.resolve(import.meta.dirname, '../../..'), env, stdio: 'pipe', timeout: 30_000 });
  process.env.ACC_NATIVE_FILE_HELPER = binary;
}
