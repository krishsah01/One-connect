// SPDX-License-Identifier: Apache-2.0
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockerWorkbench, shellQuote, type EnvironmentStatus } from '../src/components/DockerWorkbench';
import { IntakePreview } from '../src/pages/Projects';
import type { Inspection } from '../src/lib/desktop';

import { setRemoteSession } from '../src/lib/remote';

// These isolated management fixtures explicitly model a verified local owner.
beforeEach(() => setRemoteSession(null, 'local'));
afterEach(() => setRemoteSession(null, 'checking'));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const base = ['docker', 'compose', '--project-name', 'shop', '--project-directory', '/repos/shop', '-f', '/repos/shop/compose.yaml'];
function status(): EnvironmentStatus {
  return {
    availability: { installed: true, engine: true, compose: true, local: true, version: '27.1', composeVersion: '2.29', endpoint: 'unix:///var/run/docker.sock', error: null },
    project: 'shop', repo: '/repos/shop', files: ['/repos/shop/compose.yaml'], warnings: [], approvalSeconds: 120,
    databases: [{ kind: 'postgres', service: 'devdb', host: '127.0.0.1', port: 5433, database: 'app', user: 'app', password: 'hidden', passwordFile: '/data/environment/secrets/devdb-password', url: 'postgresql://app:<password>@127.0.0.1:5433/app', volume: 'shop_devdb-data', shell: [...base, 'exec', 'devdb', 'psql', '-U', 'app', '-d', 'app'] }],
    jobs: [{ id: 'job1', action: 'up', services: ['web'], argv: [...base, 'up', '--detach', '--no-build', '--pull', 'never', 'web'], state: 'succeeded', exitCode: 0, output: 'Started', startedAt: '', endedAt: '' }],
    services: [
      { name: 'web', source: 'project', image: 'node:22', build: false, declaredHealthcheck: false, container: { id: 'abc', name: 'shop-web-1', state: 'running', health: null, healthLog: null, startedAt: null, image: 'node:22' }, readiness: 'running-unchecked', readinessDetail: 'Running, but no healthcheck is declared, so readiness is unknown.', imagePresent: true, ports: [{ host: 3000, container: 3000, hostIp: null, conflict: 'Host port 3000 is published by another container (other-app).' }], volumes: [] },
      { name: 'devdb', source: 'database', image: 'postgres:16-alpine', build: false, declaredHealthcheck: true, container: null, readiness: 'not-created', readinessDetail: 'No container yet.', imagePresent: false, ports: [{ host: 5433, container: 5432, hostIp: '127.0.0.1', conflict: null }], volumes: ['shop_devdb-data'] },
    ],
    foreign: [{ id: 'f00', name: 'shop-web-1', workingDir: '/elsewhere/shop' }],
  };
}

let calls: { method: string; url: string; body: unknown }[] = [];
beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', url, body });
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('/api/environment?') || url === '/api/environment') return json(status());
    if (url === '/api/environment/actions') return json({ decision: { id: 'decision_1', question: 'Run?', options: ['approve', 'deny'], irreversible: false }, argv: [...base, 'stop', 'web'], digest: 'd'.repeat(64), network: false, expiresAt: new Date(Date.now() + 120_000).toISOString(), blockers: [] });
    if (url === '/api/decisions/decision_1/prepare') return json({ confirm: false, nonce: null, expiresAt: null });
    if (url === '/api/environment/actions/decision_1/resolve') return json({ executed: true, job: null });
    if (url === '/api/environment/database/plan') return json({ spec: { kind: 'postgres', service: 'db', port: 5432 }, files: [{ path: '/data/environment/compose.one-connect.yaml', mode: '0600', contents: 'services:\n  db:\n    image: postgres:16-alpine\n', note: 'Generated Compose file' }, { path: '/data/environment/secrets/db-password', mode: '0600', contents: null, note: 'Random password. Its contents are never shown.' }], steps: [{ id: 'image', title: 'Pull postgres:16-alpine', network: true, argv: [...base, 'pull', 'db'], needed: true, action: 'pull' }, { id: 'up', title: 'Start db with healthcheck', network: false, argv: [...base, 'up', '--detach', '--no-build', '--pull', 'never', 'db'], needed: true, action: 'up' }], connection: {}, volume: 'shop_db-data', warnings: [] });
    if (url === '/api/environment/database/create') return json({ database: {} });
    if (url.includes('/logs')) return json({ service: 'web', text: 'listening on 3000', truncated: false, limit: 'last 300 lines, at most 128 KiB' });
    return json({ error: 'unexpected' }, 404);
  }));
});

