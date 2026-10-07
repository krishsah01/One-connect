// SPDX-License-Identifier: Apache-2.0
// Run directly with Node 24 --test: exercises real TS module loading without a transpiler.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../../core/src/index.ts';
import { Daemon } from '../src/daemon.ts';

test('strip-only daemon intake scopes two same-name projects, revisions and restarted citations',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'one-answer-strip-')),vault=path.join(root,'vault');
  const live=new Set();
  const git=(repo,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd:repo,encoding:'utf8',env:{PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'}}).trim();
  const repo=(name,marker)=>{
    const dir=path.join(root,name);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'README.md'),`# Project\n${marker} committed context.\n`);
    fs.writeFileSync(path.join(dir,'source.ts'),`export const marker = '${marker}';\n`);
    git(dir,'init','-q','-b','main');git(dir,'add','-A');git(dir,'commit','-qm','fixture');git(dir,'branch','integration');return dir;
  };
  const localFetch=async(url,init)=>{
    if(url.endsWith('/api/tags'))return Response.json({models:[{name:'fixture:latest',digest:'v1'}]});
    if(url.endsWith('/api/show'))return Response.json({capabilities:['embedding']});
    if(url.endsWith('/api/embed'))return Response.json({embeddings:JSON.parse(init.body).input.map(()=>[1,0])});
    throw new Error('unexpected fixture endpoint');
  };
  const start=async(repo,data,name='same')=>{
    const config=parseConfig({project:{name,repo},tracker:{type:'local'},agents:[{id:'relay',name:'Offline relay',role:'engineer',adapter:'relay'}],knowledge:{vault,folder:'One Connect',context_folders:['One Connect'],obsidian_cli:'off',search:{semantic:true,embedding_model:'fixture'}},graphify:{enabled:true,binary:path.join(import.meta.dirname,'fixtures','fake-graphify.mjs')}});
    const persisted=fs.existsSync(path.join(root,data,'acc.sqlite'));
    const daemon=new Daemon({config,dataDir:path.join(root,data),allowTempDataDir:true,probe:false,fetch:localFetch,rulesTickMs:3600000});
    if(persisted){assert.equal(daemon.context.answer.status.state,'partial');assert.equal(daemon.context.answer.status.embeddingsRevision,null);assert.equal(daemon.context.docs.status().backend,'keywords');}
    live.add(daemon);await daemon.start();await daemon.context.answer.refresh(false);return daemon;
  };
  const stop=async d=>{await d.shutdown();live.delete(d);};
  try {
    fs.mkdirSync(vault);
    const repoA=repo('repo-a','stripalpha'),repoB=repo('repo-b','stripbeta');
    let a=await start(repoA,'data-a'),b=await start(repoB,'data-b');
    assert.notEqual(a.context.vault.folder,b.context.vault.folder);
    const revision=git(repoA,'rev-parse','HEAD');
    for(const stage of ['revision','notesRevision','embeddingsRevision','graphRevision'])assert.equal(a.context.answer.status[stage],revision);
    const result=a.context.answer.cite(await a.context.docs.search('stripalpha'));
    assert.ok(result.citations.some(c=>c.projectSource?.revision===revision));
    assert.ok(!JSON.stringify(await b.context.docs.search('stripalpha')).includes('stripalpha'));
    assert.throws(()=>a.context.vault.read(b.context.vault.notePath('One Answer','Overview.md')),/outside/);
    const namespace=a.context.vault.folder;
    const source=result.citations.find(c=>c.projectSource?.path==='README.md');
    fs.unlinkSync(path.join(vault,source.path));await a.context.answer.refresh(false);
    assert.ok(a.context.answer.cite(await a.context.docs.search('stripalpha')).citations.some(c=>c.projectSource?.revision===revision));
    a.store.kvSet('answer:sources','{corrupt');await stop(a);await stop(b);
    a=await start(repoA,'data-a','renamed');b=await start(repoB,'data-b');
    assert.equal(a.context.vault.folder,namespace);
    assert.ok(a.context.answer.cite(await a.context.docs.search('stripalpha')).citations.some(c=>c.projectSource?.revision===revision));
    assert.ok(!JSON.stringify(await a.context.docs.search('stripbeta')).includes('stripbeta'));
    assert.equal(a.context.answer.status.state,'ready');assert.equal(b.context.answer.status.state,'ready');
  } finally {
    await Promise.all([...live].map(stop));fs.rmSync(root,{recursive:true,force:true});
  }
});
