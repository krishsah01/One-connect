// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { KnowledgeConfigSchema,redact } from '@acc/core';
import { Vault,projectNamespace } from '../src/context/vault.ts';
import { AskDocs } from '../src/context/docs.ts';
import { sourcePath } from '../src/context/redaction.ts';
import { extractProject } from '../src/context/extract-project.ts';
import { git,makeRepo,makeConfig,startDaemon,tmpDir,type Harness } from './helpers.ts';

const harnesses:Harness[]=[],indexes:AskDocs[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(harnesses.splice(0).map(h=>h.close()));await Promise.all(indexes.splice(0).map(d=>d.close()));});
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
function committed(repo:string,text:string) {
  fs.writeFileSync(path.join(repo,'README.md'),text);git(repo,'add','-A');git(repo,'commit','-qm','context fixture');
  const revision=git(repo,'rev-parse','HEAD');git(repo,'branch','-f','integration',revision);return revision;
}
const fixtureFetch=async(url:string,init?:RequestInit)=>{
  if(url.endsWith('/api/tags'))return Response.json({models:[{name:'local-fixture:latest',digest:'fixture-v1'}]});
  if(url.endsWith('/api/show'))return Response.json({capabilities:['embedding']});
  if(url.endsWith('/api/embed'))return Response.json({embeddings:JSON.parse(String(init?.body)).input.map(()=>[1,0])});
  throw new Error('Unexpected fixture request');
};
const config=(repo:string,vault:string,semantic=false)=>makeConfig(repo,{knowledge:{vault,folder:'One Connect',context_folders:['One Connect','Team'],obsidian_cli:'off',search:{semantic,embedding_model:'local-fixture'}},graphify:{enabled:true,binary:path.join(import.meta.dirname,'fixtures','fake-graphify.mjs')}});
async function launch(cfg:ReturnType<typeof makeConfig>,dataDir?:string,fetch=fixtureFetch) {
  const h=await startDaemon(cfg,{server:false,probe:false,fetch,dataDir:dataDir??tmpDir('isolated-answer-data')});harnesses.push(h);return h;
}