describe('Docker workbench', () => {
  it('shows only bound services with honest readiness, conflicts, foreign containers and hidden credentials', async () => {
    render(<DockerWorkbench onTerminal={() => {}} />);
    expect(await screen.findByText('running · no healthcheck')).toBeTruthy();
    expect(screen.getByText('not created')).toBeTruthy();
    expect(screen.getAllByText(/published by another container \(other-app\)/).length).toBeGreaterThan(0);
    expect(screen.getByText(/image not present locally/)).toBeTruthy();
    expect(screen.getByText('Not controlled here')).toBeTruthy();
    expect(screen.getByText(/\/elsewhere\/shop/)).toBeTruthy();
    const pg = screen.getByLabelText('Postgres devdb');
    expect(within(pg).getByText(/Password: hidden/)).toBeTruthy();
    expect(pg.textContent).toContain('<password>');
  });

  it('requests an exact command, approves it with its digest once, and can pre-fill a terminal instead', async () => {
    const onTerminal = vi.fn();
    render(<DockerWorkbench onTerminal={onTerminal} />);
    await screen.findByText('running · no healthcheck');
    fireEvent.click(screen.getAllByRole('button', { name: 'Stop' })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Approve Docker action' });
    expect(dialog.textContent).toContain(shellQuote([...base, 'stop', 'web']));
    expect(calls.find(c => c.url === '/api/environment/actions')?.body).toEqual({ action: 'stop', services: ['web'] });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open in terminal' }));
    expect(onTerminal).toHaveBeenCalledWith(shellQuote([...base, 'stop', 'web']));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and run' }));
    await waitFor(() => expect(calls.some(c => c.url === '/api/environment/actions/decision_1/resolve')).toBe(true));
    expect(calls.find(c => c.url.endsWith('/resolve'))?.body).toMatchObject({ answer: 'approve', digest: 'd'.repeat(64) });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Approve Docker action' })).toBeNull());
  });

  it('previews database files and network steps before writing anything, never showing the password', async () => {
    render(<DockerWorkbench />);
    await screen.findByText('Local databases');
    fireEvent.click(screen.getByRole('button', { name: 'Preview plan' }));
    const plan = await screen.findByLabelText('Database plan');
    expect(calls.some(c => c.url === '/api/environment/database/create')).toBe(false);
    expect(plan.textContent).toContain('compose.one-connect.yaml');
    expect(plan.textContent).toContain('Its contents are never shown');
    expect(within(plan).getByText('network')).toBeTruthy();
    expect(plan.textContent).toContain(shellQuote([...base, 'pull', 'db']));
    fireEvent.click(within(plan).getByRole('button', { name: 'Create these files' }));
    await within(plan).findByRole('button', { name: 'Request image pull' });
    expect(calls.find(c => c.url === '/api/environment/database/create')?.body).toEqual({ kind: 'postgres', service: 'db', database: 'app', user: 'app', version: '16-alpine', port: 5432 });
    expect(calls.some(c => c.url === '/api/environment/actions')).toBe(false);
    fireEvent.click(within(plan).getByRole('button', { name: 'Request image pull' }));
    await waitFor(() => expect(calls.find(c => c.url === '/api/environment/actions')?.body).toEqual({ action: 'pull', services: ['db'] }));
  });

  it('quotes shell arguments safely', () => {
    expect(shellQuote(['psql', '-c', "select 'x'", '/a b'])).toBe(`psql -c 'select '\\''x'\\''' '/a b'`);
  });
});

describe('Project intake preview', () => {
  it('reports exact Git state and detected declarations without claiming to index uncommitted work', () => {
    const i: Inspection = {
      path: '/repos/shop', name: 'shop',
      git: { state: 'dirty', root: '/repos/shop', head: 'a'.repeat(40), branch: 'main', integrationBranch: null, integrationHead: null, dirtyFiles: 2, untrackedFiles: 1 },
      intake: { indexable: true, revision: 'a'.repeat(40), ref: 'main', message: 'Dictionary indexes committed main at aaaaaaaaaaaa. 2 changed and 1 untracked files are excluded until committed.', steps: [] },
      frameworks: ['next', 'react'], packageManager: 'pnpm', checks: [{ name: 'test', command: 'pnpm run test', source: 'package.json' }],
      compose: { file: '/repos/shop/compose.yaml', project: 'shop', services: [{ name: 'web', image: 'node:22', build: false, healthcheck: false }], warnings: [] },
      dockerfiles: ['Dockerfile'], config: { existing: null, bound: null, error: null }, warnings: [],
    };
    render(<IntakePreview i={i} />);
    expect(screen.getByText('uncommitted changes')).toBeTruthy();
    expect(screen.getByText(/excluded until committed/)).toBeTruthy();
    expect(screen.getByText(/no project scripts were run/)).toBeTruthy();
    expect(screen.getByText('test: pnpm run test')).toBeTruthy();
    expect(screen.getByText(/web \(node:22\) · no healthcheck/)).toBeTruthy();
  });
});
