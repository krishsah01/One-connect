// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { makeConfig, makeRepo, startDaemon } from './helpers.ts';

function listen(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))) });
    });
  });
}

describe('code host adapters', () => {
  it('reads GitLab protection, merge requests and pipelines from a loopback fixture and refuses the real API', async () => {
    const repo = makeRepo();
    const fx = await listen((req, res) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      res.setHeader('content-type', 'application/json');
      if (path.endsWith('/protected_branches')) {
        res.end(JSON.stringify([{ name: 'main' }]));
        return;
      }
      if (path.endsWith('/merge_requests')) {
        res.end(JSON.stringify([{ iid: 4, title: 'Ship', state: 'opened', sha: 'abc', source_branch: 'feature', target_branch: 'main', web_url: 'http://127.0.0.1/mr/4' }]));
        return;
      }
      if (path.endsWith('/pipelines')) {
        res.end(JSON.stringify([{ id: 9, status: 'failed', sha: 'abc', ref: 'main' }]));
        return;
      }
      res.statusCode = 404;
      res.end('[]');
    });
    const cfg = makeConfig(repo, { code_host: { provider: 'gitlab', project: 'acme/widgets', fixture_base: fx.url } });
    const h = await startDaemon(cfg, { probe: false });
    try {
      const snapshot = await h.d.hosts.refresh();
      expect(snapshot).toMatchObject({ provider: 'gitlab', source: 'fixture', protected: true, productionBranch: 'main' });
      expect(snapshot.pulls[0]).toMatchObject({ id: '4', sha: 'abc', state: 'opened' });
      expect(snapshot.checks[0]).toMatchObject({ status: 'failed', sha: 'abc' });
      expect(Object.values(h.d.state.alerts).some((a) => !a.resolvedAt && /CI on main is failing/.test(a.message))).toBe(true);

      let called = false;
      h.d.egress.fetch = async () => {
        called = true;
        throw new Error('should not dial');
      };
      h.d.config = { ...h.d.config, code_host: { provider: 'github', repo: 'acme/widgets', fixture_base: 'https://api.github.com', activated: false, scopes: [], finding_issues: 'manual' } };
      const refused = await h.d.hosts.refresh();
      expect(called).toBe(false);
      expect(refused.source).toBe('refused');
      expect(refused.protected).toBeNull();
      expect(refused.error).toMatch(/Real-provider validation is pending/);
    } finally {
      await h.close();
      await fx.close();
    }
  });

  it('reports an unconfigured host as unchecked', async () => {
    const h = await startDaemon(makeConfig(makeRepo()), { probe: false });
    try {
      const snapshot = await h.d.hosts.refresh();
      expect(snapshot).toMatchObject({ provider: 'unconfigured', source: 'unconfigured', protected: null, checks: [] });
      expect(Object.values(h.d.state.alerts).some((a) => a.kind === 'branch_protection' && !a.resolvedAt)).toBe(false);
    } finally {
      await h.close();
    }
  });
});
