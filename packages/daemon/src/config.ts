// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { formatConfigError, parseConfig, type ControlCenterConfig } from '@acc/core';
import { expandHome } from './paths.ts';

export class ConfigError extends Error {}

export function findConfig(explicit?: string): string {
  const candidates = [explicit, process.env.ACC_CONFIG, path.resolve('control-center.yaml'), path.resolve('control-center.yml')].filter(Boolean) as string[];
  for (const c of candidates) if (fs.existsSync(c)) return path.resolve(c);
  throw new ConfigError(`No control-center.yaml found (looked at ${candidates.join(', ')}). Copy examples/control-center.yaml and edit it.`);
}

export function loadConfig(file: string): ControlCenterConfig {
  let raw: unknown;
  try {
    raw = YAML.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${file}: ${(e as Error).message}`);
  }
  let cfg: ControlCenterConfig;
  try {
    cfg = parseConfig(raw);
  } catch (e) {
    throw new ConfigError(`${file} is invalid:\n${formatConfigError(e)}`);
  }
  const base = path.dirname(file);
  cfg.project.repo = path.resolve(base, expandHome(cfg.project.repo));
  for (const a of cfg.agents) if (a.binary) a.binary = path.resolve(base, expandHome(a.binary));
  return cfg;
}
