// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Live file-system watch of a worktree, debounced, ignoring .git internals.
import fs from 'node:fs';

export class WorktreeWatcher {
  private watchers = new Map<string, { w: fs.FSWatcher | null; timer: NodeJS.Timeout | null; poll: NodeJS.Timeout | null }>();

  private onChange: (key: string) => void;
  private debounceMs: number;

  constructor(onChange: (key: string) => void, debounceMs = 750) {
    this.onChange = onChange;
    this.debounceMs = debounceMs;
  }

  watch(key: string, dir: string): void {
    if (this.watchers.has(key) || !fs.existsSync(dir)) return;
    const entry = { w: null as fs.FSWatcher | null, timer: null as NodeJS.Timeout | null, poll: null as NodeJS.Timeout | null };
    const fire = () => {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.onChange(key), this.debounceMs);
    };
    try {
      entry.w = fs.watch(dir, { recursive: true }, (_ev, file) => {
        const f = String(file ?? '');
        if (f === '.git' || f.startsWith('.git/') || f.includes('/.git/') || f.includes('node_modules/')) return;
        fire();
      });
      entry.w.on('error', () => {
        entry.w?.close();
        entry.w = null;
      });
    } catch {
      entry.w = null;
    }
    // Recursive watch isn't available everywhere; a slow poll keeps the diff honest regardless.
    entry.poll = setInterval(() => this.onChange(key), 15_000);
    this.watchers.set(key, entry);
  }

  unwatch(key: string): void {
    const e = this.watchers.get(key);
    if (!e) return;
    e.w?.close();
    if (e.timer) clearTimeout(e.timer);
    if (e.poll) clearInterval(e.poll);
    this.watchers.delete(key);
  }

  closeAll(): void {
    for (const k of [...this.watchers.keys()]) this.unwatch(k);
  }
}
