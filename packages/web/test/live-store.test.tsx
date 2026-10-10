// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Missing old control mutations cause an authoritative resync, never an out-of-order overwrite.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, emptyState, parseConfig, type EventEnvelope } from '@acc/core';
import { LiveStore } from '../src/lib/store';
import { setRemoteSession } from '../src/lib/remote';
vi.mock('../src/lib/desktop',()=>({isDesktop:false, desktopRequest:vi.fn(),ProjectSwitched:class extends Error {},restartActiveEngine:vi.fn(),switchProject:vi.fn(),websocketUrl:vi.fn(async()=>'ws://fixture/ws')}));
const ev=(seq:number,type:string,data:unknown,refs:Partial<EventEnvelope>={}):EventEnvelope=>({seq,id:`e${seq}`,ts:new Date().toISOString(),type,kind:type.startsWith('t.')?'transcript':'control',actor:{type:'system',id:'control-center'},agentId:'codex',runId:null,workItemId:null,assignmentId:null,data,...refs}) as EventEnvelope;
let client:LiveStore;
afterEach(()=>{client?.dispose();vi.unstubAllGlobals();setRemoteSession(null,'checking');});
function fixture(){
  setRemoteSession(null,'local');client=new LiveStore();
  const cfg=parseConfig({project:{name:'demo',repo:'/r'},agents:[{id:'codex',name:'Codex',role:'engineer',adapter:'codex-cli'}]});
  let s=emptyState();const run={id:'r1',assignmentId:'a1',workItemId:'w1',agentId:'codex',adapter:'codex-cli',state:'running',createdAt:new Date().toISOString(),startedAt:new Date().toISOString(),endedAt:null,exit:null,eventCount:0,usage:{inputTokens:0,outputTokens:0},filesChanged:[],outOfScope:[]};
  for(const e of [ev(1,'config.loaded',{project:cfg.project,tracker:cfg.tracker,policies:cfg.policies}),ev(2,'agent.registered',{config:cfg.agents[0]}),ev(3,'run.created',{run},{runId:'r1'})])s=applyEvent(s,e);
  const view=client as unknown as {onMessage(m:unknown):void};view.onMessage({type:'snapshot',state:s});return {view,s};
}
describe('live control ordering',()=>{
  it('keeps transcript sequence out of the control replay cursor, sorts a batch and dedupes replay',()=>{
    const {view}=fixture();
    view.onMessage({type:'events',events:[ev(7,'t.message',{role:'assistant',text:'message'},{runId:'r1'})]});
    expect(client.state!.seq).toBe(3);
    view.onMessage({type:'events',events:[ev(6,'run.ended',{exit:{kind:'completed',message:'done'}},{runId:'r1'}),ev(5,'run.state',{state:'running'},{runId:'r1'})]});
    expect(client.state!.runs.r1.state).toBe('finished');expect(client.state!.seq).toBe(6);
    const before=client.state;view.onMessage({type:'events',events:[ev(5,'run.state',{state:'running'},{runId:'r1'})]});
    expect(client.state).toBe(before);
  });
  it('repairs an unseen old control event from a snapshot instead of applying it over newer state',async()=>{
    const {view,s}=fixture();
    const end=ev(5,'run.ended',{exit:{kind:'completed',message:'finished'}},{runId:'r1'});
    const later=ev(6,'alert.raised',{alert:{id:'al1',kind:'other',severity:'info',message:'later',dedupeKey:'k',createdAt:new Date().toISOString(),resolvedAt:null,resolution:null}});
    const authoritative=applyEvent(applyEvent(s,end),later);
    vi.stubGlobal('fetch',vi.fn(async p=>p==='/api/state'?new Response(JSON.stringify({state:authoritative,tracker:null,outbox:null})):new Response(JSON.stringify({error:'Not a phone session'}),{status:403})));
    vi.stubGlobal('WebSocket',class {close(){} constructor(_url:string){}});
    view.onMessage({type:'events',events:[later]});view.onMessage({type:'events',events:[end]});
    await client.load();expect(client.state!.runs.r1.state).toBe('finished');expect(client.state!.seq).toBe(6);
    view.onMessage({type:'events',events:[ev(3,'run.state',{state:'running'},{runId:'r1'})]});
    expect(client.state!.runs.r1.state).toBe('finished');
  });
});
