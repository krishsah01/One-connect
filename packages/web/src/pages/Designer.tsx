// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Designer studio: a brief becomes a reviewable issue and assignment, runs in the agent's own CLI on
// the durable run stream, and its captured mock is reviewed against a versioned project contract.
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { designAgentEligibility, jobStatus, mockGate, type ControlState } from '@acc/core';
import { Badge, ErrorLine } from '../components/common';
import { BriefForm } from '../components/designer/BriefForm';
import { ContractEditor } from '../components/designer/ContractEditor';
import { JobCard } from '../components/designer/JobCard';
import { Tabs, tabPanel, type ContractResponse, type StudioOverview } from '../components/designer/shared';
import '../components/designer/designer.css';
import { api } from '../lib/api';

type Tab = 'studio' | 'system' | 'skills';
const TABS: { id: Tab; label: string }[] = [{ id: 'studio', label: 'Studio' }, { id: 'system', label: 'Design system' }, { id: 'skills', label: 'Skills and sources' }];

export function Designer({ state }: { state: ControlState }) {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some(t => t.id === params.get('tab')) ? params.get('tab') : 'studio') as Tab;
  const setTab = (t: Tab) => setParams(p => { const n = new URLSearchParams(p); n.set('tab', t); return n; }, { replace: true });
  const contract = state.design ? { hash: state.design.hash, version: state.design.version } : null;
  const jobs = Object.values(state.designStudio?.jobs ?? {}).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const phases = jobs.map(j => jobStatus(j, state).phase);
  const steps = [
    { done: Boolean(contract), label: 'Save a design system', detail: contract ? `contract v${contract.version}` : 'nothing saved yet' },
    { done: jobs.length > 0, label: 'Brief a reviewable task', detail: jobs.length ? `${jobs.length} job${jobs.length === 1 ? '' : 's'}` : 'issue + draft assignment' },
    { done: phases.includes('captured'), label: 'Run and capture', detail: 'real transcript, immutable revision' },
    { done: Object.values(state.designStudio?.jobs ?? {}).some(j => j.kind === 'engineering' && j.artifactId && Object.values(state.mocks ?? {}).find(m => m.id === j.artifactId)?.revisions.some(r => r.rev === j.fromRev && mockGate(r, state.design?.hash ?? null).state === 'approved')), label: 'Review and hand off', detail: 'checklist, evidence, bundle' },
  ];
  return <div className="page connected-page studio-page">
    <div className="page-heading"><div><div className="eyebrow">One Connect studio</div><h1>Designer</h1><p>Brief a design agent, watch it work, review the interactive mock against your project's versioned design system, and hand the approved identity to engineering.</p></div>
      <div className="row wrap"><Link className="btn" to="/mocks">Mocks and reviews</Link><Link className="btn" to="/skills">Project skills</Link><Badge tone={contract ? 'ok' : 'warn'}>{contract ? `Contract v${contract.version}` : 'No contract saved'}</Badge></div></div>
    <ol className="studio-steps" aria-label="Studio workflow">{steps.map(s => <li key={s.label} data-done={s.done}><b>{s.label}</b><br /><span className="faint">{s.detail}</span></li>)}</ol>
    <Tabs idBase="designer" label="Designer sections" tabs={TABS} value={tab} onChange={setTab} />
    <div {...tabPanel('designer', tab)}>
      {tab === 'studio' && <Studio state={state} onNeedContract={() => setTab('system')} />}
      {tab === 'system' && <ContractEditor />}
      {tab === 'skills' && <SkillsPanel />}
    </div>
  </div>;
}

