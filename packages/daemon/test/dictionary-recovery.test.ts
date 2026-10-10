// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphifyConfigSchema } from '@acc/core';
import { GraphContext } from '../src/context/graph.ts';
import { git, makeConfig, makeRepo, startDaemon, tmpDir, type Harness } from './helpers.ts';

const fixture=path.join(import.meta.dirname,'fixtures','controlled-graphify.mjs');
const harnesses:Harness[]=[];
afterEach(async()=>{
  vi.restoreAllMocks();
  await Promise.all(harnesses.splice(0).map(h=>h.close()));
  delete process.env.DICTIONARY_GRAPH_MODE_FILE;
});
const snapshot=[{path:'src/math.ts',content:'export const total = 3;\n'}];
function graphFixture(){
  const mode=path.join(tmpDir('graph-recovery-mode'),'mode');
  process.env.DICTIONARY_GRAPH_MODE_FILE=mode;fs.writeFileSync(mode,'ok');
  const dir=path.join(tmpDir('graph-recovery'),'source');
  const cfg=GraphifyConfigSchema.parse({enabled:true,binary:fixture});
  const options={repo:makeRepo(),branch:'integration',dir};
  return {graph:new GraphContext(cfg,options),cfg,options,mode,dir};
}

describe('Dictionary graph publication recovery',()=>{
  it.each(['malformed','invalid-shape'])('preserves the prior exact graph when a successful process returns %s output',async modeName=>{
    const f=graphFixture(),first='a'.repeat(40),next='b'.repeat(40);
    expect((await f.graph.buildSnapshot(first,snapshot)).state).toBe('ready');
    const before=fs.readFileSync(f.graph.graphPath());
    fs.writeFileSync(f.mode,modeName);
    const result=await f.graph.buildSnapshot(next,snapshot);
    expect(result).toMatchObject({state:'error',sha:first});
    expect(result.error).toMatch(/no readable graph/);
    expect(fs.readFileSync(f.graph.graphPath())).toEqual(before);
    expect(f.graph.current(first)).toBe(true);expect(f.graph.current(next)).toBe(false);
  });

  it('rolls back a failed promotion rename and can build successfully afterward',async()=>{
    const f=graphFixture(),first='c'.repeat(40),next='d'.repeat(40);
    await f.graph.buildSnapshot(first,snapshot);
    const before=fs.readFileSync(f.graph.graphPath()),rename=fs.renameSync;
    let failed=false;
    const spy=vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{
      if(!failed&&String(from)===`${f.dir}.next`&&String(to)===f.dir){failed=true;throw Object.assign(new Error('fixture promotion denied'),{code:'EACCES'});}
      return rename(from,to);
    });
    expect(await f.graph.buildSnapshot(next,snapshot)).toMatchObject({state:'error',sha:first});
    expect(fs.readFileSync(f.graph.graphPath())).toEqual(before);
    spy.mockRestore();
    expect(await f.graph.buildSnapshot(next,snapshot)).toMatchObject({state:'ready',sha:next});
  });

  it('restores a verified backup after interruption between publication renames',async()=>{
    const f=graphFixture(),first='e'.repeat(40);
    await f.graph.buildSnapshot(first,snapshot);
    const before=fs.readFileSync(f.graph.graphPath());
    fs.renameSync(f.dir,`${f.dir}.previous`);
    fs.mkdirSync(path.join(f.dir,'graphify-out'),{recursive:true});
    fs.writeFileSync(path.join(f.dir,'graphify-out','graph.json'),'not JSON');
    const restored=new GraphContext(f.cfg,f.options);
    expect(restored.status).toMatchObject({state:'ready',sha:first});
    expect(fs.readFileSync(restored.graphPath())).toEqual(before);
    expect(fs.existsSync(`${f.dir}.previous`)).toBe(false);
  });
});

async function launch(over:Record<string,unknown>={}){
  const h=await startDaemon(makeConfig(makeRepo(),over),{server:false,probe:false});
  harnesses.push(h);return h;
}

