// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Checks that a subscription agent runs the vendor's CLI as published: on macOS the binary must
// carry a valid code signature from the vendor's Developer ID. A broken or foreign signature
// blocks dispatch; an unsigned launcher (e.g. an npm shim) is only a warning.
import fs from 'node:fs';
import type { BinarySignature } from '@acc/core';
import { run, type ExecResult } from '../../exec.ts';

type Runner = (cmd: string, args: readonly string[]) => Promise<ExecResult>;
const cache = new Map<string, BinarySignature>();

export async function checkSignature(binaryPath: string, expected: { teamId: string; organization: string } | null, o: { platform?: NodeJS.Platform; runner?: Runner } = {}): Promise<BinarySignature> {
  if (!expected) return { state: 'not_expected', detail: 'The vendor ships this CLI without a macOS signature; integrity is not checked.' };
  if ((o.platform ?? process.platform) !== 'darwin') return { state: 'unavailable', detail: 'Code signatures are only checked on macOS.' };
  let real = binaryPath;
  let key = binaryPath;
  try {
    real = fs.realpathSync(binaryPath);
    const st = fs.statSync(real);
    key = `${real}:${st.size}:${st.mtimeMs}:${expected.teamId}`;
  } catch {
    return { state: 'invalid', detail: `${binaryPath} is missing or unreadable.` };
  }
  const hit = cache.get(key);
  if (hit) return hit;
  const exec: Runner = o.runner ?? ((c, a) => run(c, a, { timeoutMs: 20_000 }));
  const verify = await exec('codesign', ['--verify', '--strict', real]);
  let result: BinarySignature;
  if (verify.error) result = { state: 'unavailable', detail: `codesign is unavailable: ${verify.error}` };
  else if (verify.code !== 0) {
    result = /not signed at all/i.test(verify.stderr)
      ? { state: 'unsigned', detail: `${real} is not code-signed (often a package-manager launcher). Prefer the vendor's official installer.`, teamId: null }
      : { state: 'invalid', detail: `The signature on ${real} is broken or the file was modified: ${verify.stderr.trim().slice(0, 200)}. Reinstall the CLI from the vendor.`, teamId: null };
  } else {
    const info = await exec('codesign', ['-dv', '--verbose=2', real]);
    const teamId = /TeamIdentifier=(\S+)/.exec(`${info.stderr}\n${info.stdout}`)?.[1] ?? null;
    result = teamId === expected.teamId
      ? { state: 'verified', detail: `Signed by ${expected.organization} (${teamId}).`, teamId }
      : { state: 'mismatch', detail: `Signed by ${teamId ?? 'an unknown developer'}, not ${expected.organization} (${expected.teamId}). Reinstall the CLI from the vendor.`, teamId };
  }
  if (result.state !== 'unavailable') cache.set(key, result);
  return result;
}