describe('project-owned Dictionary context',()=>{
  it('isolates same-name projects in one vault across updates, name changes and independent restarts',async()=>{
    const vault=tmpDir('shared-answer'),repoA=makeRepo(),repoB=makeRepo();
    fs.mkdirSync(path.join(vault,'Team'));fs.writeFileSync(path.join(vault,'Team','Shared.md'),'Shared coordination guide.');
    fs.mkdirSync(path.join(vault,'One Connect','sample'),{recursive:true});fs.writeFileSync(path.join(vault,'One Connect','sample','Private.md'),'Legacy foreignprojectmarker');
    const revisionA=committed(repoA,'# A\nalphaexclusive session 47 minutes.'),revisionB=committed(repoB,'# B\nbetaexclusive lease 91 minutes.');
    const cfgA=config(repoA,vault,true),cfgB=config(repoB,vault,true);
    let a=await launch(cfgA),b=await launch(cfgB);
    const folderA=a.d.context.vault!.folder,folderB=b.d.context.vault!.folder;
    expect(folderA).not.toBe(folderB);expect(a.d.context.answer.status).toMatchObject({state:'ready',notesRevision:revisionA,embeddingsRevision:revisionA,graphRevision:revisionA});
    expect(b.d.context.answer.status).toMatchObject({state:'ready',notesRevision:revisionB,embeddingsRevision:revisionB,graphRevision:revisionB});
    const foreignReads=vi.spyOn(fs,'readFileSync');
    const result=a.d.context.answer.cite(await a.d.context.docs!.search('alphaexclusive'));
    expect(result.citations.some(c=>c.projectSource?.revision===revisionA&&c.projectSource.path==='README.md')).toBe(true);
    const fromA=await a.d.context.search('betaexclusive foreignprojectmarker',{graph:false});
    expect(JSON.stringify(fromA)).not.toMatch(/betaexclusive|foreignprojectmarker/);
    expect(foreignReads.mock.calls.some(([file])=>String(file).startsWith(path.join(vault,folderB))||String(file).startsWith(path.join(vault,'One Connect','sample')))).toBe(false);
    foreignReads.mockRestore();
    expect(()=>a.d.context.vault!.read(`${folderB}/Brief.md`)).toThrow(/outside/);
    expect([...a.d.context.vault!.documents()].some(d=>d.path==='Team/Shared.md')).toBe(true);
    const next=committed(repoA,'# A\ngammaexclusive session 63 minutes.');
    await a.d.context.answer.refresh(false);
    expect(a.d.context.answer.status).toMatchObject({notesRevision:next,embeddingsRevision:next,graphRevision:next});
    expect(b.d.context.answer.status.revision).toBe(revisionB);
    // A citation of changed source loses attribution; identical unchanged text may only claim the new revision.
    const recited=a.d.context.answer.cite(result).citations;
    expect(recited.filter(c=>c.excerpt.includes('alphaexclusive')).every(c=>!c.projectSource)).toBe(true);
    expect(recited.filter(c=>c.projectSource).every(c=>c.projectSource!.revision===next)).toBe(true);
    const dataA=a.dataDir,dataB=b.dataDir;await a.close();await b.close();harnesses.splice(0);
    a=await launch({...cfgA,project:{...cfgA.project,name:'renamed project'}},dataA);b=await launch(cfgB,dataB);
    expect(a.d.context.vault!.folder).toBe(folderA);expect(b.d.context.vault!.folder).toBe(folderB);
    expect(a.d.context.answer.cite(await a.d.context.docs!.search('gammaexclusive')).citations.some(c=>c.projectSource?.revision===next)).toBe(true);
    expect(JSON.stringify(await b.d.context.search('gammaexclusive',{graph:false}))).not.toContain('gammaexclusive');
    expect(b.d.context.answer.cite(await b.d.context.docs!.search('betaexclusive')).citations.some(c=>c.projectSource?.revision===revisionB)).toBe(true);
  });

  it('migrates the old display-name registry by regeneration without reading or mutating legacy/user/foreign notes',async()=>{
    const repo=makeRepo(),vault=tmpDir('legacy-answer'),revision=committed(repo,'# Owned\nownedmigration source.'),cfg=config(repo,vault);
    let h=await launch(cfg);const dataDir=h.dataDir,own=h.d.context.vault!.folder,legacy='One Connect/sample/Dictionary';
    const registry=JSON.parse(h.d.store.kvGet('answer:sources')!);
    h.d.store.kvSet('answer:sources',JSON.stringify(Object.fromEntries(Object.entries(registry).map(([rel,s])=>[`${legacy}/${path.basename(rel)}`,s]))));
    h.d.store.kvSet('answer:source-key','legacy-key');await h.close();harnesses.splice(0);
    fs.mkdirSync(path.join(vault,path.dirname(legacy)),{recursive:true});fs.renameSync(path.join(vault,own,'Dictionary'),path.join(vault,legacy));
    fs.writeFileSync(path.join(vault,legacy,'.one-connect-generated'),'One Connect generated project notes\n');
    fs.writeFileSync(path.join(vault,legacy,'User.md'),'Keep my legacy user note.');
    fs.writeFileSync(path.join(vault,legacy,`${'f'.repeat(64)}.md`),'Foreign project source must stay private.');
    const before=fs.readdirSync(path.join(vault,legacy)).map(name=>[name,fs.readFileSync(path.join(vault,legacy,name),'utf8')]);
    const reads=vi.spyOn(fs,'readFileSync');h=await launch(cfg,dataDir);
    expect(reads.mock.calls.some(([file])=>String(file).startsWith(path.join(vault,legacy)))).toBe(false);reads.mockRestore();
    expect(fs.readdirSync(path.join(vault,legacy)).map(name=>[name,fs.readFileSync(path.join(vault,legacy,name),'utf8')])).toEqual(before);
    expect(h.d.context.answer.cite(await h.d.context.docs!.search('ownedmigration')).citations.some(c=>c.path.startsWith(own)&&c.projectSource?.revision===revision)).toBe(true);
    expect(Object.keys(JSON.parse(h.d.store.kvGet('answer:sources')!)).every(rel=>rel.startsWith(own+'/'))).toBe(true);
    expect(JSON.stringify(await h.d.context.docs!.search('Foreign project source'))).not.toContain('must stay private');
  });

  it('repairs deleted, corrupt and symlink-replaced generated notes and overview, preserving unregistered additions',async()=>{
    const repo=makeRepo(),vault=tmpDir('repair-answer'),revision=committed(repo,'# Owned\nrepairmarker intact.'),h=await launch(config(repo,vault,true));
    const v=h.d.context.vault!,note=v.notePath('Dictionary',digest('README.md')+'.md'),abs=path.join(vault,note);
    const result=h.d.context.answer.cite(await h.d.context.docs!.search('repairmarker'));
    const forged=h.d.context.answer.cite({...result,citations:result.citations.map(c=>({...c,excerpt:'invented source statement'}))});
    expect(forged.citations.every(c=>!c.projectSource)).toBe(true);
    const extra=path.join(vault,v.notePath('Dictionary','User.md'));fs.writeFileSync(extra,'Preserve this user addition.');
    for(const damage of ['missing','corrupt','symlink','overview','graph','graph-revision'] as const) {
      if(damage==='missing')fs.unlinkSync(abs);
      if(damage==='corrupt')fs.writeFileSync(abs,'Corrupt source.');
      if(damage==='symlink'){fs.unlinkSync(abs);fs.symlinkSync(extra,abs);}
      if(damage==='overview')fs.appendFileSync(path.join(vault,v.notePath('Dictionary','Overview.md')),'Forged overview with same SHA.');
      if(damage==='graph')fs.unlinkSync(h.d.context.graph!.graphPath());
      if(damage==='graph-revision')fs.writeFileSync(path.join(h.d.context.graph!.dir,'graphify-out','.acc-sha'),'not a revision');
      await h.d.context.answer.refresh(false);
      expect(h.d.context.answer.status).toMatchObject({state:'ready',notesRevision:revision,embeddingsRevision:revision,graphRevision:revision});
      expect(fs.lstatSync(abs).isSymbolicLink()).toBe(false);expect(fs.readFileSync(abs,'utf8')).toContain('repairmarker');
      expect(fs.readFileSync(extra,'utf8')).toBe('Preserve this user addition.');
      expect(()=>v.read(v.notePath('Dictionary','../Dictionary/User.md'))).toThrow(/registry/);
      expect(h.d.context.answer.cite(await h.d.context.docs!.search('repairmarker')).citations.some(c=>c.projectSource?.revision===revision)).toBe(true);
      expect(JSON.stringify(await h.d.context.docs!.search('Preserve this user addition'))).not.toContain('Preserve this user addition.');
    }
  });

  it('keeps an unavailable semantic model partial after restarting an index with previously complete vectors',async()=>{
    const repo=makeRepo(),vault=tmpDir('missing-model'),cfg=config(repo,vault,true);let h=await launch(cfg);
    expect(h.d.context.answer.status.state).toBe('ready');const data=h.dataDir;await h.close();harnesses.splice(0);
    const calls:string[]=[];
    h=await launch(cfg,data,async url=>{calls.push(url);return Response.json({models:[]});});
    expect(h.d.context.answer.status).toMatchObject({state:'partial',embeddingsRevision:null});
    expect((await h.d.context.docs!.search('math')).backend).toBe('keywords');
    expect(calls.every(url=>url.endsWith('/api/tags'))).toBe(true);
  });
});

