// SPDX-License-Identifier: Apache-2.0
// Finds every copy of a vendor CLI (PATH and app bundles) and pins one. Apps sometimes ship a
// newer CLI than the one on PATH, and only the newer one can run the newest models.
import fs from 'node:fs';
import path from 'node:path';
import type { BinaryInfo } from '@acc/core';
import { compareVersions } from '@acc/core';
import { run } from '../../exec.ts';
import type { VendorAdapter } from './types.ts';

const PRERELEASE = /(alpha|beta|rc|canary|nightly|dev|preview)/i;

export function parseVersion(out: string): { version: string | null; prerelease: boolean } {
  const m = /(\d+(?:\.\d+){1,3})(?:[-+]([\w.]+))?/.exec(out);
  if (!m) return { version: null, prerelease: false };
  const pre = m[2] && PRERELEASE.test(m[2]) ? m[2] : null;
  return { version: pre ? `${m[1]}-${pre}` : m[1], prerelease: Boolean(pre) };
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function whichAll(names: readonly string[], envPath = process.env.PATH ?? ''): string[] {
  const out: string[] = [];
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (isExecutable(p)) out.push(p);
    }
  }
  return out;
}

export async function binaryVersion(p: string): Promise<{ version: string | null; prerelease: boolean }> {
  const r = await run(p, ['--version'], { timeoutMs: 15_000 });
  return parseVersion(`${r.stdout}\n${r.stderr}`);
}

function realKey(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export async function detectBinaries(adapter: VendorAdapter, pinned?: string): Promise<BinaryInfo[]> {
  const seen = new Set<string>();
  const found: BinaryInfo[] = [];
  const add = async (p: string, source: BinaryInfo['source']) => {
    const key = realKey(p);
    if (seen.has(key) || !isExecutable(p)) return;
    seen.add(key);
    const v = await binaryVersion(p);
    found.push({ path: p, version: v.version, prerelease: v.prerelease, source });
  };
  if (pinned) await add(pinned, 'config');
  for (const p of whichAll(adapter.binaryNames)) await add(p, 'path');
  for (const p of adapter.knownLocations()) await add(p, p.includes('.app/') ? 'app-bundle' : 'known-location');
  return found;
}

function versionParts(v: string | null): number[] {
  return v ? v.split('-')[0].split('.').map(Number) : [];
}

/**
 * Choose the binary to pin: an explicit config pin always wins; otherwise the newest stable
 * version, falling back to a prerelease only if nothing stable exists.
 */
export function chooseBinary(cands: BinaryInfo[]): BinaryInfo | null {
  const cfg = cands.find((c) => c.source === 'config');
  if (cfg) return cfg;
  const sorted = [...cands].sort((a, b) => compareVersions(versionParts(b.version), versionParts(a.version)));
  return sorted.find((c) => !c.prerelease) ?? sorted[0] ?? null;
}

/** A newer build exists elsewhere (often a prerelease bundled in an app). */
export function newerCandidate(chosen: BinaryInfo | null, cands: BinaryInfo[]): BinaryInfo | null {
  if (!chosen) return null;
  const better = cands.filter((c) => c.path !== chosen.path && compareVersions(versionParts(c.version), versionParts(chosen.version)) > 0);
  return better.sort((a, b) => compareVersions(versionParts(b.version), versionParts(a.version)))[0] ?? null;
}
