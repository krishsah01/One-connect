// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import fs from 'node:fs';
import path from 'node:path';
import { afterEach,describe,expect,it } from 'vitest';
import { KnowledgeConfigSchema,redact,type DocAnswer } from '@acc/core';
import { AskDocs,docChunks } from '../src/context/docs.ts';
import { Vault } from '../src/context/vault.ts';
import { makeConfig,makeRepo,startDaemon,tmpDir,waitFor,type Harness } from './helpers.ts';
let docs:AskDocs|null=null,h:Harness|null=null;
afterEach(async()=>{await docs?.close();docs=null;await h?.close();h=null;});
function fixture(semantic=false,answer=false) {
  const root=tmpDir('docs-vault'),data=tmpDir('docs-index');
  fs.mkdirSync(path.join(root,'Project'));fs.mkdirSync(path.join(root,'Private'));
  fs.writeFileSync(path.join(root,'Project','Sessions.md'),'# Session policy\nTokens expire after one hour. Credentials must rotate. private-redact-value\n');
  fs.writeFileSync(path.join(root,'Project','Design.md'),'# Design rules\nUse teal buttons, pearl backgrounds, readable contrast and a consistent spacing scale.\n');
  fs.writeFileSync(path.join(root,'Private','Diary.md'),'Secrets about credentials and sessions.');
  const cfg=KnowledgeConfigSchema.parse({vault:root,folder:'One Connect/sample',context_folders:['Project'],obsidian_cli:'off',search:{semantic,...(answer?{answer_model:'local-answer'}:{})}});
  const calls:{url:string;body:Record<string,unknown>}[]=[];
  let bad=false,installed=true,embeds=0;
  const fetch=async(url:string,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body??'{}'));calls.push({url,body});
    if(url.endsWith('/api/tags'))return Response.json({models:installed?[{name:'embeddinggemma:latest',digest:'v1'},{name:'local-answer:latest',digest:'a1'}]:[]});
    if(url.endsWith('/api/show'))return Response.json({capabilities:['embedding']});
    if(url.endsWith('/api/embed')){
      const inputs=body.input as string[];embeds+=inputs.length;
      return Response.json({embeddings:inputs.map(text=>/expire|rotate|invalid/i.test(text)?[1,0,0]:/design|teal/i.test(text)?[0,1,0]:[0,0,1])});
    }
    if(url.endsWith('/api/generate'))return Response.json({response:JSON.stringify({claims:[{text:'Sessions expire after one hour.',sources:[bad?'S900':'S1']}]})});
    throw new Error('unexpected local endpoint');
  };
  docs=new AskDocs(new Vault(cfg,root),path.join(data,'docs.sqlite'),fetch,s=>redact(s,{denylist:['private-redact-value']}).text);
  return{root,data,cfg,calls,fetch,get embeds(){return embeds;},setBad(){bad=true;},setMissing(){installed=false;}};
}
describe('Ask your docs',()=>{
  it('indexes only selected folders, redacts before disk, cites source lines, and survives reopening',async()=>{
    const f=fixture();const first=await docs!.ask('tokens expire');
    expect(first.mode).toBe('excerpts');expect(first.backend).toBe('keywords');
    expect(first.citations[0]).toMatchObject({path:'Project/Sessions.md',line:1,endLine:3});
    expect(first.citations[0].excerpt).not.toContain('private-redact-value');
    expect(docs!.status().notes).toBe(2);expect(f.calls).toEqual([]);
    expect(fs.readFileSync(path.join(f.data,'docs.sqlite')).includes(Buffer.from('private-redact-value'))).toBe(false);
    await docs!.close();docs=new AskDocs(new Vault(f.cfg,f.root),path.join(f.data,'docs.sqlite'),f.fetch,s=>redact(s,{denylist:['private-redact-value']}).text);
    expect(docs.status().queries).toBe(1);
    fs.unlinkSync(path.join(f.root,'Project','Sessions.md'));
    expect((await docs.search('tokens expire')).citations).toEqual([]);
    expect(docs.status().notes).toBe(1);
  });
  it('implements local embedding batches, vector retrieval and citation validation without remote egress',async()=>{
    // Deterministic protocol fixture, not evidence of a real embedding model's quality.
    const f=fixture(true,true);
    const r=await docs!.ask('When do credentials become invalid?');
    expect(r.backend).toBe('hybrid');expect(r.mode).toBe('answer');
    expect(r.citations[0].path).toBe('Project/Sessions.md');expect(r.claims[0].sources).toEqual(['S1']);
    expect(docs!.status().vectors).toBe(2);
    const before=f.embeds;
    await docs!.index();expect(f.embeds).toBe(before); // unchanged chunks reuse vectors
    expect(f.calls.every(c=>new URL(c.url).hostname==='127.0.0.1')).toBe(true);
    expect(JSON.stringify(f.calls)).not.toContain('private-redact-value');
    expect(JSON.stringify(f.calls)).not.toContain('Secrets about credentials');
    f.setBad();const invalid=await docs!.ask('tokens expire');
    expect(invalid.mode).toBe('excerpts');expect(invalid.answerError).toContain('valid citation');
  });
  it('keeps keyword search usable when the embedding model is absent and never pulls a model',async()=>{
    const f=fixture(true);f.setMissing();
    const r=await docs!.search('tokens expire');
    expect(r.backend).toBe('keywords');expect(r.warning).toContain('never downloads');
    expect(r.citations).toHaveLength(1);expect(f.calls.every(c=>!c.url.includes('pull'))).toBe(true);
    expect(()=>KnowledgeConfigSchema.parse({vault:'x',search:{endpoint:'https://remote.example'}})).toThrow(/127.0.0.1/);
  });
  it('re-indexes complete passages after a context-window rejection and persists the learned size',async()=>{
    const f=fixture(true);
    const text='# Dense contract\n'+Array.from({length:45},(_,i)=>`Rule ${i}: scope paths, model IDs, and evidence SHA. marker${i}`).join('\n');
    fs.writeFileSync(path.join(f.root,'Project','Contract.md'),text);
    await docs!.close();let rejected=0;
    const smallModel=async(url:string,init?:RequestInit)=>{
      if(url.endsWith('/api/embed')) {
        const b=JSON.parse(String(init?.body));expect(b.truncate).toBe(false);
        if(b.input.some((s:string)=>s.length>420)) {rejected++;return Response.json({error:'the input length exceeds the context length'},{status:400});}
      }
      return f.fetch(url,init);
    };
    const file=path.join(f.data,'docs.sqlite');
    docs=new AskDocs(new Vault(f.cfg,f.root),file,smallModel,s=>s);
    await docs.index();expect(rejected).toBeGreaterThan(0);
    expect(docs.status().error).toBeNull();expect(docs.status().vectors).toBe(docs.status().chunks);
    const stored=docs.db.prepare('SELECT content,start_line,end_line FROM chunks WHERE path=?').all('Project/Contract.md') as {content:string;start_line:number;end_line:number}[];
    expect(stored.every(c=>c.content.length<=400)).toBe(true);
    for(let i=0;i<45;i++)expect(stored.some(c=>c.content.includes(`marker${i}`))).toBe(true);
    expect((await docs.search('marker44')).citations.some(c=>c.path==='Project/Contract.md'&&c.line<=46&&c.endLine>=46)).toBe(true);
    await docs.close();rejected=0;
    docs=new AskDocs(new Vault(f.cfg,f.root),file,smallModel,s=>s);
    await docs.index();expect(rejected).toBe(0);expect(docs.status().vectors).toBe(docs.status().chunks);
  });
  it('bounds context, handles long source lines, and removes a revoked scope from the persisted index',async()=>{
    const f=fixture();
    fs.writeFileSync(path.join(f.root,'Project','Long.md'),'tokens '.repeat(3000));
    const r=await docs!.search('tokens',{budget:1500});
    expect(r.contextChars).toBeLessThanOrEqual(1500);expect(r.citations.length).toBeGreaterThan(0);
    expect(docChunks('Long.md','x'.repeat(5000)).every(c=>c.content.length<=1800)).toBe(true);
    await docs!.close();
    docs=new AskDocs(new Vault({...f.cfg,context_folders:[]},f.root),path.join(f.data,'docs.sqlite'),f.fetch,s=>s);
    expect(docs.status().notes).toBe(0);
    expect((await docs.search('tokens')).citations).toEqual([]);
  });
  it('connects a vault through the authenticated app API and restores per-project settings after restart',async()=>{
    const root=tmpDir('connected-vault');fs.mkdirSync(path.join(root,'Project'));fs.writeFileSync(path.join(root,'Project','Hello.md'),'# Project\nEvidence for this local knowledge search.');
    const cfg=makeConfig(makeRepo());h=await startDaemon(cfg,{probe:false});
    const token=fs.readFileSync(path.join(h.d.paths.secrets,'install-token'),'utf8').trim();
    const request=(route:string,body:unknown)=>fetch(h!.url+route,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
    expect((await request('/api/context/connect',{vault:root,folder:'One Connect',context_folders:['Project'],obsidian_cli:'off'})).status).toBe(200);
    await waitFor(()=>!h!.d.context.answer.busy,5000,'project intake after connecting vault');
    const response=await request('/api/context/docs/ask',{query:'Evidence'});
    expect(response.status).toBe(200);expect((await response.json() as DocAnswer).citations.some(c=>c.path==='Project/Hello.md')).toBe(true);
    expect(h.d.store.list({}).some(e=>e.type==='context.connected'&&e.actor.type==='human')).toBe(true);
    const dataDir=h.dataDir;await h.close();h=null;
    h=await startDaemon(cfg,{dataDir,probe:false,server:false});
    expect(h.d.config.knowledge?.vault).toBe(root);expect(h.d.context.docs?.status().queries).toBe(1);
  });
});