describe('bounded source metadata redaction',()=>{
  const key='ghp_'+'A'.repeat(36),secret='path-denylist-value',clean=(s:string)=>redact(s,{denylist:[secret]}).text;
  it.each([`src/${key}.ts`,`docs/${secret}/README.md`,`docs/${secret}/${key}.json`,'src/'+('long'.repeat(65))+'.ts','目录/'+secret+'.md'])( 'aliases source path %s safely and deterministically',raw=>{
    const safe=sourcePath(raw,clean);expect(safe).toBe(sourcePath(raw,clean));expect(safe).not.toContain(key);expect(safe).not.toContain(secret);
    expect(safe.split('/').every(p=>p&&p!=='.'&&p!=='..'&&Buffer.byteLength(p)<=240)).toBe(true);expect(Buffer.byteLength(safe)).toBeLessThan(256);
  });
  it('bounds path expansion, separates aliases, and retains ordinary source paths',()=>{
    expect(sourcePath('src/ordinary.ts',clean)).toBe('src/ordinary.ts');
    expect(sourcePath(`src/${key}.ts`,clean)).not.toBe(sourcePath(`src/ghp_${'B'.repeat(36)}.ts`,clean));
    expect(sourcePath('src/file.ts',()=>'/../../outside\n')).toMatch(/^one-connect-redacted\/[a-f0-9]{64}\/source\.ts$/);
    expect(()=>sourcePath('x'.repeat(4097)+'.md',clean)).toThrow(/size limit/);
  });
  it('redacts paths and escaped manifest keys/values before notes, vectors, graph, events and citations',async()=>{
    const repo=makeRepo(),vault=tmpDir('redacted-metadata');
    const rawPath=`src/${key}.ts`;fs.writeFileSync(path.join(repo,rawPath),`export const metadatafixture = "${key}";\n`);
    const manifest={name:key,dependencies:{[key]:'1'},scripts:{[key]:`echo ${key}`}};
    fs.writeFileSync(path.join(repo,'package.json'),JSON.stringify(manifest).replaceAll(key,'\\u0067'+key.slice(1)));
    fs.mkdirSync(path.join(repo,'packages',key),{recursive:true});fs.writeFileSync(path.join(repo,'packages',key,'package.json'),JSON.stringify(manifest));
    const revision=committed(repo,'# Metadata\nmetadatafixture project.');
    const extraction=await extractProject(repo,revision,s=>redact(s).text);
    expect(JSON.stringify(extraction)).not.toContain(key);expect(extraction.packages[0].dependencies).toEqual(['[REDACTED:github-token]']);
    expect(Object.keys(extraction.packages[0].scripts)).toEqual(['[REDACTED:github-token]']);
    const safePath=sourcePath(rawPath,s=>redact(s).text),file=extraction.files.find(f=>f.path===safePath)!;
    expect(file).toBeDefined();expect(file.hash).toBe(digest(file.content));
    const inputs:unknown[]=[];const h=await launch(config(repo,vault,true),undefined,async(url,init)=>{inputs.push(init?.body??'');return fixtureFetch(url,init);});
    const graph=h.d.context.graph!;
    expect(fs.existsSync(path.join(graph.dir,rawPath))).toBe(false);expect(fs.readFileSync(path.join(graph.dir,safePath),'utf8')).toBe(file.content);
    expect(fs.readFileSync(graph.graphPath(),'utf8')).not.toContain(key);
    expect(await graph.query(key)).not.toContain(key);
    const result=h.d.context.answer.cite(await h.d.context.docs!.search('metadatafixture'));
    expect(result.citations.some(c=>c.projectSource?.path===safePath&&c.projectSource.revision===revision&&c.projectSource.hash===file.hash)).toBe(true);
    expect(JSON.stringify([result,h.d.context.answer.status,h.d.store.kvGet('answer:sources'),h.d.store.list({}),inputs])).not.toContain(key);
    const rows=h.d.context.docs!.db.prepare('SELECT * FROM chunks').all();expect(JSON.stringify(rows)).not.toContain(key);
    expect([...h.d.context.vault!.documents()].every(d=>!d.content.includes(key)&&!d.path.includes(key))).toBe(true);
  });
  it('keeps redacted user-note paths out of disk metadata and citation URLs, including after reopen',async()=>{
    const root=tmpDir('private-path-vault'),index=path.join(tmpDir('path-index'),'docs.sqlite'),cfg=KnowledgeConfigSchema.parse({vault:root,folder:'Own',context_folders:['Team'],obsidian_cli:'off'});
    fs.mkdirSync(path.join(root,'Team'));fs.writeFileSync(path.join(root,'Team',`${key}.md`),'# Path note\npathcitationfixture context.');
    let docs=new AskDocs(new Vault(cfg,root),index,fixtureFetch,clean);indexes.push(docs);
    const first=await docs.search('pathcitationfixture');expect(first.citations).toHaveLength(1);expect(first.citations[0].url).toBe('');
    expect(JSON.stringify(first)).not.toContain(key);expect(fs.readFileSync(index).includes(Buffer.from(key))).toBe(false);
    await docs.close();indexes.splice(0);docs=new AskDocs(new Vault(cfg,root),index,fixtureFetch,clean);indexes.push(docs);
    expect((await docs.search('pathcitationfixture')).citations[0].path).toBe(first.citations[0].path);
  });
});

