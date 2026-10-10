// SPDX-License-Identifier: Apache-2.0
// Disposable worktrees and the labelled local tracker; no vendor or paid service is called.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { agentActor, DEFAULT_DESIGN, HUMAN, SYSTEM, type Run } from '@acc/core';
import { ensureNativeMockHelper } from './mock-file-helper.ts';
import { git, makeConfig, makeRepo, startDaemon, waitFor, type Harness } from './helpers.ts';
beforeAll(ensureNativeMockHelper);
const handles:Harness[]=[];
afterEach(async()=>{for(const h of handles.splice(0))await h.close();});
async function setup(){
  const cfg=makeConfig(makeRepo());const h=await startDaemon(cfg,{probe:false,server:false});handles.push(h);
  const d=h.d;d.designer.save(DEFAULT_DESIGN,null);
  const {job}=d.designer.studio.createJob({title:'Recovery mock',brief:'Verify a mock capture survives interruption',audience:'Engineers',screens:[{name:'Overview'}],states:['success'],agentId:'codex'},HUMAN);
  const a=d.state.assignments[job.assignmentId];const wt=makeRepo();
  d.commit([{type:'assignment.worktree_ready',actor:SYSTEM,assignmentId:a.id,data:{worktree:wt,branch:'main',baseSha:git(wt,'rev-parse','HEAD')}}]);
  const dir=path.join(wt,job.dir);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'index.html'),'<html lang="en"><body>Recovery mock</body></html>');
  const run:Run={id:'review-fixture-run',assignmentId:a.id,workItemId:a.workItemId,agentId:a.agentId,adapter:'codex-cli',model:null,resolvedModel:null,effort:null,attempt:1,retryOf:null,pid:null,sessionId:null,state:'running',createdAt:d.nowIso(),startedAt:d.nowIso(),endedAt:null,lastEventAt:null,lastMeaningful:null,eventCount:0,usage:{inputTokens:0,outputTokens:0},exit:null,handoff:null,filesChanged:[],outOfScope:[],tests:null,logDir:null};
  d.commit([{type:'run.created',assignmentId:a.id,runId:run.id,agentId:a.agentId,workItemId:a.workItemId,data:{run}}]);
  return {h,d,cfg,a,job,run};
}
describe('Designer capture integrity and recovery',()=>{
  it('serializes simultaneous captures into one artifact and one immutable content revision',async()=>{
    const {d,a,job}=await setup();
    const both=await Promise.all([d.mocks.capture(a.id,job.dir,HUMAN),d.mocks.capture(a.id,job.dir,HUMAN)]);
    expect(both[0].artifact.id).toBe(both[1].artifact.id);expect(Object.keys(d.state.mocks!)).toHaveLength(1);
    expect(d.mocks.get(both[0].artifact.id).revisions).toHaveLength(1);expect(both[1].unchanged).toBe(true);
    expect(Object.values(d.state.designStudio!.captures).filter(c=>c.ok)).toHaveLength(2);
  });
  it('never treats an echo containing a claimed test command as evidence it ran',async()=>{
    const {d,a,job,run}=await setup();
    const cap=await d.mocks.capture(a.id,job.dir,agentActor('codex'),{runId:run.id});
    d.commit([{type:'t.command',runId:run.id,data:{command:'echo "node --test"',status:'completed',exitCode:0}}]);
    const claimed={kind:'command',summary:'Tests',command:'node --test',executed:true,exitCode:0,status:'passed'};
    expect(d.mocks.addEvidence(cap.artifact.id,1,claimed,agentActor('codex'),run.id)).toMatchObject({verified:false,status:'not_run'});
    d.commit([{type:'t.command',runId:run.id,data:{command:'node --test',status:'completed',exitCode:0}}]);
    expect(d.mocks.addEvidence(cap.artifact.id,1,claimed,agentActor('codex'),run.id)).toMatchObject({verified:true,status:'passed'});
  });
  it('recovers a finished run with no capture receipt on restart and does not duplicate it on the next restart',async()=>{
    const {h,d,cfg,a,job,run}=await setup();
    // Stop capture delivery before run completion, representing interruption before its queued task.
    await d.designer.studio.close();
    d.commit([{type:'run.ended',runId:run.id,assignmentId:a.id,data:{exit:{kind:'completed',message:'finished'}}}]);
    expect(Object.values(d.state.designStudio!.captures)).toHaveLength(0);
    await h.close();handles.splice(handles.indexOf(h),1);
    const next=await startDaemon(cfg,{dataDir:h.dataDir,probe:false,server:false});handles.push(next);
    await waitFor(()=>Object.values(next.d.state.designStudio!.captures).some(c=>c.runId===run.id&&c.ok),5000,'recovered capture');
    const id=Object.keys(next.d.state.mocks!)[0];expect(next.d.mocks.get(id).revisions).toHaveLength(1);
    const receipts=Object.values(next.d.state.designStudio!.captures).length;
    await next.close();handles.splice(handles.indexOf(next),1);
    const again=await startDaemon(cfg,{dataDir:h.dataDir,probe:false,server:false});handles.push(again);
    await new Promise(r=>setImmediate(r));
    expect(Object.values(again.d.state.designStudio!.captures)).toHaveLength(receipts);expect(again.d.mocks.get(id).revisions).toHaveLength(1);
    expect(again.d.state.designStudio!.jobs[job.id]).toBeTruthy();
  });
  it('drains an automatic capture already in progress and detaches its listener on close',async()=>{
    const {d,a,job,run}=await setup();
    d.commit([{type:'run.ended',runId:run.id,assignmentId:a.id,data:{exit:{kind:'completed',message:'finished'}}}]);
    await new Promise(r=>setImmediate(r));await d.designer.studio.close();
    expect(Object.values(d.state.designStudio!.captures).filter(c=>c.runId===run.id&&c.ok)).toHaveLength(1);
    const before=d.bus.listenerCount('events');d.designer.studio.start();
    d.commit([{type:'run.ended',runId:run.id,assignmentId:a.id,data:{exit:{kind:'completed',message:'finished'}}}]);
    await new Promise(r=>setImmediate(r));expect(d.bus.listenerCount('events')).toBe(before);
    expect(Object.values(d.state.designStudio!.captures).filter(c=>c.runId===run.id&&c.ok)).toHaveLength(1);
  });
});