function Studio({ state, onNeedContract }: { state: ControlState; onNeedContract: () => void }) {
  const [tooling, setTooling] = useState<StudioOverview['tooling'] | null>(null);
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => { let alive = true; void api<StudioOverview>('/api/designer/studio').then(r => alive && setTooling(r.tooling)).catch(() => undefined); return () => { alive = false; }; }, []);
  const overview: StudioOverview = useMemo(() => ({
    contract: state.design ? { hash: state.design.hash, version: state.design.version } : null,
    agents: Object.values(state.agents).map(a => ({ id: a.id, name: a.config.name, adapter: a.config.adapter, status: a.status, eligibility: designAgentEligibility(a) })),
    jobs: [], tooling: tooling ?? { playwright: { found: false, path: null, note: '' } },
  }), [state.design?.hash, state.agents, tooling]);
  const all = Object.values(state.designStudio?.jobs ?? {}).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const shown = filter === 'all' ? all : all.filter(j => !['canceled'].includes(jobStatus(j, state).phase) && (j.id === focus || !['captured', 'prepared'].includes(jobStatus(j, state).phase) || Date.parse(j.createdAt) > Date.now() - 24 * 3600_000));
  return <div className="studio-grid">
    <div className="studio-stack">
      {!state.design && <div className="banner tone-warn small" role="note">Design jobs freeze the saved project contract. <button type="button" className="btn sm" onClick={onNeedContract}>Open the design system</button></div>}
      <BriefForm overview={overview} onCreated={v => { setFocus(v.job.id); setFilter('active'); }} />
      {tooling && <p className="small faint">Browser checks: {tooling.playwright.found ? <>Playwright found at <code>{tooling.playwright.path}</code>.</> : 'Playwright CLI not found on PATH; browser checks stay pending.'} {tooling.playwright.note}</p>}
    </div>
    <section className="studio-stack" aria-label="Design jobs">
      <div className="row wrap"><h2 className="section">Jobs</h2><span className="spacer" />
        <div className="segmented" role="radiogroup" aria-label="Show jobs"><label><input type="radio" name="jobs-filter" checked={filter === 'active'} onChange={() => setFilter('active')} />Current</label><label><input type="radio" name="jobs-filter" checked={filter === 'all'} onChange={() => setFilter('all')} />All ({all.length})</label></div>
      </div>
      {shown.length === 0 ? <div className="card card-b col empty"><b>No design jobs {filter === 'active' && all.length ? 'in progress' : 'yet'}</b><span className="small muted">Write a brief to create an issue and a draft assignment. You review the exact prompt and pre-flight, then dispatch. The agent's real output streams here, and its questions wait for your answer.</span></div>
        : shown.map(j => <JobCard key={j.id} job={j} state={state} open={j.id === focus} />)}
    </section>
  </div>;
}

function SkillsPanel() {
  const [data, setData] = useState<ContractResponse | null>(null), [err, setErr] = useState('');
  useEffect(() => { void api<ContractResponse>('/api/designer/contract').then(setData).catch(e => setErr((e as Error).message)); }, []);
  if (err) return <ErrorLine error={`Could not load skills: ${err}`} />;
  if (!data) return <div className="empty" role="status">Loading skills…</div>;
  const sets: [string, readonly string[]][] = [['Mock generation (design, ui, mock labels)', data.skillSets.design], ['Engineering implementation', data.skillSets.implementation], ['Independent review', data.skillSets.review]];
  return <div className="col" style={{ gap: 18 }}>
    <div className="banner tone-info small" role="note">Assignments carry only each skill’s one-line description. Agents load a skill with <code>get_skill</code> when it applies and open references only when the skill points to them. Skills guide execution; the project contract controls the visual identity.</div>
    <table className="checks-table"><thead><tr><th>Skill</th><th>What it is for</th><th>Source</th><th>License</th><th>Version</th>{sets.map(([n]) => <th key={n}>{n.split(' (')[0]}</th>)}</tr></thead>
      <tbody>{data.skills.map(s => <tr key={s.id}><td><b>{s.name}</b><br /><code className="faint">{s.id}</code></td><td>{s.purpose}</td><td>{s.source.startsWith('https://') ? <a href={s.source} target="_blank" rel="noreferrer noopener">{s.source.replace('https://github.com/', '')}</a> : s.source}</td><td><Badge>{s.license}</Badge></td><td className="mono">{s.version.slice(0, 12)}</td>{sets.map(([n, ids]) => <td key={n}>{ids.includes(s.id) ? <Badge tone="ok">selected</Badge> : <span className="faint">—</span>}</td>)}</tr>)}</tbody></table>
    <p className="small muted">Taste Skill, Vercel Web Interface Guidelines and the VoltAgent DESIGN.md analyses are pinned upstream text with their MIT notices; selected resources came from the owner-approved Open Design revision 53231d4 under Apache-2.0. The Playwright entry is a guide for an already-installed official CLI, not a bundled executable. Skills marked One Connect are original. Hashes are verified on every read; notices are in THIRD_PARTY_NOTICES.md.</p>
    <p className="small muted">Custom agents can add project skills in <Link to="/skills">Skills</Link>. The review checklist every approval uses: {data.checklist.map(c => c.label).join(', ')}.</p>
  </div>;
}