describe('vault ownership boundaries',()=>{
  it('preserves colliding user note names and recovers a interrupted swap with unregistered additions',()=>{
    const root=tmpDir('generated-collision'),v=new Vault(KnowledgeConfigSchema.parse({vault:root,folder:'Own',obsidian_cli:'off'}),root,'a'.repeat(64));
    const collection=v.notePath('Dictionary'),name=digest('source.md')+'.md',next=digest('new.md')+'.md';
    v.replaceGenerated(collection,{[name]:'generated','Overview.md':'overview'});
    fs.writeFileSync(path.join(root,collection,next),'User content with a colliding name.');
    expect(()=>v.replaceGenerated(collection,{[name]:'updated',[next]:'new source','Overview.md':'overview'})).toThrow(/unowned note/);
    expect(fs.readFileSync(path.join(root,collection,next),'utf8')).toBe('User content with a colliding name.');
    const backup=path.join(root,v.folder,'.Dictionary.one-connect-previous');
    fs.renameSync(path.join(root,collection),backup);
    v.replaceGenerated(collection,{[name]:'recovered','Overview.md':'overview'});
    expect(fs.readFileSync(path.join(root,collection,name),'utf8')).toBe('recovered');
    expect(fs.readFileSync(path.join(root,collection,next),'utf8')).toBe('User content with a colliding name.');
  });
  it('does not overwrite a user namespace or another owner, even through a separately configured shared folder',()=>{
    const root=tmpDir('namespace-user'),cfg=KnowledgeConfigSchema.parse({vault:root,folder:'One Connect',obsidian_cli:'off'}),owner='a'.repeat(64),v=new Vault(cfg,root,owner);
    fs.mkdirSync(path.join(root,v.folder),{recursive:true});fs.writeFileSync(path.join(root,v.folder,'User.md'),'Keep user content.');
    expect(()=>v.write(v.notePath('Brief.md'),'replacement')).toThrow();expect([...v.documents()]).toEqual([]);
    fs.writeFileSync(path.join(root,v.folder,'.one-connect-project'),JSON.stringify({version:1,owner:'b'.repeat(64)}));
    expect(()=>v.write(v.notePath('Brief.md'),'replacement')).toThrow();expect(fs.readFileSync(path.join(root,v.folder,'User.md'),'utf8')).toBe('Keep user content.');
    const foreign=new Vault({...cfg,folder:'Separate'},root,'b'.repeat(64));foreign.write(foreign.notePath('Brief.md'),'foreignnamespace content');
    const reader=new Vault({...cfg,context_folders:['Separate']},root,'c'.repeat(64));
    expect([...reader.documents()]).toEqual([]);expect(()=>reader.read(foreign.notePath('Brief.md'))).toThrow(/outside/);
  });
  it('recreates deleted ordinary notes and resolves repository aliases to the same namespace',()=>{
    const root=tmpDir('namespace-repair'),repo=makeRepo(),alias=path.join(root,'repo-alias');fs.symlinkSync(repo,alias);
    expect(projectNamespace(repo)).toBe(projectNamespace(alias));
    const v=new Vault(KnowledgeConfigSchema.parse({vault:root,folder:'Own',obsidian_cli:'off'}),root,projectNamespace(repo)),rel=v.notePath('Brief.md');
    expect(v.write(rel,'stable brief')).toBe(true);fs.unlinkSync(path.join(root,rel));expect(v.write(rel,'stable brief')).toBe(true);
  });
});
