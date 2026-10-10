// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { useEffect, useState } from 'react';
import { AgentPacketPreview, AskPanel, FileViewer, LocalModels, DictionaryStatusCard, StructureExplorer, Tabs } from '../components/Dictionary';
import { ContextBenchmarkPanel } from '../components/ContextBenchmarkPanel';
import { Link } from 'react-router';
import type { ControlState, DocsStatus, KnowledgeConfig,DictionaryStatus } from '@acc/core';
import { Badge, ErrorLine, useAction } from '../components/common';
import { api, post } from '../lib/api';
import { chooseVault, isDesktop } from '../lib/desktop';
interface Context { config: KnowledgeConfig | null; docs: DocsStatus | null;privateVault:boolean;answer:DictionaryStatus|null; }
export function Docs({state}:{state:ControlState}) {
  const [context,setContext]=useState<Context|null>(null),[settings,setSettings]=useState(false);
  const [root,setRoot]=useState(''),[folders,setFolders]=useState(''),[ownFolder,setOwnFolder]=useState('One Connect');
  const [semantic,setSemantic]=useState(false),[embedding,setEmbedding]=useState('embeddinggemma'),[answerModel,setAnswerModel]=useState('');
  const [notice,setNotice]=useState(''),[tab,setTab]=useState('ask'),[file,setFile]=useState<{path:string;line?:number;endLine?:number;revision?:string}|null>(null);
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
  const docs=state.context.docs??context?.docs,connected=Boolean(context?.config),intake=state.context.answer??context?.answer;
  return <div className="page connected-page docs-page">
    <div className="page-heading"><div><h1>One Ask</h1><p>Your project code, docs and shared decisions. One revision, traceable sources.</p></div><button className="btn" onClick={()=>setSettings(!settings)}>{context?.privateVault?'Connect Obsidian':'Connection settings'}</button></div>
    {settings&&<form className="docs-settings col" onSubmit={e=>{e.preventDefault();void run(async()=>{
      await post('/api/context/connect',{...(context?.config??{}),vault:root.trim(),folder:ownFolder.trim(),context_folders:folders.split('\n').map(f=>f.trim()).filter(Boolean),obsidian_cli:'off',search:{semantic,embedding_model:embedding.trim(),answer_model:answerModel.trim()||undefined,endpoint:context?.config?.search.endpoint??'http://127.0.0.1:11434',budget_chars:6000}});
      await refresh();setSettings(false);setNotice('Vault connected. Build its index or ask a question.');
    });}}>
      <h2>Choose your project knowledge</h2><p className="small muted">Only the listed folders are readable. Shared team notes go in their own project folder. Notes stay on this machine.</p>
      <label>Markdown or Obsidian vault<div className="row"><input required disabled={busy} value={root} onChange={e=>setRoot(e.target.value)} placeholder="/Users/you/Notes"/>{isDesktop&&<button aria-label="Choose Obsidian vault folder" type="button" className="btn" disabled={busy} onClick={()=>void run(async()=>setRoot(await chooseVault()))}>Choose folder…</button>}</div></label>
      <div className="docs-setting-columns"><label>Readable folders, one per line<textarea disabled={busy} rows={3} value={folders} onChange={e=>setFolders(e.target.value)} placeholder={'Projects/my-app\nDesign systems'}/></label><label>Folder for shared team notes<input required disabled={busy} value={ownFolder} onChange={e=>setOwnFolder(e.target.value)}/><span className="small faint">Each project gets its own subfolder.</span></label></div>
      <label className="row"><input type="checkbox" disabled={busy} checked={semantic} onChange={e=>setSemantic(e.target.checked)}/>Enable semantic search using local Ollama embeddings</label>
      <div className="docs-setting-columns"><label>Embedding model<input disabled={busy||!semantic} value={embedding} onChange={e=>setEmbedding(e.target.value)}/></label><label>Optional local answer model<input disabled={busy} value={answerModel} onChange={e=>setAnswerModel(e.target.value)} placeholder="Leave empty for source excerpts"/></label></div>
      <p className="small muted">Models must already be installed. Install one in the <Link to="/workspace">in-app terminal</Link>. Remote embedding services, paid fallbacks and automatic downloads stay off.</p>
      <div className="row"><button className="btn primary" disabled={busy}>Connect selected folders</button>{connected&&<button type="button" className="btn" disabled={busy} onClick={()=>setSettings(false)}>Cancel</button>}</div>
    </form>}
    {notice&&<p role="status" className="small text-ok">{notice}</p>}<ErrorLine error={error}/>
    <DictionaryStatusCard status={intake} onChanged={()=>void refresh()}/>
    <div className="docs-layout"><div>
      <Tabs active={tab} onChange={setTab} tabs={[{id:'ask',label:'Ask'},{id:'structure',label:'Explore structure'},{id:'agents',label:'Agent context'}]}/>
      <div role="tabpanel" id={`oa-panel-${tab}`} aria-labelledby={`oa-tab-${tab}`}>
        {tab==='ask'&&<AskPanel disabled={!connected} onOpenFile={(path,line,endLine,revision)=>setFile({path,line,endLine,revision})}/>}
        {tab==='structure'&&<StructureExplorer state={state} onOpenFile={(path,line,endLine,revision)=>setFile({path,line,endLine,revision})}/>}
        {tab==='agents'&&<AgentPacketPreview state={state}/>}
      </div>
      <FileViewer target={file} onClose={()=>setFile(null)}/>
    </div><aside className="docs-insights col">
      <section className="card card-b col"><div className="row"><h2>Local knowledge</h2><Badge tone={connected?'ok':'idle'}>{connected?'Connected':'Not connected'}</Badge></div><p className="small muted">{context?.privateVault?'Notes are in a private local Markdown vault. Connect Obsidian to sync them into your selected project folder.':'Project notes are synced to the selected Obsidian / Markdown vault.'}</p><strong className="docs-count">{docs?.notes??0}<span>indexed notes</span></strong><div className="row small"><span className="muted">Passages</span><span className="spacer"/>{docs?.chunks??0}</div><div className="row small"><span className="muted">Semantic vectors</span><span className="spacer"/>{docs?.vectors??0}</div><p className="small muted">{docs?.semantic?`Embedding model: ${docs.embeddingModel}`:'Keyword search works without an AI service.'}</p>{docs?.error&&<p className="small text-warn">{docs.error}</p>}<button className="btn" disabled={busy||!connected} onClick={()=>void run(async()=>{setNotice('');await post('/api/context/docs/index');await refresh();setNotice('Index refreshed from the selected folders.');})}>{busy?'Working…':'Refresh notes index'}</button>{docs?.indexedAt&&<span className="small faint">Indexed {new Date(docs.indexedAt).toLocaleString()}</span>}<details><summary className="small">Readable folders ({docs?.scope.length??0})</summary><div className="docs-scope">{docs?.scope.map(f=><span className="small mono" key={f}>{f}</span>)}</div></details></section>
      <LocalModels semantic={Boolean(docs?.semantic)}/>
      {intake?.packages.length?<section className="card card-b col"><h2>Packages</h2>{intake.packages.slice(0,12).map(p=><details key={p.path}><summary className="small mono">{p.name??p.path} · {p.dependencies.length} dependencies</summary>{Object.keys(p.scripts).length?<pre>{Object.entries(p.scripts).map(([k,v])=>`${k}: ${v}`).join('\n')}</pre>:<p className="small faint">No declared scripts.</p>}</details>)}<p className="small faint">Source declarations. Indexing never runs them.</p></section>:null}
      <section className="context-note"><h2>Analytics</h2><p className="small">Queries and supplied source characters are measured locally.</p><Link to="/analytics">View context analytics</Link></section>
      <p className="small faint">Retrieved notes provide context. Human decisions and safety policies govern actions.</p>
    </aside></div>
    <ContextBenchmarkPanel />
  </div>;
}
