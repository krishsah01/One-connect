// SPDX-License-Identifier: Apache-2.0
// Mac app bridge. Every daemon call names the active project; the native shell routes it to that
// project's own engine and token. A response that arrives after a switch is dropped, so one
// project's data never renders in another's view.
import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
export const isDesktop = '__TAURI_INTERNALS__' in window;
export interface Bootstrap { websocket: string; mode: 'offline-demo' | 'project'; project: string; name: string }
export interface ProjectEntry {
  id: string; name: string; config: string; repo: string; generated: boolean; addedAt: number; lastOpenedAt: number | null;
  onboarding: Inspection | null; running?: boolean; active?: boolean; terminals?: number;
}
export interface ProjectList { projects: ProjectEntry[]; active: string | null; demo: { running: boolean; active: boolean; terminals: number } }
export interface IntakeStep { id: string; title: string; detail: string; commands: string[][]; runIn: 'approved-action' | 'project-terminal' }
export interface Inspection {
  path: string; name: string;
  git: { state: 'not_git' | 'not_root' | 'no_commits' | 'dirty' | 'clean'; root: string | null; head: string | null; branch: string | null; integrationBranch: string | null; integrationHead: string | null; dirtyFiles: number; untrackedFiles: number };
  intake: { indexable: boolean; revision: string | null; ref: string | null; message: string; steps: IntakeStep[] };
  frameworks: string[]; packageManager: string | null; checks: { name: string; command: string; source: string }[];
  compose: { file: string; project: string; services: { name: string; image: string | null; build: boolean; healthcheck: boolean }[]; warnings: string[] } | null;
  dockerfiles: string[]; config: { existing: string | null; bound: boolean | null; error: string | null }; warnings: string[];
}
export interface GitActionPlan { kind: 'clone' | 'git-init'; argv: string[]; target: string; network: boolean; summary: string; digest: string; url?: string }
export interface PendingPlan { approvalId: string; plan: GitActionPlan; expiresInSeconds: number }
export const DEMO_PROJECT = 'demo';

/** Native commands reject with plain strings; surface them as errors with a message. */
function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args).catch((e: unknown) => { throw e instanceof Error ? e : new Error(String(e)); });
}

let active: Bootstrap | null = null;
let ready: Promise<Bootstrap> | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

export function ensureDesktop(): Promise<Bootstrap | null> {
  if (!isDesktop) return Promise.resolve(null);
  return ready ??= call<Bootstrap>('desktop_bootstrap', { project: null }).then(b => { active = b; notify(); return b; }).catch(e => { ready = null; throw e; });
}
export const activeProject = () => active;
export function useActiveProject(): Bootstrap | null { return useSyncExternalStore(l => { listeners.add(l); return () => listeners.delete(l); }, () => active); }

export class ProjectSwitched extends Error { constructor() { super('Project switched'); } }
export async function desktopRequest(path: string, init: { method?: string; body?: unknown }) {
  const b = await ensureDesktop();
  const project = b!.project;
  const r = await call('daemon_request', { project, path, method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'), body: init.body ?? null });
  if (active?.project !== project) throw new ProjectSwitched();
  return r;
}
export async function websocketUrl(): Promise<string> {
  if (!isDesktop) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const b = await ensureDesktop();
  return (await call<Bootstrap>('desktop_bootstrap', { project: b!.project })).websocket;
}
/** Make `id` the active project. Engines of other projects keep running with their runs. */
export async function switchProject(id: string): Promise<Bootstrap> {
  await call('project_activate', { project: id });
  const b = await call<Bootstrap>('desktop_bootstrap', { project: id });
  active = b; ready = Promise.resolve(b); notify();
  return b;
}
/** Restart the open project's engine if it exited; a no-op while it is running. */
export async function restartActiveEngine() { if (isDesktop && active) await call('project_start', { project: active.project }); }
export const listProjects = () => call<ProjectList>('projects_list');
export const chooseFolder = (purpose: 'project' | 'parent') => call<string>('project_choose_folder', { purpose });
export const inspectFolder = (path: string) => call<Inspection>('project_inspect', { path });
export const addProject = (path: string, name?: string) => call<ProjectEntry>('project_add', { path, name: name || null });
export const startProject = (id: string) => call('project_start', { project: id });
export const stopProject = (id: string) => call('project_stop', { project: id });
export const removeProject = (id: string) => call('project_remove', { project: id });
export const killAllProjects = () => call<Record<string, { stopped?: number; error?: string }>>('projects_kill_all');
export const planClone = (url: string, parent: string, name?: string) => call<PendingPlan>('project_clone_plan', { url, parent, name: name || null });
export const approveClone = (approvalId: string, digest: string) => call<ProjectEntry>('project_clone_approve', { approvalId, digest });
export const planGitInit = (path: string) => call<PendingPlan>('project_init_plan', { path });
export const approveGitInit = (approvalId: string, digest: string) => call<Inspection>('project_init_approve', { approvalId, digest });
/** A request to one specific project's engine, used for per-project status and stop controls. */
export const projectRequest = <T,>(project: string, path: string, method = 'GET', body: unknown = null) => call<T>('daemon_request', { project, path, method, body });
export async function chooseProject() { const id = await call<string>('choose_project'); await switchProject(id); }
export async function chooseVault():Promise<string> { return call('choose_vault'); }
