// SPDX-License-Identifier: Apache-2.0
// Desktop mode against a fake native shell: project-bound requests, switching and gated intake.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {};
  return { calls, handlers };
});
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    native.calls.push({ cmd, args });
    const h = native.handlers[cmd];
    if (!h) throw `unexpected command ${cmd}`;
    return h(args);
  }),
}));
vi.mock('../src/lib/store', async () => {
  const d = await import('../src/lib/desktop');
  return { openProject: vi.fn((id: string) => d.switchProject(id)) };
});

import { desktopRequest, ensureDesktop, ProjectSwitched, switchProject } from '../src/lib/desktop';
import { Projects } from '../src/pages/Projects';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const entry = (id: string, name: string, running: boolean) => ({ id, name, config: `/cfg/${name}.yaml`, repo: `/repos/${name}`, generated: true, addedAt: 1, lastOpenedAt: null, onboarding: null, running, active: id === A, terminals: running ? 1 : 0 });

let active = A;
beforeEach(() => {
  native.calls.length = 0;
  active = A;
  Object.assign(native.handlers, {
    desktop_bootstrap: (a: { project: string | null }) => ({ websocket: `ws://127.0.0.1:1/ws?ticket=${a.project ?? active}`, mode: 'project', project: a.project ?? active, name: (a.project ?? active) === A ? 'alpha' : 'beta' }),
    project_activate: (a: { project: string }) => { active = a.project; return null; },
    projects_list: () => ({ projects: [entry(A, 'alpha', true), entry(B, 'beta', true)], active, demo: { running: false, active: false, terminals: 0 } }),
    daemon_request: (a: { project: string; path: string }) => a.path === '/api/project/onboarding' ? { answer: { state: a.project === A ? 'ready' : 'partial', revision: a.project.repeat(1).slice(0, 40), ref: 'main', files: 3, excludedFiles: 0, truncated: false, error: null }, inspection: {} } : { project: a.project, path: a.path },
    projects_kill_all: () => ({ [A]: { stopped: 2 }, [B]: { stopped: 0 } }),
    project_choose_folder: () => '/tmp/parent',
    project_clone_plan: (a: { url: string; parent: string }) => ({ approvalId: 'appr1', expiresInSeconds: 120, plan: { kind: 'clone', argv: ['git', '-c', 'core.hooksPath=/dev/null', 'clone', '--no-recurse-submodules', '--', a.url, `${a.parent}/shop`], target: `${a.parent}/shop`, network: true, summary: `Clone ${a.url} into ${a.parent}/shop`, digest: 'c'.repeat(64) } }),
    project_clone_approve: () => entry('c'.repeat(64), 'shop', false),
  });
});
afterEach(cleanup);

describe('desktop bridge', () => {
  it('binds every request to the active project and drops responses that land after a switch', async () => {
    await ensureDesktop();
    expect(await desktopRequest('/api/state', {})).toEqual({ project: A, path: '/api/state' });
    let release!: () => void;
    native.handlers.daemon_request = (a) => new Promise(r => { release = () => r({ project: a.project }); });
    const slow = desktopRequest('/api/state', {});
    await waitFor(() => expect(release).toBeTypeOf('function'));
    native.handlers.daemon_request = (a) => ({ project: a.project });
    await switchProject(B);
    release();
    await expect(slow).rejects.toBeInstanceOf(ProjectSwitched);
    expect(await desktopRequest('/api/state', {})).toEqual({ project: B });
    expect(native.calls.filter(c => c.cmd === 'daemon_request').map(c => c.args.project)).toEqual([A, A, B]);
    await switchProject(A);
  });
});

describe('Projects page', () => {
  it('lists running projects with their own Dictionary status and kills runs in every project', async () => {
    await switchProject(A);
    render(<MemoryRouter><Projects /></MemoryRouter>);
    const alpha = await screen.findByLabelText('Project alpha');
    const beta = screen.getByLabelText('Project beta');
    await waitFor(() => expect(within(alpha).getByText(/Dictionary ready/)).toBeTruthy());
    expect(within(beta).getByText(/Dictionary partial/)).toBeTruthy();
    expect(within(alpha).getByText('open')).toBeTruthy();
    expect((within(alpha).getByRole('button', { name: 'Stop engine' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(beta).getByRole('button', { name: 'Stop engine' }) as HTMLButtonElement).disabled).toBe(false);
    const onboardingCalls = native.calls.filter(c => c.cmd === 'daemon_request' && c.args.path === '/api/project/onboarding').map(c => c.args.project);
    expect(new Set(onboardingCalls)).toEqual(new Set([A, B]));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Kill switch: all projects' }));
    await waitFor(() => expect(native.calls.some(c => c.cmd === 'projects_kill_all')).toBe(true));
  });

  it('prepares a clone, shows the exact command, and runs it only with the approval and digest', async () => {
    render(<MemoryRouter><Projects /></MemoryRouter>);
    fireEvent.change(await screen.findByLabelText('Repository URL'), { target: { value: 'https://example.test/org/shop.git' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose parent folder…' }));
    await screen.findByText('/tmp/parent');
    expect(native.calls.some(c => c.cmd === 'project_clone_approve')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Prepare clone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve Git action' });
    expect(dialog.textContent).toContain('clone --no-recurse-submodules -- https://example.test/org/shop.git /tmp/parent/shop');
    expect(dialog.textContent).toContain('network');
    expect(native.calls.some(c => c.cmd === 'project_clone_approve')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and run' }));
    await waitFor(() => expect(native.calls.find(c => c.cmd === 'project_clone_approve')?.args).toEqual({ approvalId: 'appr1', digest: 'c'.repeat(64) }));
    await waitFor(() => expect(native.calls.some(c => c.cmd === 'project_activate' && c.args.project === 'c'.repeat(64))).toBe(true));
  });
});
