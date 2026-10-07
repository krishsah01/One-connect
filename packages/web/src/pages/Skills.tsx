// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { skillAdvice, SkillDraftSchema, SKILL_LIMITS, type ControlState, type DesignSkill, type ProjectSkill, type SkillDraft } from '@acc/core';
import { Badge, ErrorLine, useAction } from '../components/common';
import { api, post } from '../lib/api';

type Builtin = DesignSkill & { references: string[] };
interface Catalog { builtin: Builtin[]; project: ProjectSkill[]; exportDirs: Record<string, string | null> }
interface Detail { skill: ProjectSkill; draft: (SkillDraft & { hash: string }) | null; editable: SkillDraft | null; advice: string[]; usedBy: string[] }
interface Content { file: string; content: string; files: string[] }

const BLANK: SkillDraft = { id: '', name: '', description: '', instructions: '', references: [] };

export function Skills({ state }: { state: ControlState }) {
  const { busy, error, run, setError } = useAction();
  const [catalog, setCatalog] = useState<Catalog | null>(null), [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<Detail | null>(null);
  const [form, setForm] = useState<SkillDraft>(BLANK), [expected, setExpected] = useState<string | null>(null), [isNew, setIsNew] = useState(true);
  const [viewing, setViewing] = useState<{ id: string; version: string | null; content: Content } | null>(null), [notice, setNotice] = useState('');
  const reload = useCallback(async () => { try { setCatalog(await api<Catalog>('/api/skills')); setLoadError(''); } catch (e) { setLoadError((e as Error).message); } }, []);
  useEffect(() => { void reload(); }, [reload]);
  const open = async (id: string) => {
    const d = await api<Detail>(`/api/skills/${id}`);
    setSelected(id); setDetail(d); setForm(d.editable ?? BLANK); setExpected(d.draft?.hash ?? null); setIsNew(false); setViewing(null); setNotice('');
  };
  const parsed = SkillDraftSchema.safeParse(form), advice = parsed.success ? skillAdvice(parsed.data) : [];
  const patch = (p: Partial<SkillDraft>) => setForm(f => ({ ...f, ...p }));
  const view = (id: string, version: string | null, file = 'SKILL.md') => run(async () => setViewing({ id, version, content: await api<Content>(`/api/skills/${id}/content?file=${encodeURIComponent(file)}${version ? `&version=${version}` : ''}`) }));
  const userNames = (ids: string[]) => ids.map(id => state.agents[id]?.config.name ?? id).join(', ');

  return <div className="page connected-page skills-page">
    <div className="page-heading"><div><div className="eyebrow">Project library</div><h1>Skills</h1><p>Reusable, versioned instructions your agents load only when a task needs them.</p></div><button className="btn" onClick={() => { setSelected(null); setDetail(null); setForm(BLANK); setExpected(null); setIsNew(true); setViewing(null); setNotice(''); setError(null); }}>New skill</button></div>
    <div className="banner tone-info small skills-teach" role="note"><b>Keep skills small.</b> Assignments carry only each skill’s one-line description. An agent calls <code>get_skill</code> when the description matches its task, and opens a reference only when SKILL.md points to it. Put the trigger in the description (“Use when…”), the steps in the instructions, and long examples in references.</div>
    {loadError && <ErrorLine error={`Could not load skills: ${loadError}`} />}
    <ErrorLine error={error} />{notice && <p role="status" className="small text-ok">{notice}</p>}
    {!catalog && !loadError ? <div className="empty" role="status">Loading skills…</div> : catalog && <div className="skills-layout">
      <nav className="card card-b col skills-list" aria-label="Skills">
        <h2>Project skills</h2>
        {catalog.project.length === 0 ? <p className="small muted">No project skills yet. Draft one; nothing runs until you publish it and add it to an agent.</p> : catalog.project.map(s => <button key={s.id} className={`skill-row${selected === s.id ? ' selected' : ''}`} aria-current={selected === s.id} onClick={() => void run(() => open(s.id))}>
          <b>{s.name}</b><span className="small muted">{s.description}</span>
          <span className="row small">{s.disabled ? <Badge tone="idle">disabled</Badge> : s.latest ? <Badge tone="ok">v{s.latest}</Badge> : <Badge tone="warn">draft only</Badge>}{s.draft && s.latest ? <Badge tone="warn">unpublished edits</Badge> : null}</span>
        </button>)}
        <h2>Pinned built-ins</h2>
        {catalog.builtin.map(s => <div key={s.id} className="skill-row static"><b>{s.name}</b><span className="small muted">{s.description}</span><span className="row small"><Badge>{s.license}</Badge><span className="faint">{s.version.slice(0, 12)}</span><button className="btn sm" onClick={() => void view(s.id, null)}>Read</button></span></div>)}
        <p className="small faint">Built-ins are pinned by hash with their license notices and cannot be edited.</p>
      </nav>
      <div className="col" style={{ gap: 18 }}>
        {viewing ? <section className="card card-b col" aria-label="Skill content">
          <div className="row"><h2>{viewing.id}{viewing.version ? ` · v${viewing.version}` : ''}</h2><span className="spacer" /><button className="btn sm" onClick={() => setViewing(null)}>Close</button></div>
          <div className="row wrap small">{viewing.content.files.map(f => <button key={f} className={`btn sm${f === viewing.content.file ? ' primary' : ''}`} onClick={() => void view(viewing.id, viewing.version, f)}>{f}</button>)}</div>
          <pre className="design-export">{viewing.content.content}</pre>
        </section> : null}
        <form className="card" onSubmit={e => { e.preventDefault(); void run(async () => {
          const r = await post<{ skill: ProjectSkill; advice: string[] }>(`/api/skills/${form.id}/draft`, { draft: form, expected });
          setExpected(r.skill.draft?.hash ?? null); setIsNew(false); setSelected(form.id); setNotice('Draft saved. Drafts never run, install or call anything.'); await reload(); await open(form.id);
        }); }}>
          <fieldset className="card-b col" disabled={busy} style={{ border: 0, gap: 14 }}>
            <h2>{isNew ? 'Draft a new skill' : `Edit ${form.name || form.id}`}</h2>
            <div className="builder-fields">
              <label>Skill ID<input required pattern="[a-z0-9][a-z0-9-]{1,63}" disabled={!isNew} value={form.id} onChange={e => patch({ id: e.target.value })} placeholder="review-checklist" /><span className="small faint">Folder name in exported worktrees. Permanent.</span></label>
              <label>Name<input required maxLength={100} value={form.name} onChange={e => patch({ name: e.target.value })} placeholder="Review checklist" /></label>
            </div>
            <label>Description<textarea rows={2} required minLength={10} maxLength={400} value={form.description} onChange={e => patch({ description: e.target.value })} placeholder="Use when reviewing UI changes for complete states and keyboard focus." /><span className="small faint">{form.description.length}/400 · the only text agents see before loading the skill.</span></label>
            <label>Instructions (SKILL.md body)<textarea rows={10} required maxLength={SKILL_LIMITS.instructions} value={form.instructions} onChange={e => patch({ instructions: e.target.value })} placeholder={'Steps the agent follows.\nLoad references/examples.md when you need a worked example.'} /><span className={`small ${form.instructions.length > 6000 ? 'text-warn' : 'faint'}`}>{form.instructions.length.toLocaleString()} characters · aim for under 6,000</span></label>
            <div className="col"><div className="row"><h3>References · loaded on demand</h3><span className="spacer" /><button type="button" className="btn sm" disabled={form.references.length >= SKILL_LIMITS.references} onClick={() => patch({ references: [...form.references, { path: `references/notes-${form.references.length + 1}.md`, content: '' }] })}>Add reference</button></div>
              {form.references.length === 0 && <p className="small muted">Optional. Use references for long examples, tables or checklists.</p>}
              {form.references.map((r, i) => <div key={i} className="col skill-ref"><div className="row"><input aria-label={`Reference ${i + 1} path`} pattern="references/[a-z0-9][a-z0-9_\-]{0,62}\.(md|txt)" value={r.path} onChange={e => patch({ references: form.references.map((x, j) => j === i ? { ...x, path: e.target.value } : x) })} /><button type="button" className="btn sm danger" onClick={() => patch({ references: form.references.filter((_, j) => j !== i) })}>Remove</button></div><textarea aria-label={`Reference ${i + 1} content`} rows={4} required value={r.content} onChange={e => patch({ references: form.references.map((x, j) => j === i ? { ...x, content: e.target.value } : x) })} /></div>)}
            </div>
            {!parsed.success && form.id && <p className="small text-warn">{parsed.error.issues[0]?.message}</p>}
            {advice.length > 0 && <ul className="small skill-advice" aria-label="Writing advice">{advice.map(a => <li key={a}>{a}</li>)}</ul>}
            <div className="row wrap"><button className="btn primary" disabled={busy || !parsed.success}>Save draft</button>
              {detail && <button type="button" className="btn" disabled={busy || !detail.draft} onClick={() => void run(async () => { const r = await post<{ version: { version: number } }>(`/api/skills/${detail.skill.id}/publish`, { expectedVersion: detail.skill.latest }); setNotice(`Published v${r.version.version}. Existing assignments keep the version they were given.`); await reload(); await open(detail.skill.id); })}>Publish {detail.skill.latest ? `v${detail.skill.latest + 1}` : 'v1'}</button>}
              {detail && <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => { await post(`/api/skills/${detail.skill.id}/disable`, { disabled: !detail.skill.disabled }); await reload(); await open(detail.skill.id); })}>{detail.skill.disabled ? 'Enable' : 'Disable'}</button>}
              <span className="small faint">Publishing freezes an immutable version. Agents get it only through <Link to="/setup">agent settings</Link>.</span></div>
          </fieldset>
        </form>
        {detail && <section className="card card-b col" aria-label="Versions">
          <div className="row"><h2>Versions</h2><span className="spacer" /><span className="small muted">{detail.usedBy.length ? `Used by ${userNames(detail.usedBy)}` : 'Not assigned to any agent'}</span></div>
          {detail.skill.versions.length === 0 ? <p className="small muted">Not published yet.</p> : <table className="small"><thead><tr><th>Version</th><th>Published</th><th>Files</th><th>SHA-256</th><th /></tr></thead><tbody>{[...detail.skill.versions].reverse().map(v => <tr key={v.version}><td>v{v.version}</td><td>{new Date(v.createdAt).toLocaleString()}</td><td>{v.files.length}</td><td className="mono">{v.hash.slice(0, 16)}</td><td><button className="btn sm" onClick={() => void view(v.id, String(v.version))}>Read</button></td></tr>)}</tbody></table>}
          <p className="small faint">Exported per harness into the assignment worktree: {Object.entries(catalog.exportDirs).filter(([, d]) => d).map(([a, d]) => `${a} → ${d}`).join(' · ')}. Paths the repository tracks or that One Connect did not write are left alone.</p>
        </section>}
      </div>
    </div>}
  </div>;
}
