// SPDX-License-Identifier: Apache-2.0
// Add, switch and manage projects. Each project has its own engine, database, agents, Docker
// namespace and terminals; switching only changes which one this window shows.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Badge, ErrorLine, useAction } from '../components/common';
import { api } from '../lib/api';
import {
  addProject, approveClone, approveGitInit, chooseFolder, DEMO_PROJECT, inspectFolder, isDesktop, killAllProjects, listProjects, planClone, planGitInit, projectRequest,
  removeProject, startProject, stopProject, useActiveProject, type Inspection, type PendingPlan, type ProjectList,
} from '../lib/desktop';
import { openProject } from '../lib/store';
import type { Tone } from '../lib/format';

interface AnswerStatus { state: string; revision: string | null; ref: string | null; files: number; excludedFiles: number; truncated: boolean; error: string | null }
interface Onboarding { inspection: Inspection; answer: AnswerStatus }
const GIT_LABEL: Record<Inspection['git']['state'], [string, Tone]> = { clean: ['committed', 'ok'], dirty: ['uncommitted changes', 'warn'], no_commits: ['needs first commit', 'warn'], not_git: ['not a Git repository', 'crit'], not_root: ['not the repository root', 'crit'] };
const ANSWER_TONE: Record<string, Tone> = { ready: 'ok', partial: 'warn', extracting: 'info', indexing: 'info', missing: 'idle', interrupted: 'warn', failed: 'crit', error: 'crit' };
const cmd = (argv: string[]) => argv.map(a => /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`).join(' ');

export function Projects() {
  if (!isDesktop) return <BrowserProjects />;
  return <DesktopProjects />;
}

function BrowserProjects() {
  const [o, setO] = useState<Onboarding | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { void api<Onboarding>('/api/project/onboarding').then(setO).catch(e => setError((e as Error).message)); }, []);
  return <div className="page col" style={{ gap: 18 }}><h1 style={{ fontSize: 20 }}>Project</h1>
    <p className="muted">Adding and switching projects happens in the Mac app, where each project gets its own engine. This browser is signed in to one project.</p>
    {error && <ErrorLine error={error} />}
    {o && <section className="card"><div className="card-h"><h2>{o.inspection.name}</h2><AnswerBadge a={o.answer} /></div><div className="card-b"><IntakePreview i={o.inspection} /></div></section>}
  </div>;
}

function DesktopProjects() {
  const active = useActiveProject();
  const navigate = useNavigate();
  const [list, setList] = useState<ProjectList | null>(null);
  const [answers, setAnswers] = useState<Record<string, AnswerStatus | string>>({});
  const { busy, error, run } = useAction();
  const refresh = useCallback(async () => {
    const l = await listProjects();
    setList(l);
    const next: Record<string, AnswerStatus | string> = {};
    await Promise.all(l.projects.filter(p => p.running).map(async p => { try { next[p.id] = (await projectRequest<Onboarding>(p.id, '/api/project/onboarding')).answer; } catch (e) { next[p.id] = (e as Error).message ?? String(e); } }));
    setAnswers(next);
  }, []);
  useEffect(() => { void refresh().catch(() => {}); const t = setInterval(() => void refresh().catch(() => {}), 8000); return () => clearInterval(t); }, [refresh]);
  const open = (id: string) => run(async () => { await openProject(id); navigate('/'); });
  const running = list ? list.projects.filter(p => p.running).length + (list.demo.running ? 1 : 0) : 0;
  return <div className="page col" style={{ gap: 18 }}>
    <div className="row"><h1 style={{ fontSize: 20 }}>Projects</h1><span className="spacer" />
      <button className="btn danger" disabled={busy || !running} title="Engage the kill switch in every running project" onClick={() => { if (window.confirm(`Stop every agent run in all ${running} running projects and block new dispatch?`)) void run(async () => { const r = await killAllProjects(); const failed = Object.entries(r).filter(([, v]) => v.error); if (failed.length) throw new Error(`Kill switch failed in ${failed.length} project(s): ${failed.map(([, v]) => v.error).join('; ')}`); await refresh(); }); }}>Kill switch: all projects</button></div>
    <p className="muted">Every project runs its own engine with its own database, agents, One Answer index, Docker namespace and terminals. Switching keeps other projects' supervisors and agent runs going; come back to see their dashboards and logs where they left off.</p>
    <ErrorLine error={error} />
    <section className="card"><div className="card-h"><h2>Your projects</h2></div><div className="card-b col" style={{ gap: 0 }}>
      {list?.projects.map(p => <div key={p.id} className="row wrap" style={{ padding: '10px 0', borderBottom: '1px solid var(--line, #2a3240)' }} aria-label={`Project ${p.name}`}>
        <div className="col grow" style={{ gap: 2, minWidth: 260 }}>
          <div className="row wrap"><b>{p.name}</b>{active?.project === p.id && <Badge tone="accent">open</Badge>}<Badge tone={p.running ? 'ok' : 'idle'}>{p.running ? 'running' : 'stopped'}</Badge>
            {p.onboarding && <Badge tone={GIT_LABEL[p.onboarding.git.state][1]}>{GIT_LABEL[p.onboarding.git.state][0]}</Badge>}
            {typeof answers[p.id] === 'object' && <AnswerBadge a={answers[p.id] as AnswerStatus} />}
            {(p.terminals ?? 0) > 0 && <span className="small faint">{p.terminals} terminal{p.terminals === 1 ? '' : 's'}</span>}</div>
          <span className="small mono faint">{p.repo || p.config}</span>
          {typeof answers[p.id] === 'string' && <span className="small muted">{answers[p.id] as string}</span>}
        </div>
        <button className="btn sm primary" disabled={busy || active?.project === p.id} onClick={() => void open(p.id)}>Open</button>
        {p.running ? <>
          <button className="btn sm" disabled={busy} title="Engage this project's kill switch: its agent runs stop, other projects keep going" onClick={() => { if (window.confirm(`Stop all agent runs in ${p.name}?`)) void run(async () => { await projectRequest(p.id, '/api/kill-switch', 'POST', { engaged: true }); await refresh(); }); }}>Stop runs</button>
          <button className="btn sm" disabled={busy || active?.project === p.id} title={active?.project === p.id ? 'Open another project first' : 'Shut down this project\'s engine and close its terminals'} onClick={() => void run(async () => { await stopProject(p.id); await refresh(); })}>Stop engine</button>
        </> : <>
          <button className="btn sm" disabled={busy} onClick={() => void run(async () => { await startProject(p.id); await refresh(); })}>Start engine</button>
          <button className="btn sm" disabled={busy} onClick={() => { if (window.confirm(`Remove ${p.name} from this list? Its repository and saved state stay on disk.`)) void run(async () => { await removeProject(p.id); await refresh(); }); }}>Remove</button>
        </>}
      </div>)}
      {list && <div className="row wrap" style={{ padding: '10px 0' }}><div className="col grow"><div className="row"><b>Offline demo</b>{active?.project === DEMO_PROJECT && <Badge tone="accent">open</Badge>}<Badge tone={list.demo.running ? 'ok' : 'idle'}>{list.demo.running ? 'running' : 'stopped'}</Badge></div><span className="small faint">Scripted agents · no subscription usage</span></div>
        <button className="btn sm" disabled={busy || active?.project === DEMO_PROJECT} onClick={() => void open(DEMO_PROJECT)}>Open</button>
        {list.demo.running && active?.project !== DEMO_PROJECT && <button className="btn sm" disabled={busy} onClick={() => void run(async () => { await stopProject(DEMO_PROJECT); await refresh(); })}>Stop engine</button>}</div>}
    </div></section>
    <AddLocal onAdded={async id => { await refresh(); await open(id); }} />
    <CloneProject onAdded={async id => { await refresh(); await open(id); }} />
  </div>;
}

export function AnswerBadge({ a }: { a: AnswerStatus }) {
  const label = a.state === 'ready' || a.state === 'partial' ? `One Answer ${a.state} · ${a.revision?.slice(0, 10) ?? ''}` : `One Answer ${a.state}`;
  return <Badge tone={ANSWER_TONE[a.state] ?? 'idle'} title={a.error ?? `${a.files} files indexed${a.excludedFiles ? `, ${a.excludedFiles} excluded` : ''}`}>{label}</Badge>;
}

export function IntakePreview({ i }: { i: Inspection }) {
  const [label, tone] = GIT_LABEL[i.git.state];
  return <div className="col" style={{ gap: 6 }} aria-label="Project intake">
    <div className="row wrap"><code>{i.path}</code><Badge tone={tone}>{label}</Badge>{i.git.branch && <span className="small faint">branch {i.git.branch}</span>}</div>
    <span className={`small ${i.intake.indexable ? '' : 'banner tone-warn'}`}>{i.intake.message}</span>
    <span className="small"><b>Detected</b> {i.frameworks.length ? i.frameworks.join(', ') : 'no frameworks'}{i.packageManager && ` · ${i.packageManager}`}{' · detected from files only; no project scripts were run'}</span>
    {i.checks.length > 0 && <span className="small"><b>Declared checks</b> {i.checks.map(c => <code key={c.name} style={{ marginRight: 6 }} title={c.source}>{c.name}: {c.command}</code>)}</span>}
    {i.compose && <span className="small"><b>Compose</b> <code>{i.compose.file}</code> · project <code>{i.compose.project}</code> · services {i.compose.services.map(s => `${s.name}${s.build ? ' (build)' : s.image ? ` (${s.image})` : ''}${s.healthcheck ? '' : ' · no healthcheck'}`).join(', ') || 'none'}</span>}
    {i.dockerfiles.length > 0 && <span className="small"><b>Dockerfiles</b> {i.dockerfiles.join(', ')}</span>}
    <span className="small faint">{i.config.existing ? (i.config.bound ? `Uses ${i.config.existing}, bound to this exact repository.` : `Ignores ${i.config.existing}: ${i.config.error ?? 'it points at another repository'}.`) : 'A private configuration is generated outside the repository; nothing is written into it.'}</span>
    {i.warnings.map(w => <span key={w} className="small banner tone-warn">{w}</span>)}
  </div>;
}

function useCountdown(seconds: number | null) {
  const [left, setLeft] = useState(seconds ?? 0);
  useEffect(() => { if (seconds === null) return; setLeft(seconds); const started = Date.now(); const t = setInterval(() => setLeft(Math.max(0, seconds - Math.round((Date.now() - started) / 1000))), 1000); return () => clearInterval(t); }, [seconds]);
  return left;
}

function PlanApproval({ pending, busy, onApprove, onCancel }: { pending: PendingPlan; busy: boolean; onApprove: () => void; onCancel: () => void }) {
  const left = useCountdown(pending.expiresInSeconds);
  return <div className="banner col" role="dialog" aria-label="Approve Git action">
    <b>{pending.plan.summary}</b>
    <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{cmd(pending.plan.argv)}</pre>
    {pending.plan.network && <span className="small"><Badge tone="warn">network</Badge> Contacts this remote. SSH URLs use your SSH keys or agent; HTTPS credential helpers and password prompts are disabled, so private HTTPS repositories need an SSH URL. Hooks and submodules are disabled.</span>}
    <span className="small faint">{left > 0 ? `Single use · expires in ${left}s` : 'Expired. Prepare it again.'}</span>
    <div className="row"><button className="btn primary" disabled={busy || left === 0} onClick={onApprove}>Approve and run</button><button className="btn" disabled={busy} onClick={onCancel}>Cancel</button></div>
  </div>;
}

function AddLocal({ onAdded }: { onAdded: (id: string) => Promise<void> }) {
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [name, setName] = useState('');
  const [init, setInit] = useState<PendingPlan | null>(null);
  const { busy, error, run } = useAction();
  const inspect = (path: string) => run(async () => { const i = await inspectFolder(path); setInspection(i); setName(i.name); });
  const blocked = !inspection || inspection.git.state === 'not_git' || inspection.git.state === 'not_root';
  return <section className="card"><div className="card-h"><h2>Add a local repository</h2></div><div className="card-b col">
    <p className="small muted">Choose the repository's root folder. One Connect reads its manifests to find frameworks, declared checks and container services without running any of its scripts.</p>
    <div className="row"><button className="btn" disabled={busy} onClick={() => void run(async () => { setInit(null); const path = await chooseFolder('project'); await inspect(path); })}>Choose folder…</button></div>
    {inspection && <>
      <IntakePreview i={inspection} />
      {inspection.intake.steps.map(s => <div key={s.id} className="col small" style={{ gap: 2 }}>
        <b>{s.title}</b><span className="muted">{s.detail}</span>
        {s.runIn === 'approved-action'
          ? <div className="row"><button className="btn sm" disabled={busy || Boolean(init)} onClick={() => void run(async () => setInit(await planGitInit(inspection.path)))}>Review git init</button></div>
          : <span>Run in this project's terminal after adding it: {s.commands.map(c => <code key={c.join(' ')} style={{ marginRight: 6 }}>{cmd(c)}</code>)}</span>}
      </div>)}
      {init && <PlanApproval pending={init} busy={busy} onCancel={() => setInit(null)} onApprove={() => void run(async () => { const i = await approveGitInit(init.approvalId, init.plan.digest); setInit(null); setInspection(i); })} />}
      <div className="row wrap"><label className="small col" style={{ gap: 2 }}>Project name<input aria-label="Project name" value={name} onChange={e => setName(e.target.value)} /></label>
        <button className="btn primary" disabled={busy || blocked} onClick={() => void run(async () => { const p = await addProject(inspection.path, name); setInspection(null); await onAdded(p.id); })}>Add and open</button></div>
      {inspection.git.state === 'no_commits' && <span className="small faint">You can add it now; One Answer reports “needs first commit” and indexes nothing until a commit exists.</span>}
    </>}
    <ErrorLine error={error} />
  </div></section>;
}

function CloneProject({ onAdded }: { onAdded: (id: string) => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [parent, setParent] = useState('');
  const [name, setName] = useState('');
  const [pending, setPending] = useState<PendingPlan | null>(null);
  const { busy, error, run } = useAction();
  return <section className="card"><div className="card-h"><h2>Clone from a Git URL</h2></div><div className="card-b col">
    <p className="small muted">Prepares the exact <code>git clone</code> command first. Nothing touches the network until you approve that command; the approval expires in two minutes and works once.</p>
    <div className="row wrap">
      <label className="small col grow" style={{ gap: 2 }}>Repository URL<input aria-label="Repository URL" placeholder="https://github.com/org/repo.git or git@host:org/repo.git" value={url} onChange={e => { setUrl(e.target.value); setPending(null); }} /></label>
      <label className="small col" style={{ gap: 2 }}>Folder name (optional)<input aria-label="Folder name" value={name} onChange={e => { setName(e.target.value); setPending(null); }} /></label>
    </div>
    <div className="row wrap"><button className="btn" disabled={busy} onClick={() => void run(async () => { setParent(await chooseFolder('parent')); setPending(null); })}>Choose parent folder…</button>{parent && <code className="small">{parent}</code>}
      <button className="btn primary" disabled={busy || !url.trim() || !parent} onClick={() => void run(async () => setPending(await planClone(url.trim(), parent, name.trim())))}>Prepare clone</button></div>
    {pending && <PlanApproval pending={pending} busy={busy} onCancel={() => setPending(null)} onApprove={() => void run(async () => { const p = await approveClone(pending.approvalId, pending.plan.digest); setPending(null); setUrl(''); await onAdded(p.id); })} />}
    <ErrorLine error={error} />
  </div></section>;
}
