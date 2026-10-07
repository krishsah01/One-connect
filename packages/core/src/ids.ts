// SPDX-License-Identifier: Apache-2.0
// Sortable, prefixed ids: <prefix>_<time base36><random>. Works in Node and the browser.

export function newId(prefix: string): string {
  const t = Date.now().toString(36).padStart(9, '0');
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  const r = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
  return `${prefix}_${t}${r}`;
}
