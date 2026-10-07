// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { afterEach,describe,expect,it } from 'vitest';
import { sharedCapacity,type AgentConfig } from '@acc/core';
import { makeConfig,makeRepo,startDaemon,waitFor,type Harness } from './helpers.ts';
let h:Harness|null=null;
afterEach(async()=>{await h?.close();h=null;});
const clone=(cfg:AgentConfig)=>({...cfg,id:'codex-ui',name:'UI engineer',enabled:false,instructions:'Use the shared design system and ask the reviewer for feedback.'});
describe('project agent builder',()=>{
  it('creates a draft through the authenticated API and persists without runtime probes or outbound calls',async()=>{
    const cfg=makeConfig(makeRepo());h=await startDaemon(cfg,{probe:false});
    const config=clone(h.d.state.agents.codex.config);
    const token=fs.readFileSync(path.join(h.d.paths.secrets,'install-token'),'utf8').trim();
    const request=(auth:boolean)=>fetch(h!.url+'/api/agents/configure',{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify({config})});
    expect((await request(false)).status).toBe(401);expect((await request(true)).status).toBe(200);
    expect(h.d.state.agents['codex-ui']).toMatchObject({status:'offline',probedAt:null});
    expect(h.d.egress.log).toEqual([]);
    const event=h.d.store.list({}).find(e=>e.type==='agent.registered'&&e.agentId==='codex-ui');expect(event?.actor.type).toBe('human');
    const dataDir=h.dataDir;await h.close();h=null;h=await startDaemon(cfg,{dataDir,server:false,probe:false});
    expect(h.d.state.agents['codex-ui'].config.instructions).toBe(config.instructions);
    await h.d.probeAll();expect(h.d.state.agents['codex-ui'].probedAt).toBeNull();
  });
  it('rejects stale edits, queued edits, secrets and paid opt-in through the draft builder',async()=>{
    h=await startDaemon(makeConfig(makeRepo()),{probe:false});const {d}=h;
    const old=d.state.agents.codex.config;
    d.saveAgent({...old,name:'Focused engineer'},old);
    expect(()=>d.saveAgent({...old,name:'Stale overwrite'},old)).toThrow(/changed/);
    const current=d.state.agents.codex.config;
    d.addSecret('private-builder-secret');
    expect(()=>d.saveAgent({...clone(current),instructions:'private-builder-secret'})).toThrow(/credentials/);
    expect(()=>d.saveAgent({...clone(current),provider:'openai-api',metered_opt_in:true})).toThrow(/cost-approval/);
    const item=d.createIssue({title:'Queued work'});await waitFor(()=>d.state.workItems[item.id].key);
    const a=d.createAssignment({workItemId:item.id,agentId:'codex',allowedPaths:['notes/**']});
    await d.dispatch(a.id,{position:'next'});
    expect(()=>d.saveAgent({...current,enabled:false},current)).toThrow(/Now and Next/);
  });
  it('rolls back the agent event, saved configuration and in-memory config together on storage failure',async()=>{
    h=await startDaemon(makeConfig(makeRepo()),{probe:false});const {d}=h,seq=d.state.seq,old=d.state.agents.codex.config;
    const original=d.store.kvSet.bind(d.store);d.store.kvSet=()=>{throw new Error('disk failure');};
    expect(()=>d.saveAgent({...old,name:'Unsaved'},old)).toThrow('disk failure');
    d.store.kvSet=original;
    expect(d.state.seq).toBe(seq);expect(d.state.agents.codex.config.name).toBe(old.name);expect(d.config.agents.find(a=>a.id==='codex')?.name).toBe(old.name);
    expect(d.store.kvGet('agents:overrides')).toBeNull();
  });
  it('puts custom instructions into reviewable assignments and blocks shared limits for clones and direct starts',async()=>{
    h=await startDaemon(makeConfig(makeRepo()));const {d}=h;
    d.saveAgent({...clone(d.state.agents.codex.config),enabled:true,subscription_group:'renaming-is-not-new-capacity'});
    await d.probe('codex-ui');
    const item=d.createIssue({title:'Build UI'});await waitFor(()=>d.state.workItems[item.id].key);
    const a=d.createAssignment({workItemId:item.id,agentId:'codex-ui',allowedPaths:['notes/**']});
    expect(a.prompt).toContain('Use the shared design system');
    d.commit([{type:'agent.limited',agentId:'codex',data:{until:null,message:'subscription exhausted'}}]);
    expect(sharedCapacity(d.state.agents,'codex-ui').limitedUntil).toBe('unknown');
    expect(d.preflight(a.id).checks.find(c=>c.id==='usage')?.status).toBe('fail');expect(d.agentFree('codex-ui')).toBe(false);
    await expect(d.runs.startAssignment(a.id)).rejects.toThrow(/usage limit/);
    expect(d.state.assignments[a.id].worktree).toBeNull();
  });
});
