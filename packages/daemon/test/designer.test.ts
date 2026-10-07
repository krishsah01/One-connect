// SPDX-License-Identifier: Apache-2.0
import { afterEach,describe,expect,it } from 'vitest';
import { DEFAULT_DESIGN,designChecks } from '@acc/core';
import { makeConfig,makeRepo,startDaemon,type Harness } from './helpers.ts';
let h:Harness|null=null;
afterEach(async()=>{await h?.close();h=null;});
describe('shared designer',()=>{
  it('validates contrast, saves human revisions and keeps old assignment contracts after a change and restart',async()=>{
    const cfg=makeConfig(makeRepo());h=await startDaemon(cfg,{probe:false,server:false});const {d}=h;
    expect(designChecks(DEFAULT_DESIGN).every(c=>c.passed)).toBe(true);
    expect(()=>d.designer.save({...DEFAULT_DESIGN,colors:{...DEFAULT_DESIGN.colors,text:'#eeeeee'}},null)).toThrow(/contrast/);
    const one=d.designer.save(DEFAULT_DESIGN,null),item=d.createIssue({title:'Mock UI',labels:['design']});
    const a=d.createAssignment({workItemId:item.id,agentId:'codex',allowedPaths:['design/**']});
    expect(a.designRevision).toBe(one.hash);expect(a.prompt).toContain('get_design_system');
    expect(a.prompt).toContain('taste-skill:');expect(a.prompt.length).toBeLessThan(8000);
    const two=d.designer.save({...DEFAULT_DESIGN,radius:12},one.hash);
    expect(two.version).toBe(2);expect(two.hash).not.toBe(one.hash);
    expect(d.designer.exports(a.designRevision!)?.revision.version).toBe(1);
    expect(d.state.design?.version).toBe(2);
    expect(()=>d.designer.save(DEFAULT_DESIGN,one.hash)).toThrow(/changed/);
    const dataDir=h.dataDir;await h.close();h=null;h=await startDaemon(cfg,{dataDir,probe:false,server:false});
    expect(h.d.state.design?.hash).toBe(two.hash);expect(h.d.designer.exports(one.hash)?.revision.system.radius).toBe(8);
    expect(h.d.store.list({types:['design.system_saved']}).every(e=>e.actor.type==='human')).toBe(true);
  });
  it('serves complete pinned instructions and references in bounded pages, rejects path traversal and exposes actual licenses',async()=>{
    h=await startDaemon(makeConfig(makeRepo()),{probe:false,server:false});const s=h.d.designer;
    expect(s.skills().map(s=>s.id)).toEqual(expect.arrayContaining(['taste-skill','web-design-guidelines','design-references','playwright-cli']));
    let offset=0,whole='',more=true;
    while(more){const p=s.readSkill('taste-skill',{offset,budget:1000});expect(p.content.length).toBeLessThanOrEqual(1000);whole+=p.content;offset=p.nextOffset;more=p.more;}
    expect(whole).toContain('BRIEF INFERENCE');expect(whole.length).toBeGreaterThan(1000);
    expect(s.readSkill('web-design-guidelines',{file:'references/guidelines.md'}).content.length).toBeGreaterThan(100);
    expect(s.readSkill('design-references',{file:'references/LICENSE'}).content).toContain('VoltAgent');
    expect(()=>s.readSkill('taste-skill',{file:'../../../../.env'})).toThrow(/reference/);
    expect(s.readSkill('taste-skill').skill.license).toBe('MIT');
  });
});
