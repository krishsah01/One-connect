// SPDX-License-Identifier: Apache-2.0
// Runs a real, local embedding retrieval check on disposable notes. Never pulls a model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeConfigSchema } from '../packages/core/src/index.ts';
import { AskDocs } from '../packages/daemon/src/context/docs.ts';
import { Vault } from '../packages/daemon/src/context/vault.ts';
const model=process.argv[2] ?? 'all-minilm';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'one-connect-doc-check-'));
const samples={
  'Sessions.md':'# Authentication\nAccess tokens expire after one hour. Login sessions use secure cookies. A fresh login is required after expiration.',
  'Secrets.md':'# Secret storage\nAPI credentials belong in the macOS Keychain. Environment variables are redacted from prompts and logs. Never paste credentials into issue comments.',
  'Design.md':'# Visual language\nUse teal primary buttons on pearl surfaces. Spacing follows an eight-pixel scale. Body text must meet accessible color contrast.',
  'Database.md':'# Data service\nPostgreSQL runs as a project Docker Compose service. It stores development data in a named volume. Production migrations require a backup and human approval.',
  'Reviews.md':'# Independent review\nThe author cannot be the sole reviewer. Review the exact commit SHA and run required checks before a merge to integration.',
  'Billing.md':'# Spending rules\nIncluded subscription usage is the default. Metered APIs, on-demand overage, and paid fallback require explicit per-agent opt-in.',
  'Contract.md':'# Structured context stress check\n'+Array.from({length:60},(_,i)=>`Entry ${i}: branch agent/task-${i}; SHA ${i.toString(16).padStart(40,'0')}; scopes src/components/${i}; permissions read,write,approval; citation [S${i}].`).join('\n'),
};
fs.mkdirSync(path.join(root,'Project'));
for(const [name,text] of Object.entries(samples))fs.writeFileSync(path.join(root,'Project',name),text);
const cases=[
  ['When will I need to authenticate again?','Sessions.md'],
  ['Where do we keep confidential account keys?','Secrets.md'],
  ['What palette and spacing should a mockup use?','Design.md'],
  ['How do we persist relational data in our container environment?','Database.md'],
  ['Can the person who wrote a change be its only approver?','Reviews.md'],
  ['Can an exhausted plan automatically charge for more work?','Billing.md'],
];
const base=KnowledgeConfigSchema.parse({vault:root,folder:'Team',context_folders:['Project'],obsidian_cli:'off',search:{embedding_model:model}});
const lexical=new AskDocs(new Vault(base,root),path.join(root,'keywords.sqlite'),fetch,s=>s);
const hybrid=new AskDocs(new Vault({...base,search:{...base.search,semantic:true}},root),path.join(root,'hybrid.sqlite'),fetch,s=>s);
const started=performance.now(),checks=[];
try {
  await hybrid.index();
  if(hybrid.status().vectors!==hybrid.status().chunks || hybrid.status().error)throw new Error(hybrid.status().error ?? 'Semantic index incomplete');
  for(const [query,expected] of cases){
    const t=performance.now(),a=await lexical.search(query,{limit:3}),b=await hybrid.search(query,{limit:3});
    const target=`Project/${expected}`;
    checks.push({query,expected:target,keywordFirst:a.citations[0]?.path??null,semanticFirst:b.citations[0]?.path??null,semanticTop3:b.citations.map(c=>c.path),top1Correct:b.citations[0]?.path===target,top3Correct:b.citations.some(c=>c.path===target),contextChars:b.contextChars,elapsedMs:Math.round(performance.now()-t)});
  }
  const tags=await(await fetch('http://127.0.0.1:11434/api/tags')).json();
  const report={checkedAt:new Date().toISOString(),model,modelDigest:tags.models.find(m=>m.name===(model.includes(':')?model:`${model}:latest`))?.digest,platform:`${os.platform()} ${os.arch()}`,notes:Object.keys(samples).length,chunks:hybrid.status().chunks,vectors:hybrid.status().vectors,top1:checks.filter(c=>c.top1Correct).length,top3:checks.filter(c=>c.top3Correct).length,cases:checks.length,totalMs:Math.round(performance.now()-started),scope:'Seven disposable English project notes, including dense structured Markdown. Retrieval only; not proof of answer quality or token savings.',checks};
  fs.mkdirSync('docs/verification',{recursive:true});fs.writeFileSync('docs/verification/doc-search.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  if(report.top3<report.cases)process.exitCode=1;
} finally {await lexical.close();await hybrid.close();}