describe('Dictionary ownership and packet limits',()=>{
  it('rebuilds the same Git revision for a new privacy generation and removes obsolete graph data even if extraction fails',async()=>{
    const f=graphFixture(),repo=makeRepo();
    fs.writeFileSync(path.join(repo,'private.ts'),'export const marker = "NEWGRAPHSECRET-78";\n');
    git(repo,'add','-A');git(repo,'commit','-qm','graph policy fixture');git(repo,'branch','-f','integration','HEAD');
    const h=await startDaemon(makeConfig(repo,{graphify:{enabled:true,binary:fixture}}),{server:false,probe:false});harnesses.push(h);
    const graph=h.d.context.graph!,revision=h.d.context.answer.status.revision!,first=h.d.context.answer.status.generation!;
    expect(fs.readFileSync(path.join(graph.dir,'private.ts'),'utf8')).toContain('NEWGRAPHSECRET-78');
    h.d.addSecret('NEWGRAPHSECRET-78');await h.d.context.answer.refresh(false);
    const second=h.d.context.answer.status.generation!;
    expect(second).not.toBe(first);expect(h.d.context.answer.status.revision).toBe(revision);
    expect(graph.current(revision,second)).toBe(true);expect(graph.current(revision,first)).toBe(false);
    expect(fs.readFileSync(path.join(graph.dir,'private.ts'),'utf8')).not.toContain('NEWGRAPHSECRET-78');
    // A newly protected value already present in cached source must disappear before rebuilding.
    h.d.addSecret('export const');fs.writeFileSync(f.mode,'fail');
    await h.d.context.answer.refresh(false);
    expect(h.d.context.answer.status.graphRevision).toBeNull();
    expect(fs.existsSync(graph.dir)).toBe(false);expect(fs.existsSync(`${graph.dir}.previous`)).toBe(false);
  });

  it('waits for in-flight document retrieval before closing its manifest hooks',async()=>{
    let hold=false,release!:()=>void,entered=false;
    const fetchFixture=async(url:string,init?:RequestInit)=>{
      if(url.endsWith('/api/tags'))return Response.json({models:[{name:'fixture:latest',digest:'fixture'}]});
      if(url.endsWith('/api/show'))return Response.json({capabilities:['embedding']});
      if(url.endsWith('/api/embed')){
        if(hold){entered=true;await new Promise<void>(r=>{release=r;});}
        const input=JSON.parse(String(init?.body)).input as string[];
        return Response.json({embeddings:input.map(()=>[1,0])});
      }
      throw new Error('unexpected fixture request');
    };
    const h=await startDaemon(makeConfig(makeRepo(),{knowledge:{vault:tmpDir('query-close'),obsidian_cli:'off',search:{semantic:true,embedding_model:'fixture'}}}),{server:false,probe:false,fetch:fetchFixture});harnesses.push(h);
    const manifest=h.d.context.answer.manifest;
    const identity=h.d.context.docs!.hooks.identity!;
    let invoked=false;
    h.d.context.docs!.hooks.identity=()=>{invoked=true;expect(manifest.db.prepare('SELECT 1 AS n').get()).toMatchObject({n:1});return identity();};
    hold=true;const query=h.d.context.docs!.search('math add');
    await vi.waitFor(()=>expect(entered).toBe(true));
    const closing=h.d.context.answer.close();
    expect(manifest.db.prepare('SELECT 1 AS n').get()).toMatchObject({n:1});
    release();await query;await closing;
    expect(invoked).toBe(true);
    expect(()=>manifest.db.prepare('SELECT 1')).toThrow(/closed|not open/);
  });

  it('never relabels a cached citation with a later revision containing unchanged source',async()=>{
    const repo=makeRepo();
    fs.writeFileSync(path.join(repo,'README.md'),'# Project\nStable citation marker.\n');
    git(repo,'add','-A');git(repo,'commit','-qm','citation source');git(repo,'branch','-f','integration','HEAD');
    const h=await startDaemon(makeConfig(repo),{server:false,probe:false});harnesses.push(h);
    const result=h.d.context.answer.cite(await h.d.context.docs!.search('Stable citation marker'));
    expect(result.citations.some(c=>c.projectSource?.path==='README.md')).toBe(true);
    fs.writeFileSync(path.join(repo,'other.md'),'A different committed file.\n');
    git(repo,'add','-A');git(repo,'commit','-qm','unrelated integration change');git(repo,'branch','-f','integration','HEAD');
    await h.d.context.answer.refresh(false);
    const recited=h.d.context.answer.cite(result);
    expect(recited.citations.every(c=>!c.projectSource)).toBe(true);
    const fresh=h.d.context.answer.cite(await h.d.context.docs!.search('Stable citation marker'));
    expect(fresh.citations.some(c=>c.projectSource?.revision===git(repo,'rev-parse','HEAD'))).toBe(true);
  });

  it('closes the old manifest when reconnecting a project vault',async()=>{
    const h=await launch({knowledge:{vault:tmpDir('old-vault'),obsidian_cli:'off',search:{semantic:false}}});
    const old=h.d.context.answer;
    await h.d.connectKnowledge({vault:tmpDir('new-vault'),obsidian_cli:'off',search:{semantic:false}});
    await h.d.context.answer.refresh(false);
    expect(h.d.context.answer).not.toBe(old);
    expect(()=>old.manifest.db.prepare('SELECT 1')).toThrow(/closed|not open/);
    await expect(old.close()).resolves.toBeUndefined();
  });

  it.each([3000,9000,16000])('bounds the complete serialized packet to %i characters with large optional sections',async budget=>{
    const h=await launch();
    h.d.context.answer.status.languages=Object.fromEntries(Array.from({length:300},(_,i)=>[`language-${i}-${'x'.repeat(80)}`,1]));
    h.d.context.answer.status.packages=Array.from({length:20},(_,i)=>({path:`packages/${'q'.repeat(200)}/${i}`,name:'quoted " name\n'.repeat(40),scripts:{},dependencies:[]}));
    for(const a of Object.values(h.d.state.agents))a.config.name='long " agent\n'.repeat(500);
    const result=await h.d.context.packets.build({budget});
    const size=JSON.stringify(result).length;
    expect(size).toBeLessThanOrEqual(budget);expect(result.budget.used).toBe(size);
    expect(result.budget.trimmed.length).toBeGreaterThan(0);
  });

  it.each([NaN,Infinity,-1,2999,16001,9000.5])('rejects invalid budgets before any retrieval (%s)',async budget=>{
    const h=await launch();
    const ask=vi.spyOn(h.d.context.docs!,'ask');
    await expect(h.d.context.packets.build({budget,query:'math'})).rejects.toThrow(/integer from 3000 to 16000/);
    expect(ask).not.toHaveBeenCalled();
  });

  it('refuses an undersized packet without truncating its essential identities',async()=>{
    const h=await launch();h.d.config.project.name='project-name-'.repeat(1500);
    await expect(h.d.context.packets.build({budget:3000})).rejects.toThrow(/cannot contain/);
  });

  it('rechecks newly registered secrets and freshness without exposing a mutable cached packet',async()=>{
    const h=await launch();h.d.state.agents.codex.config.name='new-policy-secret-893';
    const first=await h.d.context.packets.build();
    expect(JSON.stringify(first)).toContain('new-policy-secret-893');
    first.team.length=0;
    h.d.addSecret('new-policy-secret-893');
    h.d.context.answer.status.state='error';h.d.context.answer.status.error='intake failed';
    const second=await h.d.context.packets.build();
    expect(second.team.length).toBeGreaterThan(0);
    expect(JSON.stringify(second)).not.toContain('new-policy-secret-893');
    expect(second.project).toMatchObject({state:'error',partial:true});
    expect(second.key).not.toBe(first.key);
  });
});
