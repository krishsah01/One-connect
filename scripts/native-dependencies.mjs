// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export function nativeDependencies() {
  const manifest = fileURLToPath(new URL('../packages/desktop/src-tauri/Cargo.toml', import.meta.url));
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--manifest-path', manifest, '--locked', '--offline', '--format-version', '1', '--filter-platform', 'aarch64-apple-darwin'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
  return metadata.packages.filter(p => p.source).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}
