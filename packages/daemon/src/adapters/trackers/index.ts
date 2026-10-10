// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import path from 'node:path';
import type { TrackerConfig } from '@acc/core';
import { GitHubTracker } from './github.ts';
import { LinearTracker } from './linear.ts';
import { LocalTracker } from './local.ts';
import type { TrackerAdapter } from './types.ts';

export function createTracker(cfg: TrackerConfig, o: { dataDir: string; onSecret?: (v: string) => void; fetch?: (url: string, init?: RequestInit) => Promise<Response> }): TrackerAdapter {
  switch (cfg.type) {
    case 'local':
      return new LocalTracker(path.join(o.dataDir, 'local-tracker.sqlite'), cfg.key_prefix);
    case 'github':
      return new GitHubTracker({ repo: cfg.repo, live: cfg.live, labelPrefix: cfg.label_prefix, gh: cfg.gh_binary });
    case 'linear':
      return new LinearTracker({ team: cfg.team, project: cfg.project, live: cfg.live, apiUrl: cfg.api_url, stateNames: cfg.state_names, onSecret: o.onSecret, fetch: o.fetch as never });
  }
}

export { GitHubTracker, LinearTracker, LocalTracker };
export * from './types.ts';
