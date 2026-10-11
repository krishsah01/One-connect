// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { CodeHostConfig, ControlState, GraphifyConfig, InfraConfig, Policy, ProjectConfig } from '@acc/core';
import { Badge, ErrorLine, useAction } from '../components/common';
import { Appearance } from '../components/Appearance';
import { DesignerSkills } from '../components/designer/DesignerSkills';
import { api, post } from '../lib/api';

interface Draft { project: ProjectConfig; policies: Policy; code_host: CodeHostConfig | null; infra: InfraConfig | null; graphify: GraphifyConfig }
interface Snapshot { settings: Draft; revision: string; tracker: { type: string } }
const list = (value: string) => value.split(',').map(x => x.trim()).filter(Boolean);

export function Settings({ state }: { state: ControlState }) {
  const navigate = useNavigate();
  const { busy, error, run } = useAction();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [floor, setFloor] = useState('{}');
  const [loadError, setLoadError] = useState('');
  const load = async () => { const value = await api<Snapshot>('/api/settings'); setSnapshot(value); setDraft(value.settings); setFloor(JSON.stringify(value.settings.policies.quality_floor, null, 2)); };
  useEffect(() => { let active = true; void api<Snapshot>('/api/settings').then(value => { if (active) { setSnapshot(value); setDraft(value.settings); setFloor(JSON.stringify(value.settings.policies.quality_floor, null, 2)); } }).catch(e => { if (active) setLoadError(String(e.message ?? e)); }); return () => { active = false; }; }, []);
  if (!draft || !snapshot) return <div className="page col" style={{ gap: 20 }}><h1>Settings & policies</h1><Appearance/><ErrorLine error={loadError}/><p className="muted">{loadError ? 'Settings are unavailable. Reopen this project or retry.' : 'Opening project settings…'}</p><button className="btn" disabled={busy} onClick={() => void run(load)}>Retry</button></div>;
  const project = (patch: Partial<ProjectConfig>) => setDraft(d => d && ({ ...d, project: { ...d.project, ...patch } }));
  const policy = (patch: Partial<Policy>) => setDraft(d => d && ({ ...d, policies: { ...d.policies, ...patch } }));
  const host = (patch: Partial<CodeHostConfig>) => setDraft(d => d?.code_host ? ({ ...d, code_host: { ...d.code_host, ...patch } as CodeHostConfig }) : d);
  const infra = (patch: Partial<InfraConfig>) => setDraft(d => d && ({ ...d, infra: { ...(d.infra ?? { finding_issues: 'manual' }), ...patch } }));
  const runtime = draft.project.check_runtime;
  return <div className="page col" style={{ gap: 20 }}>
    <div className="row wrap"><div><div className="eyebrow">{state.project?.name}</div><h1>Settings & policies</h1><p className="muted">Configure this project, then review the exact changes in Decisions.</p></div><span className="spacer"/><button className="btn" disabled={busy} onClick={() => void run(load)}>Reload saved settings</button></div>
    <Appearance/>
    <DesignerSkills/>
    <ErrorLine error={error || loadError}/>
    <form className="col" style={{ gap: 20 }} onSubmit={e => { e.preventDefault(); void run(async () => {
      const quality = JSON.parse(floor) as unknown;
      if (!quality || typeof quality !== 'object' || Array.isArray(quality) || Object.values(quality).some(v => typeof v !== 'string')) throw new Error('Quality floors must map work categories to model-class descriptions.');
      const settings = { ...draft, policies: { ...draft.policies, quality_floor: quality } };
      const result = await post<{ decision: { id: string } }>('/api/settings/request', { settings, expected: snapshot.revision });
      navigate(`/decisions?focus=${encodeURIComponent(result.decision.id)}`);
    }); }}>
      <fieldset className="col" disabled={busy} style={{ border: 0, padding: 0, gap: 20 }}>
        <section className="card card-b col"><h2>Project</h2><p className="small mono faint">{draft.project.repo}</p><div className="builder-fields">
          <label>Name<input required value={draft.project.name} onChange={e => project({ name: e.target.value })}/></label>
          <label>Integration branch<input required value={draft.project.integration_branch} onChange={e => project({ integration_branch: e.target.value })}/></label>
          <label>Production branch<input value={draft.project.production_branch ?? ''} onChange={e => project({ production_branch: e.target.value || undefined })} placeholder={draft.project.protected_branches[0] ?? 'main'}/></label>
          <label>Protected branches<input required value={draft.project.protected_branches.join(', ')} onChange={e => project({ protected_branches: list(e.target.value) })}/><span className="small faint">Add protections here. Existing protected branches cannot be removed.</span></label>
        </div></section>
        <section className="card card-b col"><h2>Checks & containers</h2><p className="small muted">Check commands run in the configured project container. Saving settings does not run a command, build an image or pull anything.</p>
          <div className="builder-fields">{['test', 'typecheck', 'lint', 'build'].map(name => <label key={name}>{name}<input value={draft.project.checks[name] ?? ''} onChange={e => { const checks = { ...draft.project.checks }; if (e.target.value) checks[name] = e.target.value; else delete checks[name]; project({ checks }); }}/></label>)}
          <label>Required check names<input value={(draft.project.required_checks ?? Object.keys(draft.project.checks)).join(', ')} onChange={e => project({ required_checks: list(e.target.value) })}/></label>
          <label>Runtime<select value={runtime?.mode ?? 'none'} onChange={e => project({ check_runtime: e.target.value === 'docker' ? { mode: 'docker', image: '', endpoint: 'unix:///var/run/docker.sock', cpus: 1, memory_mb: 512, pids: 128, workspace_mb: 1024, timeout_seconds: 900 } : undefined })}><option value="none">Not configured · checks unavailable</option><option value="docker">Docker</option>{runtime?.mode === 'host-fixture' && <option value="host-fixture">Offline test fixture · existing configuration</option>}</select></label>
          {runtime?.mode === 'docker' && <><label>Installed check image<input required value={runtime.image} onChange={e => project({ check_runtime: { ...runtime, image: e.target.value } })} placeholder="node:24-alpine"/></label><label>Local Docker socket<input required value={runtime.endpoint} onChange={e => project({ check_runtime: { ...runtime, endpoint: e.target.value } })}/></label><label>Check timeout (seconds)<input required type="number" min={1} max={3600} value={runtime.timeout_seconds} onChange={e => project({ check_runtime: { ...runtime, timeout_seconds: Number(e.target.value) } })}/></label></>}
          </div><Link to="/workspace">Manage project containers and databases</Link>
        </section>
        <section className="card card-b col"><h2>Models & coordination</h2><div className="builder-fields">
          <label>Allowed model patterns<input value={(draft.policies.allowed_models ?? []).join(', ')} onChange={e => policy({ allowed_models: list(e.target.value).length ? list(e.target.value) : undefined })} placeholder="Empty means all models above the quality floor"/></label>
          <label>Denied model patterns<input value={draft.policies.denied_models.join(', ')} onChange={e => policy({ denied_models: list(e.target.value) })}/></label>
          <label>No-event stall threshold (minutes)<input type="number" min="0.1" step="0.1" value={draft.policies.stall.no_event_minutes} onChange={e => policy({ stall: { ...draft.policies.stall, no_event_minutes: Number(e.target.value) } })}/></label>
          <label>Pending approval alert (minutes)<input type="number" min="0.1" step="0.1" value={draft.policies.stall.approval_pending_minutes} onChange={e => policy({ stall: { ...draft.policies.stall, approval_pending_minutes: Number(e.target.value) } })}/></label>
        </div><label className="row"><input type="checkbox" checked={draft.policies.newest_model_rule} onChange={e => policy({ newest_model_rule: e.target.checked })}/>Require the newest allowed model at dispatch</label><label className="row"><input type="checkbox" checked={draft.policies.auto_dispatch_next} onChange={e => policy({ auto_dispatch_next: e.target.checked })}/>Automatically promote and dispatch Next when policy allows</label><label>Quality floors<textarea rows={4} value={floor} onChange={e => setFloor(e.target.value)} spellCheck={false}/><span className="small faint">JSON mapping, for example {'{"code":"sonnet-class high","research":"pro-class"}'}. Unknown model quality blocks required floors.</span></label></section>
        <section className="card card-b col"><div className="row"><h2>Code host</h2><span className="spacer"/><Badge>Read access disabled until approved</Badge></div><label>Provider<select value={draft.code_host?.provider ?? 'none'} onChange={e => setDraft(d => d && ({ ...d, code_host: e.target.value === 'github' ? { provider: 'github', repo: '', activated: false, host: 'api.github.com', scopes: ['repo:read'], finding_issues: 'manual' } : e.target.value === 'gitlab' ? { provider: 'gitlab', project: '', activated: false, host: 'gitlab.com', scopes: ['read_api'], finding_issues: 'manual' } : null }))}><option value="none">None</option><option value="github">GitHub</option><option value="gitlab">GitLab</option></select></label>
          {draft.code_host && <div className="builder-fields">{draft.code_host.provider === 'github' ? <label>Repository<input required value={draft.code_host.repo} onChange={e => host({ repo: e.target.value } as Partial<CodeHostConfig>)} placeholder="owner/name"/></label> : <label>Project path or ID<input required value={draft.code_host.project} onChange={e => host({ project: e.target.value } as Partial<CodeHostConfig>)}/></label>}<label>API hostname<input required value={draft.code_host.host ?? ''} onChange={e => host({ host: e.target.value })}/></label><label>Requested read scopes<input required value={draft.code_host.scopes.join(', ')} onChange={e => host({ scopes: list(e.target.value) })}/></label></div>}
          <p className="small muted">After saving, approve this exact connection in <Link to="/connectors">Connectors</Link>. Protection and CI stay unknown until a real read succeeds.</p>
        </section>
        <section className="card card-b col"><h2>Hosting & database health</h2><p className="small muted">Read-only connections, saved disabled. Tokens belong in the connection key store.</p><div className="builder-fields">
          <label>Vercel project ID<input value={draft.infra?.vercel?.project ?? ''} onChange={e => infra({ vercel: e.target.value ? { ...(draft.infra?.vercel ?? { activated: false, host: 'api.vercel.com', scopes: ['deployments:read'] }), project: e.target.value } : undefined })}/></label>
          <label>Supabase project reference<input value={draft.infra?.supabase?.project_ref ?? ''} onChange={e => infra({ supabase: e.target.value ? { ...(draft.infra?.supabase ?? { activated: false, host: 'api.supabase.com', scopes: ['database:read'], migrations_dir: 'supabase/migrations' }), project_ref: e.target.value } : undefined })}/></label>
          {draft.infra?.supabase && <label>Migrations folder<input value={draft.infra.supabase.migrations_dir} onChange={e => infra({ supabase: { ...draft.infra!.supabase!, migrations_dir: e.target.value } })}/></label>}
        </div><Link to="/release">View release gates and migration history</Link></section>
        <section className="card card-b col"><h2>One Ask & Graphify</h2><p className="small muted">Code graph, project notes and retrieval stay bound to the same integration revision. Graphify uses your installed tool for code-only extraction; paid semantic extraction stays off.</p><label className="row"><input type="checkbox" checked={draft.graphify.enabled} onChange={e => setDraft(d => d && ({ ...d, graphify: { ...d.graphify, enabled: e.target.checked } }))}/>Enable Graphify</label><label className="row"><input type="checkbox" checked={draft.graphify.auto_update} onChange={e => setDraft(d => d && ({ ...d, graphify: { ...d.graphify, auto_update: e.target.checked } }))}/>Refresh automatically when integration changes</label><label>Installed Graphify binary<input value={draft.graphify.binary ?? ''} onChange={e => setDraft(d => d && ({ ...d, graphify: { ...d.graphify, binary: e.target.value || undefined } }))} placeholder="Optional absolute path"/></label><p className="small faint">Missing tools are shown as unavailable. Saving never downloads a binary or embedding model. <Link to="/docs">Connect an Obsidian vault, enable local embeddings and ask your docs</Link>.</p></section>
        <section className="card card-b col"><h2>Accounts & vendor terms</h2><p className="small muted">Vendors let a person sign in to their own, unmodified CLI with their own plan. Using one login for other people, hosting this app, or running it for customers needs API keys, billed to whoever owns each key.</p>
          <div className="builder-fields">
            <label>Who uses this install<select value={draft.policies.accounts.mode} onChange={e => policy({ accounts: { ...draft.policies.accounts, mode: e.target.value as Policy['accounts']['mode'] } })}><option value="personal">Only me, on this Mac (subscription sign-in allowed)</option><option value="api-keys-only">Shared, hosted or team use (API keys only)</option></select><span className="small faint">API keys only refuses every subscription login at dispatch.</span></label>
            <label>Re-confirm own-account use every (days)<input type="number" min="1" max="365" step="1" value={draft.policies.accounts.terms_max_age_days} onChange={e => policy({ accounts: { ...draft.policies.accounts, terms_max_age_days: Number(e.target.value) } })}/><span className="small faint">You review the vendor terms again after this, and whenever they or the signed-in account change.</span></label>
            <label>Remind to rotate API keys after (days)<input type="number" min="1" max="730" step="1" value={draft.policies.accounts.api_key_rotation_days} onChange={e => policy({ accounts: { ...draft.policies.accounts, api_key_rotation_days: Number(e.target.value) } })}/><span className="small faint">A reminder only; it never blocks work.</span></label>
          </div>
        </section>
        <section className="card card-b col"><h2>Safety & privacy</h2><div className="row wrap"><Badge tone="ok">Zero extra spend by default</Badge><Badge tone="ok">Strict connector scope</Badge><Badge>Protected branch pushes blocked</Badge></div><label>Environment variable names to redact<input value={draft.policies.redact_env.join(', ')} onChange={e => policy({ redact_env: list(e.target.value) })}/><span className="small faint">Names only. Never paste secrets into settings or agent prompts.</span></label><p className="small muted">Required approvals: {draft.policies.require_approval.join(', ')}. Configure per-agent instructions and path scopes in <Link to="/setup">Agents</Link>, and notification quiet hours in <Link to="/remote">Phone & alerts</Link>.</p><p className="small faint">Tracker: {snapshot.tracker.type}. Import issues through Connectors; configuring these settings does not activate a tracker.</p></section>
        <div className="row wrap"><button type="submit" className="btn primary">Review settings changes</button><span className="small faint">Review, then confirm. Active or queued work must finish first.</span></div>
      </fieldset>
    </form>
  </div>;
}
