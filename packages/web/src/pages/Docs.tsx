// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { ControlState, DocAnswer, DocsStatus, KnowledgeConfig,OneAnswerStatus } from '@acc/core';
import { Badge, ErrorLine, useAction } from '../components/common';
import { api, post } from '../lib/api';
import { chooseVault, isDesktop } from '../lib/desktop';
interface Context { config: KnowledgeConfig | null; docs: DocsStatus | null;privateVault:boolean;answer:OneAnswerStatus|null; }
export function Docs({state}:{state:ControlState}) {
  const [context,setContext]=useState<Context|null>(null),[settings,setSettings]=useState(false);
  const [root,setRoot]=useState(''),[folders,setFolders]=useState(''),[ownFolder,setOwnFolder]=useState('One Connect');
  const [semantic,setSemantic]=useState(false),[embedding,setEmbedding]=useState('embeddinggemma'),[answerModel,setAnswerModel]=useState('');
  const [query,setQuery]=useState(''),[result,setResult]=useState<DocAnswer|null>(null),[notice,setNotice]=useState('');
  const {busy,error,run}=useAction();
  const refresh=async()=>{const c=await api<Context>('/api/context');setContext(c);return c;};
  useEffect(()=>{
    let alive=true;
    void api<Context>('/api/context').then(c=>{
      if(!alive)return;setContext(c);
      if(c.config){setRoot(c.config.vault);setFolders(c.config.context_folders.join('\n'));setOwnFolder(c.config.folder);setSemantic(c.config.search.semantic);setEmbedding(c.config.search.embedding_model);setAnswerModel(c.config.search.answer_model??'');}
      else setSettings(true);
    }).catch(()=>{});return()=>{alive=false;};
  },[]);
  const docs=state.context.docs??context?.docs,connected=Boolean(context?.config),intake=state.context.answer??context?.answer,indexing=['extracting','indexing'].includes(intake?.state??'');
  return <div className="page connected-page docs-page">
    <div className="page-heading"><div><h1>One Answer</h1><p>Your project code, docs and shared decisions. One revision, traceable sources.</p></div><button className="btn" onClick={()=>setSettings(!settings)}>{context?.privateVault?'Connect Obsidian':'Connection settings'}</button></div>
    {settings&&<form className="docs-settings col" onSubmit={e=>{e.preventDefault();void run(async()=>{
      await post('/api/context/connect',{...(context?.config??{}),vault:root.trim(),folder:ownFolder.trim(),context_folders:folders.split('\n').map(f=>f.trim()).filter(Boolean),obsidian_cli:'off',search:{semantic,embedding_model:embedding.trim(),answer_model:answerModel.trim()||undefined,endpoint:context?.config?.search.endpoint??'http://127.0.0.1:11434',budget_chars:6000}});
      setResult(null);await refresh();setSettings(false);setNotice('Vault connected. Build its index or ask a question.');
    });}}>
      <h2>Choose your project knowledge</h2><p className="small muted">Only the listed folders are readable. Shared team notes go in their own project folder. Notes stay on this machine.</p>
      <label>Markdown or Obsidian vault<div className="row"><input required disabled={busy} value={root} onChange={e=>setRoot(e.target.value)} placeholder="/Users/you/Notes"/>{isDesktop&&<button aria-label="Choose Obsidian vault folder" type="button" className="btn" disabled={busy} onClick={()=>void run(async()=>setRoot(await chooseVault()))}>Choose folder…</button>}</div></label>
      <div className="docs-setting-columns"><label>Readable folders, one per line<textarea disabled={busy} rows={3} value={folders} onChange={e=>setFolders(e.target.value)} placeholder={'Projects/my-app\nDesign systems'}/></label><label>Folder for shared team notes<input required disabled={busy} value={ownFolder} onChange={e=>setOwnFolder(e.target.value)}/><span className="small faint">Each project gets its own subfolder.</span></label></div>
      <label className="row"><input type="checkbox" disabled={busy} checked={semantic} onChange={e=>setSemantic(e.target.checked)}/>Enable semantic search using local Ollama embeddings</label>
      <div className="docs-setting-columns"><label>Embedding model<input disabled={busy||!semantic} value={embedding} onChange={e=>setEmbedding(e.target.value)}/></label><label>Optional local answer model<input disabled={busy} value={answerModel} onChange={e=>setAnswerModel(e.target.value)} placeholder="Leave empty for source excerpts"/></label></div>
      <p className="small muted">Models must already be installed. Install one in the <Link to="/workspace">in-app terminal</Link>. Remote embedding services, paid fallbacks and automatic downloads stay off.</p>
      <div className="row"><button className="btn primary" disabled={busy}>Connect selected folders</button>{connected&&<button type="button" className="btn" disabled={busy} onClick={()=>setSettings(false)}>Cancel</button>}</div>
    </form>}
    <div className="docs-layout"><div>
      <form className="docs-question" onSubmit={e=>{e.preventDefault();void run(async()=>{setNotice('');setResult(await post<DocAnswer>('/api/context/docs/ask',{query}));await refresh();});}}>
        <label htmlFor="docs-question">What would you like to find?</label><textarea id="docs-question" value={query} maxLength={1200} rows={2} disabled={busy||!connected} onChange={e=>setQuery(e.target.value)} placeholder="How does login work, and where are our design decisions?"/>
        <div className="row"><span className="small faint">Ask your docs · citations · compact context</span><span className="spacer"/><button className="btn primary" disabled={busy||indexing||!connected||!query.trim()}>{busy?'Working…':indexing?'Indexing project…':'Ask One Answer'}</button></div>
      </form><ErrorLine error={error}/>{notice&&<p role="status" className="small text-ok">{notice}</p>}
      {result?<section className="docs-results" aria-live="polite"><div className="row"><h2>{result.mode==='answer'?'Answer from your notes':'Source excerpts'}</h2><span className="spacer"/><Badge>{result.backend==='hybrid'?'Semantic + keywords':'Keyword search'}</Badge></div>
        {result.warning&&<p className="banner tone-warn small">{result.warning}</p>}{result.answerError&&<p className="small muted">Local answer unavailable: {result.answerError}. Source excerpts remain available.</p>}
        {result.mode==='answer'&&<><p className="small muted">AI interpretation. Open the citations to check the original evidence.</p>{result.claims.length?result.claims.map((c,i)=><p className="doc-claim" key={i}>{c.text} {c.sources.map(id=><a key={id} href={`#doc-source-${id}`} aria-label={`Read source ${id}`}>[{id}]</a>)}</p>):<p className="muted">The sources do not support an answer.</p>}</>}
        {!result.citations.length&&<div className="empty">No matching project notes. Try different words or add a relevant folder.</div>}
        <div className="doc-citations">{result.citations.map(c=><details id={`doc-source-${c.id}`} className="doc-citation" key={c.id} open={result.mode==='excerpts'}><summary><span className="doc-source-id">{c.id}</span><b>{c.projectSource?.path??c.title}</b><span className="small muted">Lines {c.projectSource?.line??c.line}–{c.projectSource?.endLine??c.endLine}</span></summary><p className="small faint">{c.projectSource?`${c.projectSource.path} · committed revision ${c.projectSource.revision}`:c.path}</p><pre>{c.excerpt}</pre></details>)}</div>
        <p className="small muted">{result.contextChars.toLocaleString()} source characters supplied, within a {result.budgetChars.toLocaleString()} character budget. Context size is measured; token savings are not estimated.</p>
      </section>:<div className="docs-welcome"><div className="docs-glyph" aria-hidden="true">↗</div><h2>Your knowledge, connected</h2><p>Search product briefs, architectural decisions and design rules together. Agents use the same scoped index and the same sources.</p></div>}
    </div><aside className="docs-insights col">
      <section className="card card-b col"><div className="row"><h2>Project intake</h2><Badge tone={intake?.state==='ready'?'ok':intake?.state==='error'?'crit':'warn'}>{intake?.state??'Not indexed'}</Badge></div><p className="small muted">{context?.privateVault?'Notes are in a private local Markdown vault. Connect Obsidian to sync them into your selected project folder.':'Project notes are synced to the selected Obsidian / Markdown vault.'}</p><span className="small mono">{intake?.ref} · {intake?.revision?.slice(0,12)??'No committed revision'}</span><span className="small">{intake?.files??0} included / {intake?.totalFiles??0} tracked files</span><span className="small faint">{intake?.excludedFiles??0} excluded · uncommitted edits are not indexed</span><div className="small col"><span>Notes: {intake?.notesRevision?.slice(0,12)??'pending'}</span><span>Embeddings: {intake?.embeddingsRevision?.slice(0,12)??'off or pending'}</span><span>Graphify: {intake?.graphRevision?.slice(0,12)??'unavailable or pending'}</span></div>{intake?.error&&<p className="small text-warn">{intake.error}</p>}<button className="btn" disabled={busy||indexing} onClick={()=>void run(async()=>{await post('/api/context/answer/refresh');await refresh();setNotice('Project intake started. Progress appears here.');})}>Re-index project</button>{intake?.packages.length? <details><summary>Packages and declared commands</summary>{intake.packages.map(p=><div key={p.path}><p className="small mono">{p.name??p.path} · {p.dependencies.length} dependencies</p><pre>{Object.entries(p.scripts).map(([k,v])=>`${k}: ${v}`).join('\n')}</pre></div>)}<p className="small faint">Source declarations. No commands were executed by indexing.</p></details>:null}</section>
      <section className="card card-b col"><div className="row"><h2>Local knowledge</h2><Badge tone={connected?'ok':'idle'}>{connected?'Connected':'Not connected'}</Badge></div><strong className="docs-count">{docs?.notes??0}<span>indexed notes</span></strong><div className="row small"><span className="muted">Chunks</span><span className="spacer"/>{docs?.chunks??0}</div><div className="row small"><span className="muted">Semantic vectors</span><span className="spacer"/>{docs?.vectors??0}</div><p className="small muted">{docs?.semantic?`Embedding model: ${docs.embeddingModel}`:'Keyword search works without an AI service.'}</p>{docs?.error&&<p className="small text-warn">{docs.error}</p>}<button className="btn" disabled={busy||!connected} onClick={()=>void run(async()=>{setNotice('');await post('/api/context/docs/index');await refresh();setNotice('Index refreshed from the selected folders.');})}>{busy?'Working…':'Refresh index'}</button>{docs?.indexedAt&&<span className="small faint">Indexed {new Date(docs.indexedAt).toLocaleString()}</span>}<div className="docs-scope">{docs?.scope.map(f=><span className="small mono" key={f}>{f}</span>)}</div></section>
      <section className="context-note"><h2>Code knowledge graph</h2><p>{state.context.graph?.state==='ready'?`${state.context.graph.nodes??0} nodes and ${state.context.graph.edges??0} edges indexed by Graphify.`:state.context.graph?`Graphify: ${state.context.graph.state}`:'Enable Graphify in project settings to connect code symbols and dependencies.'}</p>{state.context.graph?.sha&&<p className="small mono">Integration {state.context.graph.sha.slice(0,12)}</p>}<Link to="/analytics">View context analytics</Link></section>
      <p className="small faint">Retrieved notes provide context. Human decisions and safety policies govern actions.</p>
    </aside></div>
  </div>;
}
