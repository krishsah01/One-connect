// SPDX-License-Identifier: Apache-2.0
import type { AdapterType } from '@acc/core';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { cursorAdapter } from './cursor.ts';
import { genericAdapter } from './generic.ts';
import { opencodeAdapter } from './opencode.ts';
import { relayAdapter } from './relay.ts';
import type { VendorAdapter } from './types.ts';

export const VENDOR_ADAPTERS: Record<AdapterType, VendorAdapter> = {
  'claude-headless': claudeAdapter,
  'codex-cli': codexAdapter,
  'cursor-agent-cli': cursorAdapter,
  'generic-cli': genericAdapter,
  relay: relayAdapter,
  'opencode-server': opencodeAdapter,
};

export function adapterFor(type: AdapterType): VendorAdapter {
  return VENDOR_ADAPTERS[type];
}

export type { VendorAdapter } from './types.ts';
