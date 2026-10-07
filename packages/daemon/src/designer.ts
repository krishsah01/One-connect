// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { containsSecret,designChecks,designCss,designMarkdown,DesignSystemSchema,HUMAN,isActiveRun,type Assignment,type DesignRevision,type DesignSkill } from '@acc/core';
import { CommandError,type Daemon } from './daemon.ts';
const ROOT=fileURLToPath(new URL('../resources/designer/',import.meta.url));
interface Skill extends DesignSkill {files:{path:string;sha256:string}[];}
const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'manifest.json'),'utf8')) as {skills:Skill[]};
export const builtinSkill=(id:string):Skill|undefined=>manifest.skills.find(s=>s.id===id);
/** Reads one pinned file verbatim after checking its manifest hash. */
export function builtinSkillFile(id:string,file:string):string {
  const s=builtinSkill(id),entry=s?.files.find(f=>f.path===file);
  if(!s||!entry)throw new CommandError('Unknown skill reference',404);
  const text=fs.readFileSync(path.join(ROOT,'skills',id,entry.path),'utf8');
  if(createHash('sha256').update(text).digest('hex')!==entry.sha256)throw new CommandError('Pinned skill integrity check failed',409);
  return text;
}
export class Designer {
  readonly d:Daemon;
  constructor(d:Daemon){this.d=d;}
  skills():DesignSkill[]{return manifest.skills.map(({files:_files,...meta})=>meta);}
  hasSkill(id:string){return manifest.skills.some(s=>s.id===id);}
  selected(a:Assignment):DesignSkill[] {
    const cfg=this.d.state.agents[a.agentId].config,item=this.d.state.workItems[a.workItemId];
    const ids=new Set(cfg.skills??[]);
    if(item.labels.some(l=>/^(design|ui|mock|frontend|branding)$/i.test(l))) for(const s of manifest.skills) ids.add(s.id);
    return this.skills().filter(s=>ids.has(s.id));
  }
  readSkill(id:string,o:{file?:string;offset?:number;budget?:number}={}) {
    const s=manifest.skills.find(s=>s.id===id);if(!s)throw new CommandError('Unknown designer skill',404);
    const file=o.file??'SKILL.md',text=builtinSkillFile(id,file);
    const offset=Number.isSafeInteger(o.offset)?Math.max(0,o.offset!):0,budget=Number.isFinite(o.budget)?Math.min(12000,Math.max(1000,Math.floor(o.budget!))):6000;
    return {skill:{id:s.id,name:s.name,version:s.version,license:s.license,source:s.source},file,content:this.d.redactText(text.slice(offset,offset+budget)),nextOffset:Math.min(text.length,offset+budget),more:offset+budget<text.length,references:s.files.filter(f=>f.path!==file).map(f=>f.path)};
  }
  revision(hash=this.d.state.design?.hash):DesignRevision|null {
    if(!hash)return null;
    if(hash===this.d.state.design?.hash)return this.d.state.design;
    const saved=this.d.store.kvGet(`design:revision:${hash}`);return saved?JSON.parse(saved) as DesignRevision:null;
  }
  save(input:unknown,expected:string|null) {
    const parsed=DesignSystemSchema.safeParse(input);if(!parsed.success)throw new CommandError(parsed.error.message);
    if(expected!==(this.d.state.design?.hash??null))throw new CommandError('The design system changed. Reload before saving.',409);
    if(Object.values(this.d.state.runs).some(isActiveRun))throw new CommandError('Finish active design/code runs before changing their design contract.',409);
    if(containsSecret(JSON.stringify(parsed.data),{denylist:this.d.denylist()}).length)throw new CommandError('Remove credentials from design rules.');
    const checks=designChecks(parsed.data);if(checks.some(c=>!c.passed))throw new CommandError(`Text contrast must be at least 4.5:1: ${checks.filter(c=>!c.passed).map(c=>`${c.name} ${c.ratio.toFixed(2)}:1`).join(', ')}`);
    const hash=createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
    if(hash===expected)return this.d.state.design!;
    const revision:DesignRevision={hash,system:parsed.data,version:(this.d.state.design?.version??0)+1,createdAt:this.d.nowIso()};
    this.d.commit([{type:'design.system_saved',actor:HUMAN,data:{revision}}],[],()=>this.d.store.kvSet(`design:revision:${hash}`,JSON.stringify(revision)));
    return revision;
  }
  exports(hash?:string){const r=this.revision(hash);return r?{revision:r,markdown:designMarkdown(r),css:designCss(r.system),checks:designChecks(r.system)}:null;}
  prompt(a:Assignment) {
    const revision=a.designRevision?this.revision(a.designRevision):null,skills=this.d.skillLib.forAssignment(a);
    if(!revision&&!skills.length)return '';
    const mocks=a.allowedPaths.some(p=>p==='design/**'||p.startsWith('design/'))?'Write self-contained mocks under design/<slug>/ (index.html plus local css/js/svg/png; no remote URLs, no network calls), then call register_design_mock with that folder so One Connect captures an immutable revision for review.\n':'';
    return '\n\n## Project design and skills\n'+(revision?`Design contract: v${revision.version}, SHA-256 ${revision.hash}. Pull get_design_system before UI work; this frozen version applies to your assignment.\n`:'')+mocks+(skills.length?'Available skills (descriptions only; load a skill with get_skill, and its references only when needed):\n'+skills.map(s=>`- ${s.id}: ${s.description}`).join('\n'):'');
  }
}
