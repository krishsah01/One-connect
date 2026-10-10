// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { skillAdvice, SkillDraftSchema, SKILL_IMPORT_MAX_BYTES, SKILL_LIMITS, type ControlState, type DesignSkill, type ProjectSkill, type SkillDraft, type SkillImportPreview, type SkillTemplate } from '@acc/core';
import { Badge, ErrorLine, useAction } from '../components/common';
import { api, post } from '../lib/api';

type Builtin = DesignSkill & { references: string[] };
type TemplateMeta = Pick<SkillTemplate, 'id' | 'title' | 'description' | 'license'>;
interface Catalog { builtin: Builtin[]; project: ProjectSkill[]; exportDirs: Record<string, string | null>; templates: TemplateMeta[] }
interface Detail { skill: ProjectSkill; draft: (SkillDraft & { hash: string }) | null; editable: SkillDraft | null; advice: string[]; usedBy: string[] }
interface Content { file: string; content: string; files: string[] }

const BLANK: SkillDraft = { id: '', name: '', description: '', instructions: '', references: [], source: null, license: null };
const sameDraft = (a: SkillDraft, b: SkillDraft) => JSON.stringify(a) === JSON.stringify(b);

export function Skills({ state }: { state: ControlState }) {
  const { busy, error, run, setError } = useAction();
  const gen = useRef(0);
  const catalogGen = useRef(0);
  const mounted = useRef(true);
  const [catalog, setCatalog] = useState<Catalog | null>(null), [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<Detail | null>(null);
  const [form, setForm] = useState<SkillDraft>(BLANK), [saved, setSaved] = useState<SkillDraft | null>(null), [expected, setExpected] = useState<string | null>(null), [isNew, setIsNew] = useState(true);
  const [viewing, setViewing] = useState<{ id: string; version: string | null; content: Content } | null>(null), [notice, setNotice] = useState('');
  const [importOpen, setImportOpen] = useState(false), [importPreview, setImportPreview] = useState<SkillImportPreview | null>(null);
  const [importSkillMd, setImportSkillMd] = useState(''), [importRefs, setImportRefs] = useState<{ path: string; content: string }[]>([]);
  const [importBundleJson, setImportBundleJson] = useState('');
  const [importId, setImportId] = useState('');
  const [importSource, setImportSource] = useState(''), [importLicense, setImportLicense] = useState('');
  const [importFileError, setImportFileError] = useState('');
  const [conflict, setConflict] = useState('');

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; gen.current += 1; catalogGen.current += 1; };
  }, []);

  const reload = useCallback(async () => {
    const g = ++catalogGen.current;
    try {
      const c = await api<Catalog>('/api/skills');
      if (!mounted.current || catalogGen.current !== g) return;
      setCatalog(c);
      setLoadError('');
    } catch (e) {
      if (!mounted.current || catalogGen.current !== g) return;
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const invalidateImportPreview = () => { gen.current += 1; setImportPreview(null); };

  const applyDetail = (d: Detail, noticeMsg?: string) => {
    const editable = d.editable ?? BLANK;
    setSelected(d.skill.id);
    setDetail(d);
    setForm(editable);
    setSaved(d.editable ? editable : null);
    setExpected(d.draft?.hash ?? null);
    setIsNew(false);
    setViewing(null);
    setConflict('');
    if (noticeMsg) setNotice(noticeMsg);
  };

  const open = async (id: string, noticeMsg?: string, opts?: { preserveForm?: boolean }) => {
    const g = ++gen.current;
    const d = await api<Detail>(`/api/skills/${id}`);
    if (!mounted.current || gen.current !== g) return;
    if (opts?.preserveForm) {
      setDetail(d);
      setExpected(d.draft?.hash ?? null);
      // Preserve local edits, but compare against the refreshed server draft. They cannot
      // approve an unseen remote draft simply because the previous local draft was saved.
      setSaved(d.draft ? d.editable ?? BLANK : null);
      setConflict('');
      if (noticeMsg) setNotice(noticeMsg);
      return;
    }
    applyDetail(d, noticeMsg);
  };

  const startNew = () => {
    gen.current += 1;
    setSelected(null);
    setDetail(null);
    setForm(BLANK);
    setSaved(null);
    setExpected(null);
    setIsNew(true);
    setViewing(null);
    setConflict('');
    setImportPreview(null);
    setImportOpen(false);
    setImportId('');
    setNotice('');
    setError(null);
  };

  const loadTemplate = (id: string) => run(async () => {
    const g = ++gen.current;
    const r = await api<{ template: SkillTemplate; advice: string[]; note: string }>(`/api/skills/templates/${id}`);
    if (!mounted.current || gen.current !== g) return;
    startNew();
    setForm(r.template.draft);
    setSaved(null);
    setExpected(null);
    setIsNew(true);
    setNotice(`Loaded template “${r.template.title}”. Save a draft before publishing.`);
  });

  const parsed = SkillDraftSchema.safeParse(form);
  const advice = parsed.success ? skillAdvice(parsed.data) : [];
  const dirty = saved ? !sameDraft(form, saved) : Boolean(form.id || form.name || form.description || form.instructions || form.references.length);
  const canPublish = Boolean(detail?.draft && expected && saved && !dirty && parsed.success);

  const patch = (p: Partial<SkillDraft>) => { setConflict(''); setForm(f => ({ ...f, ...p })); };

  const view = (id: string, version: string | null, file = 'SKILL.md') => run(async () => {
    const g = ++gen.current;
    const content = await api<Content>(`/api/skills/${id}/content?file=${encodeURIComponent(file)}${version ? `&version=${version}` : ''}`);
    if (!mounted.current || gen.current !== g) return;
    setViewing({ id, version, content });
  });

  const userNames = (ids: string[]) => ids.map(id => state.agents[id]?.config.name ?? id).join(', ');

  const previewImport = () => run(async () => {
    invalidateImportPreview();
    const g = gen.current;
    const p = await post<SkillImportPreview>('/api/skills/import/preview', {
      files: { skillMd: importSkillMd, references: importRefs, id: importId.trim() || undefined, source: importSource || null, license: importLicense || null },
    });
    if (!mounted.current || gen.current !== g) return;
    setImportPreview(p);
    setImportId(p.draft.id);
    setConflict('');
  });

  const previewBundle = () => run(async () => {
    invalidateImportPreview();
    const g = gen.current;
    let bundle: unknown;
    try { bundle = JSON.parse(importBundleJson); } catch { throw new Error('Bundle must be valid JSON'); }
    const p = await post<SkillImportPreview>('/api/skills/import/preview', { bundle });
    if (!mounted.current || gen.current !== g) return;
    setImportPreview(p);
    setImportId(p.draft.id);
    setConflict('');
  });

  const saveImport = () => {
    if (!importPreview) return;
    const draft = { ...importPreview.draft, id: importId.trim() || importPreview.draft.id };
    if (!SkillDraftSchema.safeParse(draft).success) {
      setConflict('Choose a valid skill id (2–64 lowercase letters, digits and dashes).');
      return;
    }
    if (catalog?.project.some(s => s.id === draft.id)) {
      setConflict(`A project skill named “${draft.id}” already exists. Choose a new id before saving.`);
      return;
    }
    gen.current += 1;
    setForm(draft);
    setSaved(null);
    setExpected(null);
    setIsNew(true);
    setSelected(null);
    setDetail(null);
    setImportOpen(false);
    setImportPreview(null);
    setNotice('Import loaded into the editor. Review, then save draft.');
  };

  const onRefFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setImportFileError('');
    invalidateImportPreview();
    const g = gen.current;
    const list = Array.from(files);
    const jsonFiles = list.filter(f => f.name.toLowerCase().endsWith('.json') || f.type === 'application/json');
    const otherFiles = list.filter(f => !jsonFiles.includes(f));
    if (jsonFiles.length > 1) { setImportFileError('Choose only one bundle JSON file.'); return; }
    if (jsonFiles.length && otherFiles.length) { setImportFileError('Bundle JSON cannot be mixed with SKILL.md or reference files.'); return; }
    if (jsonFiles.length === 1) {
      const f = jsonFiles[0];
      if (f.size > SKILL_IMPORT_MAX_BYTES) { setImportFileError(`Bundle file exceeds the ${SKILL_IMPORT_MAX_BYTES} byte limit.`); return; }
      try {
        const text = await f.text();
        if (!mounted.current || gen.current !== g) return;
        setImportBundleJson(text);
        setImportSkillMd('');
        setImportRefs([]);
      } catch {
        if (!mounted.current || gen.current !== g) return;
        setImportFileError('Could not read the bundle file.');
      }
      return;
    }
    const next: { path: string; content: string }[] = [];
    for (const f of otherFiles) {
      if (f.size > SKILL_IMPORT_MAX_BYTES) { setImportFileError(`${f.name} exceeds the import size limit.`); return; }
      const norm = f.name.replace(/\\/g, '/');
      try {
        const content = await f.text();
        if (!mounted.current || gen.current !== g) return;
        if (norm.toLowerCase() === 'skill.md') {
          setImportSkillMd(content);
          setImportBundleJson('');
          continue;
        }
        const path = norm.startsWith('references/') ? norm : `references/${norm}`;
        next.push({ path, content });
      } catch {
        if (!mounted.current || gen.current !== g) return;
        setImportFileError(`Could not read ${f.name}.`);
        return;
      }
    }
    if (next.length) { setImportRefs(r => [...r, ...next]); setImportBundleJson(''); }
  };

  const exportVersion = (id: string, version: number) => run(async () => {
    const g = ++gen.current;
    const bundle = await api<Record<string, unknown>>(`/api/skills/${id}/versions/${version}/export`);
    if (!mounted.current || gen.current !== g) return;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${id}-v${version}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setNotice(`Downloaded ${id} v${version} bundle.`);
  });

  const reloadConflict = () => {
    if (!selected) return;
    void run(() => open(selected, undefined, { preserveForm: dirty }));
  };

  return <div className="page connected-page skills-page">
    <div className="page-heading">
      <div><div className="eyebrow">Project library</div><h1>Skills</h1><p>Reusable, versioned instructions your agents load only when a task needs them.</p></div>
      <div className="row wrap">
        <button type="button" className="btn" onClick={() => { setImportOpen(v => !v); invalidateImportPreview(); setConflict(''); setImportFileError(''); }}>Import</button>
        <button type="button" className="btn" onClick={startNew}>New skill</button>
      </div>
    </div>
    <div className="banner tone-info small skills-teach" role="note"><b>Keep skills small.</b> Assignments carry only each skill’s one-line description. An agent calls <code>get_skill</code> when the description matches its task, and opens a reference only when SKILL.md points to it. Put the trigger in the description (“Use when…”), the steps in the instructions, and long examples in references.</div>
    {loadError && <ErrorLine error={`Could not load skills: ${loadError}`} />}
    <ErrorLine error={error} />
    {notice && <p role="status" className="small text-ok">{notice}</p>}
    {conflict && <div className="banner tone-warn small" role="alert">{conflict} <button type="button" className="btn sm" onClick={reloadConflict}>Reload server copy</button></div>}
    {importOpen && <section className="card card-b col skill-import" aria-label="Import skill">
      <div className="row"><h2>Import skill</h2><span className="spacer" /><button type="button" className="btn sm" onClick={() => { setImportOpen(false); invalidateImportPreview(); }}>Close</button></div>
      <p className="small muted">Select SKILL.md and optional <code>references/*.md</code> files, or one JSON bundle. Preview validates everything; nothing is saved until you click Load into editor and then Save draft.</p>
      <div className="row wrap">
        <label className="btn sm">Choose files<input type="file" accept=".md,.txt,.json" multiple hidden onChange={e => { void onRefFiles(e.target.files); e.target.value = ''; }} /></label>
        <button type="button" className="btn sm" disabled={busy || (!importSkillMd && !importBundleJson)} onClick={() => importBundleJson ? void previewBundle() : void previewImport()}>{importBundleJson ? 'Preview bundle' : 'Preview files'}</button>
      </div>
      {importFileError && <p className="small text-warn" role="alert">{importFileError}</p>}
      {!importBundleJson && <label>SKILL.md<textarea rows={6} value={importSkillMd} onChange={e => { setImportSkillMd(e.target.value); invalidateImportPreview(); setImportFileError(''); }} placeholder="Paste SKILL.md content or choose a file above" /></label>}
      {!importBundleJson && importRefs.length > 0 && <p className="small muted">{importRefs.length} reference file{importRefs.length === 1 ? '' : 's'} selected.</p>}
      {!importBundleJson && <div className="builder-fields">
        <label>Source (optional)<input value={importSource} onChange={e => { setImportSource(e.target.value); invalidateImportPreview(); }} placeholder="https://… or unknown" /></label>
        <label>License (optional)<input value={importLicense} onChange={e => { setImportLicense(e.target.value); invalidateImportPreview(); }} placeholder="Apache-2.0 or unknown" /></label>
      </div>}
      <label>Or paste bundle JSON<textarea rows={4} value={importBundleJson} onChange={e => { setImportBundleJson(e.target.value); invalidateImportPreview(); setImportSkillMd(''); setImportRefs([]); setImportFileError(''); }} placeholder='{"format":"one-connect-skill-bundle",…}' /></label>
      {importPreview && <div className="col skill-import-preview">
        <p className="small"><Badge tone="warn">untrusted</Badge> {importPreview.note}</p>
        <label>Import skill id<input value={importId} onChange={e => setImportId(e.target.value)} pattern="[a-z0-9][a-z0-9-]{1,63}" placeholder="new-skill-id" /><span className="small faint">Change if this id collides with an existing skill.</span></label>
        <p className="small muted">Display name <b>{importPreview.draft.name}</b> · {importPreview.files.length} file(s) · source: {importPreview.attribution.source ?? 'unknown'} · license: {importPreview.attribution.license ?? 'unknown'}</p>
        {importPreview.advice.length > 0 && <ul className="small skill-advice">{importPreview.advice.map(a => <li key={a}>{a}</li>)}</ul>}
        <h3>Instructions</h3>
        <pre className="design-export">{importPreview.draft.instructions}</pre>
        {importPreview.draft.references.map(r => <div key={r.path} className="col"><h4>{r.path}</h4><pre className="design-export">{r.content}</pre></div>)}
        <div className="row wrap"><button type="button" className="btn primary" onClick={saveImport}>Load into editor</button></div>
      </div>}
    </section>}
    {!catalog && !loadError ? <div className="empty" role="status">Loading skills…</div> : catalog && <div className="skills-layout">
      <nav className="card card-b col skills-list" aria-label="Skills">
        <h2>Project skills</h2>
        {catalog.project.length === 0 ? <p className="small muted">No project skills yet. Draft one; nothing runs until you publish it and add it to an agent.</p> : catalog.project.map(s => <button key={s.id} type="button" className={`skill-row${selected === s.id ? ' selected' : ''}`} aria-current={selected === s.id} onClick={() => void run(() => open(s.id))}>
          <b>{s.name}</b><span className="small muted">{s.description}</span>
          <span className="row small">{s.disabled ? <Badge tone="idle">disabled</Badge> : s.latest ? <Badge tone="ok">v{s.latest}</Badge> : <Badge tone="warn">draft only</Badge>}{s.draft && s.latest ? <Badge tone="warn">unpublished edits</Badge> : null}</span>
        </button>)}
        <h2>Templates</h2>
        {catalog.templates.map(t => <button key={t.id} type="button" className="skill-row" onClick={() => void loadTemplate(t.id)}>
          <b>{t.title}</b><span className="small muted">{t.description}</span><span className="row small"><Badge>{t.license}</Badge></span>
        </button>)}
        <h2>Pinned built-ins</h2>
        {catalog.builtin.map(s => <div key={s.id} className="skill-row static"><b>{s.name}</b><span className="small muted">{s.description}</span><span className="row small"><Badge>{s.license}</Badge><span className="faint">{s.version.slice(0, 12)}</span><button type="button" className="btn sm" onClick={() => void view(s.id, null)}>Read</button></span></div>)}
        <p className="small faint">Built-ins are pinned by hash with their license notices and cannot be edited or exported.</p>
      </nav>
      <div className="col" style={{ gap: 18 }}>
        {viewing ? <section className="card card-b col" aria-label="Skill content">
          <div className="row"><h2>{viewing.id}{viewing.version ? ` · v${viewing.version}` : ''}</h2><span className="spacer" /><button type="button" className="btn sm" onClick={() => setViewing(null)}>Close</button></div>
          <div className="row wrap small">{viewing.content.files.map(f => <button key={f} type="button" className={`btn sm${f === viewing.content.file ? ' primary' : ''}`} onClick={() => void view(viewing.id, viewing.version, f)}>{f}</button>)}</div>
          <pre className="design-export">{viewing.content.content}</pre>
        </section> : null}
        <form className="card" onSubmit={e => { e.preventDefault(); void run(async () => {
          const g = ++gen.current;
          try {
            const r = await post<{ skill: ProjectSkill; advice: string[] }>(`/api/skills/${form.id}/draft`, { draft: form, expected });
            if (!mounted.current || gen.current !== g) return;
            setExpected(r.skill.draft?.hash ?? null);
            setSaved(form);
            setIsNew(false);
            setSelected(form.id);
            setConflict('');
            setNotice('Draft saved. Drafts never run, install or call anything.');
            await reload();
            if (!mounted.current || gen.current !== g) return;
            await open(form.id);
          } catch (e) {
            if (!mounted.current || gen.current !== g) return;
            const msg = (e as Error).message;
            if (/changed/i.test(msg)) setConflict(msg);
            throw e;
          }
        }); }}>
          <fieldset className="card-b col" disabled={busy} style={{ border: 0, gap: 14 }}>
            <div className="row wrap"><h2>{isNew ? 'Draft a new skill' : `Edit ${form.name || form.id}`}</h2>{dirty ? <Badge tone="warn">unsaved edits</Badge> : saved ? <Badge tone="ok">{detail?.skill.latest && !detail.draft ? `published v${detail.skill.latest}` : 'saved'}</Badge> : null}</div>
            <div className="builder-fields">
              <label>Skill ID<input required pattern="[a-z0-9][a-z0-9-]{1,63}" disabled={!isNew} value={form.id} onChange={e => patch({ id: e.target.value })} placeholder="review-checklist" /><span className="small faint">Folder name in exported worktrees. Permanent.</span></label>
              <label>Name<input required maxLength={100} value={form.name} onChange={e => patch({ name: e.target.value })} placeholder="Review checklist" /></label>
            </div>
            <label>Description<textarea rows={2} required minLength={10} maxLength={400} value={form.description} onChange={e => patch({ description: e.target.value })} placeholder="Use when reviewing UI changes for complete states and keyboard focus." /><span className="small faint">{form.description.length}/400 · the only text agents see before loading the skill.</span></label>
            <label>Instructions (SKILL.md body)<textarea rows={10} required maxLength={SKILL_LIMITS.instructions} value={form.instructions} onChange={e => patch({ instructions: e.target.value })} placeholder={'Steps the agent follows.\nLoad references/examples.md when you need a worked example.'} /><span className={`small ${form.instructions.length > 6000 ? 'text-warn' : 'faint'}`}>{form.instructions.length.toLocaleString()} characters · aim for under 6,000</span></label>
            <div className="builder-fields">
              <label>Source (optional)<input value={form.source ?? ''} onChange={e => patch({ source: e.target.value || null })} placeholder="Attribution URL or unknown" /></label>
              <label>License (optional)<input value={form.license ?? ''} onChange={e => patch({ license: e.target.value || null })} placeholder="Apache-2.0 or unknown" /></label>
            </div>
            <div className="col"><div className="row"><h3>References · loaded on demand</h3><span className="spacer" /><button type="button" className="btn sm" disabled={form.references.length >= SKILL_LIMITS.references} onClick={() => patch({ references: [...form.references, { path: `references/notes-${form.references.length + 1}.md`, content: '' }] })}>Add reference</button></div>
              {form.references.length === 0 && <p className="small muted">Optional. Use references for long examples, tables or checklists.</p>}
              {form.references.map((r, i) => <div key={i} className="col skill-ref"><div className="row"><input aria-label={`Reference ${i + 1} path`} pattern="references/[a-z0-9][a-z0-9_\-]{0,62}\.(md|txt)" value={r.path} onChange={e => patch({ references: form.references.map((x, j) => j === i ? { ...x, path: e.target.value } : x) })} /><button type="button" className="btn sm danger" onClick={() => patch({ references: form.references.filter((_, j) => j !== i) })}>Remove</button></div><textarea aria-label={`Reference ${i + 1} content`} rows={4} required value={r.content} onChange={e => patch({ references: form.references.map((x, j) => j === i ? { ...x, content: e.target.value } : x) })} /></div>)}
            </div>
            {!parsed.success && form.id && <p className="small text-warn">{parsed.error.issues[0]?.message}</p>}
            {advice.length > 0 && <ul className="small skill-advice" aria-label="Writing advice">{advice.map(a => <li key={a}>{a}</li>)}</ul>}
            <div className="row wrap">
              <button type="submit" className="btn primary" disabled={busy || !parsed.success}>Save draft</button>
              {detail && <button type="button" className="btn" disabled={busy || !canPublish} title={dirty ? 'Save your edits before publishing' : !detail.draft ? 'Save a draft first' : undefined} onClick={() => void run(async () => {
                const g = ++gen.current;
                try {
                  const r = await post<{ version: { version: number } }>(`/api/skills/${detail.skill.id}/publish`, { expectedVersion: detail.skill.latest, expectedDraftHash: expected });
                  if (!mounted.current || gen.current !== g) return;
                  setNotice(`Published v${r.version.version}. Existing assignments keep the version they were given.`);
                  setSaved(null);
                  await reload();
                  if (!mounted.current || gen.current !== g) return;
                  await open(detail.skill.id, `Published v${r.version.version}. Existing assignments keep the version they were given.`);
                } catch (e) {
                  if (!mounted.current || gen.current !== g) return;
                  const msg = (e as Error).message;
                  if (/draft/i.test(msg) || /changed/i.test(msg) || /hash/i.test(msg)) setConflict(msg);
                  throw e;
                }
              })}>Publish {detail.skill.latest ? `v${detail.skill.latest + 1}` : 'v1'}</button>}
              {detail && <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => {
                const g = ++gen.current;
                const id = detail.skill.id;
                await post(`/api/skills/${id}/disable`, { disabled: !detail.skill.disabled });
                if (!mounted.current || gen.current !== g) return;
                await reload();
                if (!mounted.current || gen.current !== g) return;
                await open(id);
              })}>{detail.skill.disabled ? 'Enable' : 'Disable'}</button>}
              <span className="small faint">Publishing freezes an immutable version. Agents get it only through <Link to="/setup">agent settings</Link>.</span>
            </div>
          </fieldset>
        </form>
        {detail && <section className="card card-b col" aria-label="Versions">
          <div className="row"><h2>Versions</h2><span className="spacer" /><span className="small muted">{detail.usedBy.length ? `Used by ${userNames(detail.usedBy)}` : 'Not assigned to any agent'}</span></div>
          {detail.skill.versions.length === 0 ? <p className="small muted">Not published yet.</p> : <table className="small"><thead><tr><th>Version</th><th>Published</th><th>Files</th><th>SHA-256</th><th /></tr></thead><tbody>{[...detail.skill.versions].reverse().map(v => <tr key={v.version}><td>v{v.version}</td><td>{new Date(v.createdAt).toLocaleString()}</td><td>{v.files.length}</td><td className="mono">{v.hash.slice(0, 16)}</td><td className="row wrap"><button type="button" className="btn sm" onClick={() => void view(v.id, String(v.version))}>Read</button><button type="button" className="btn sm" onClick={() => void exportVersion(v.id, v.version)}>Export</button></td></tr>)}</tbody></table>}
          <p className="small faint">Exported per harness into the assignment worktree: {Object.entries(catalog.exportDirs).filter(([, d]) => d).map(([a, d]) => `${a} → ${d}`).join(' · ')}. Paths the repository tracks or that One Connect did not write are left alone.</p>
        </section>}
      </div>
    </div>}
  </div>;
}
