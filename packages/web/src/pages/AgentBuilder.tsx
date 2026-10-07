// SPDX-License-Identifier: Apache-2.0
import { useEffect,useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ADAPTER_TYPES, AgentConfigSchema, EFFORTS, ROLES, subscriptionGroup, type AgentConfig, type ControlState, type DesignSkill, type ProjectSkill } from '@acc/core';
import { ErrorLine, useAction } from '../components/common';
import { api,post } from '../lib/api';

const LABELS:Record<string,string>={'codex-cli':'Codex CLI','claude-headless':'Claude Code','cursor-agent-cli':'Cursor agent CLI','generic-cli':'Custom official CLI','relay':'Manual relay (requires another app)'};

export function AgentBuilder({state}:{state:ControlState}) {
  const {id}=useParams(),[search]=useSearchParams();
  const source=id?state.agents[id]?.config:state.agents[search.get('clone')??'']?.config;
  if(id&&!source)return <div className="page empty">Agent not found.</div>;
  return <BuilderForm key={id??`new:${search.get('clone')??''}`} source={source} editing={Boolean(id)} />;
}

function BuilderForm({source,editing}:{source?:AgentConfig;editing:boolean}) {
  const navigate=useNavigate(),{busy,error,run}=useAction();
  const [expected]=useState(editing?source:null);
  const [cfg,setCfg]=useState<AgentConfig>(()=>source?{...source,...(!editing?{id:'',name:`${source.name} copy`,enabled:false}:{})}:{...AgentConfigSchema.parse({id:'new-agent',name:'Custom agent',role:'engineer',adapter:'codex-cli',enabled:false}),id:'',name:''});
  const patch=(changes:Partial<AgentConfig>)=>setCfg(c=>({...c,...changes}));
  const [args,setArgs]=useState((source?.args??[]).join('\n'));
  const [builtin,setBuiltin]=useState<DesignSkill[]>([]),[project,setProject]=useState<ProjectSkill[]>([]);
  useEffect(()=>{let active=true;void Promise.all([
    api<{skills:DesignSkill[]}>('/api/designer').then(r=>r.skills),
    api<{project:ProjectSkill[]}>('/api/skills').then(r=>r.project),
  ]).then(([b,p])=>{if(active){setBuiltin(b);setProject(p);}}).catch(()=>{});return()=>{active=false;};},[]);
  const paid=cfg.metered_opt_in||cfg.billing==='metered';
  return <div className="page col agent-builder">
    <div className="row wrap"><div><div className="eyebrow">Build your team</div><h1>{editing?'Edit agent':'Create an agent'}</h1><p className="muted">Give one runtime a focused role, model policy and reusable instructions.</p></div><span className="spacer"/><Link className="btn" to="/setup">Back to team</Link></div>
    <ErrorLine error={error}/>
    <form className="card" onSubmit={e=>{e.preventDefault();void run(async()=>{
      const config={...cfg,id:cfg.id.trim(),name:cfg.name.trim(),...(cfg.adapter==='generic-cli'?{args:args.split('\n').map(a=>a.trim()).filter(Boolean)}:{})};
      await post('/api/agents/configure',{config,expected});navigate('/setup');
    });}}>
      <fieldset className="card-b col" disabled={busy||paid} style={{gap:20,border:0}}>
        <div className="builder-fields">
          <label>Display name<input required maxLength={120} value={cfg.name} onChange={e=>patch({name:e.target.value})} placeholder="Frontend engineer"/></label>
          <label>Agent ID<input required pattern="[a-z0-9][a-z0-9-]{0,31}" maxLength={32} disabled={editing} value={cfg.id} onChange={e=>patch({id:e.target.value})} placeholder="frontend"/><span className="small faint">Permanent identity for issues, runs and messages.</span></label>
          <label>Role<select value={cfg.role} onChange={e=>patch({role:e.target.value as AgentConfig['role']})}>{ROLES.map(r=><option key={r} value={r}>{r}</option>)}</select></label>
          <label>Runtime<select value={cfg.adapter} onChange={e=>patch({adapter:e.target.value as AgentConfig['adapter'],binary:undefined,command:undefined,args:undefined,provider:'subscription',billing:'subscription',allowed_models:undefined,model_family:undefined,model:'newest'})}>{ADAPTER_TYPES.map(a=><option key={a} value={a}>{LABELS[a]}</option>)}</select></label>
          <label>Model<input required value={cfg.model} onChange={e=>patch({model:e.target.value})} placeholder="newest"/><span className="small faint">Newest means newest allowed model discovered at dispatch.</span></label>
          <label>Effort<select value={cfg.effort??''} onChange={e=>patch({effort:(e.target.value||undefined) as AgentConfig['effort']})}><option value="">Vendor default</option>{EFFORTS.map(e=><option key={e}>{e}</option>)}</select></label>
          <label>Model family<input value={cfg.model_family??''} onChange={e=>patch({model_family:e.target.value||undefined})} placeholder="Optional inventory filter"/></label>
          <label>Allowed models<input value={(cfg.allowed_models??[]).join(', ')} onChange={e=>patch({allowed_models:e.target.value.split(',').map(x=>x.trim()).filter(Boolean)})} placeholder="Comma-separated IDs or patterns"/></label>
          <label>Subscription name<input value={cfg.subscription??''} onChange={e=>patch({subscription:e.target.value||undefined})} placeholder="Your existing plan"/></label>
          <label>Shared subscription group<input pattern="[a-z0-9][a-z0-9-]{0,63}" disabled={['codex-cli','claude-headless','cursor-agent-cli'].includes(cfg.adapter)} value={['codex-cli','claude-headless','cursor-agent-cli'].includes(cfg.adapter)?subscriptionGroup(cfg)??'':cfg.subscription_group??''} onChange={e=>patch({subscription_group:e.target.value||undefined})} placeholder={subscriptionGroup(cfg)??'Local provider'}/><span className="small faint">Official CLI agents share their native vendor login. Renaming an agent cannot create more capacity.</span></label>
          <label>Parallel run limit<input type="number" min={1} max={8} required value={cfg.concurrency} onChange={e=>patch({concurrency:Number(e.target.value)})}/></label>
          <label>Pinned CLI binary<input value={cfg.binary??''} onChange={e=>patch({binary:e.target.value||undefined})} placeholder="Optional absolute path"/><span className="small faint">Leave empty to detect official installed tools.</span></label>
        </div>
        {cfg.adapter==='generic-cli'&&<div className="builder-fields"><label>CLI command<input required value={cfg.command??''} onChange={e=>patch({command:e.target.value})}/></label><label>One argument per line<textarea value={args} onChange={e=>setArgs(e.target.value)} placeholder="{prompt}\n--model\n{model}"/><span className="small faint">Supported placeholders: prompt, model, cwd, effort. Unknown billing blocks dispatch.</span></label></div>}
        <label>Instructions<textarea rows={7} maxLength={4000} value={cfg.instructions} onChange={e=>patch({instructions:e.target.value})} placeholder="Focus, coding conventions and what to ask peers for…"/><span className="small faint">{cfg.instructions.length}/4,000 characters. Added to the exact assignment prompt for review.</span></label>
        <div className="col"><h2>Reusable skills</h2><p className="small muted">Only descriptions enter the assignment prompt. Agents load instructions with <code>get_skill</code> when needed. Design tasks also receive pinned built-ins. <Link to="/skills">Manage project skills</Link>.</p>
          {project.filter(s=>!s.disabled&&s.latest).map(s=><label className="row" key={s.id}><input type="checkbox" checked={cfg.skills.includes(s.id)} onChange={e=>patch({skills:e.target.checked?[...cfg.skills,s.id]:cfg.skills.filter(id=>id!==s.id)})}/><span>{s.name} <span className="small faint">· project v{s.latest}</span></span></label>)}
          {project.some(s=>!s.disabled&&!s.latest) && <p className="small text-warn">Unpublished project skills are not assignable until you publish them.</p>}
          {builtin.map(s=><label className="row faint" key={s.id}><input type="checkbox" disabled checked={false}/><span>{s.name} <span className="small faint">· built-in · {s.license}</span></span></label>)}
        </div>
        <div className="row wrap"><label className="row"><input type="checkbox" checked={cfg.mode==='coordinator-only'} onChange={e=>patch({mode:e.target.checked?'coordinator-only':'normal'})}/>Coordination only</label><label className="row"><input type="checkbox" checked={cfg.allow_shell} onChange={e=>patch({allow_shell:e.target.checked})}/>Allow shell within assignment scope</label></div>
        <div className="banner tone-info small"><b>Included plan only · paid fallback off.</b> The vendor owns sign-in. Saving creates no run and makes no model call. Enable this agent when you are ready for runtime checks and dispatch.</div>
        {cfg.adapter==='relay'&&<div className="banner tone-warn small">Manual relay requires copying prompts and replies through another app. Choose a CLI runtime for a complete in-app console.</div>}
        <label className="row"><input type="checkbox" checked={cfg.enabled} onChange={e=>patch({enabled:e.target.checked})}/>Enable runtime checks and dispatch</label>
        <div className="row"><button className="btn primary" type="submit">{busy?'Saving…':editing?'Save settings':cfg.enabled?'Create agent':'Save agent draft'}</button><span className="small faint">Saved only in this project. Existing runs and history keep their identity.</span></div>
      </fieldset>
    </form>
    {paid&&<div className="banner tone-warn">This agent has paid mode enabled. Its settings need the separate cost-approval flow.</div>}
  </div>;
}
