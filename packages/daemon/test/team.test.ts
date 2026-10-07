// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentActor, HUMAN } from '@acc/core';
import { Daemon } from '../src/daemon.ts';
import { makeConfig,makeRepo,startDaemon,waitFor,type Harness } from './helpers.ts';
let h: Harness | null = null;
afterEach(async () => {await h?.close();h=null;});

describe('project team communication', () => {
  it('redacts messages, enforces recipients and acknowledgements, pages without loss, and replays after restart', async () => {
    h=await startDaemon(makeConfig(makeRepo()),{probe:false,server:false});
    const d=h.d;
    d.addSecret('private-test-value-2468');
    const first=d.team.send({recipients:['codex'],subject:'Contract',body:'Never include private-test-value-2468',kind:'question'},agentActor('claude'));
    expect(first.body).not.toContain('private-test-value-2468');
    expect(() => d.team.send({recipients:['external-project'],subject:'x',body:'x'},agentActor('claude'))).toThrow(/not in this project/);
    expect(() => d.team.acknowledge(first.id,'codex',agentActor('cursor'))).toThrow(/only the recipient/);
    expect(() => d.team.acknowledge(first.id,'codex',HUMAN)).toThrow(/only the recipient/);
    expect(() => d.team.send({recipients:['claude'],subject:'x',body:'x',replyTo:first.id},agentActor('cursor'))).toThrow(/not in your inbox/);
    const reply=d.team.send({recipients:['claude'],subject:'Confirmed',body:'I understand',replyTo:first.id},agentActor('codex'));
    expect(reply.kind).toBe('reply');
    d.team.acknowledge(first.id,'codex',agentActor('codex'));
    const seq=d.state.seq;
    d.team.acknowledge(first.id,'codex',agentActor('codex'));
    expect(d.state.seq).toBe(seq);
    for(let i=0;i<52;i++) d.team.send({recipients:['codex'],subject:`Note ${i}`,body:'Keep scope'},HUMAN);
    const page=d.team.list('codex',{limit:9999,unread:true});
    expect(page.messages).toHaveLength(50);expect(page.more).toBe(true);
    expect(d.team.list('codex',{after:page.next,unread:true}).messages).toHaveLength(2);
    expect(d.team.list('cursor').messages).toEqual([]);
    const before = d.state.seq;
    for (let i=0;i<3;i++) d.team.send({recipients:['cursor'],subject:'Long context',body:'x'.repeat(6000)},HUMAN);
    const bounded = d.team.list('cursor',{after:before,budget:9000});
    expect(JSON.stringify(bounded).length).toBeLessThan(9500);
    expect(bounded.messages).toHaveLength(1);
    expect(bounded.more).toBe(true);
    const rest = d.team.list('cursor',{after:bounded.next,budget:12000});
    expect(rest.messages[0].seq).toBeGreaterThan(bounded.next);
    const dataDir=h.dataDir;const cfg=d.config;
    await h.close();h=null;
    const again=new Daemon({config:cfg,dataDir,allowTempDataDir:true,probe:false});
    expect(again.state.teamMessages[first.id].acknowledgedBy.codex).toBeTruthy();
    expect(again.state.teamMessages[reply.id].replyTo).toBe(first.id);
    expect(JSON.stringify(again.state)).not.toContain('private-test-value-2468');
    expect(again.team.list('codex',{unread:true}).messages).toHaveLength(20);
    await again.shutdown();
  });

  it('two live headless agents discover each other, exchange a question/reply and hand off with independent checks', async () => {
    h=await startDaemon(makeConfig(makeRepo()));
    const d=h.d;
    const sender=d.createIssue({title:'Sender notes',description:'[fake:team-sender]'});
    const receiver=d.createIssue({title:'Receiver notes',description:'[fake:team-receiver]'});
    await waitFor(() => d.state.workItems[sender.id].key && d.state.workItems[receiver.id].key);
    const a=d.createAssignment({workItemId:sender.id,agentId:'claude',allowedPaths:[`notes/${d.state.workItems[sender.id].key}.md`]});
    const b=d.createAssignment({workItemId:receiver.id,agentId:'codex',allowedPaths:[`notes/${d.state.workItems[receiver.id].key}.md`]});
    const ra=await d.dispatch(a.id);const rb=await d.dispatch(b.id);
    expect(ra.started && rb.started).toBe(true);
    await waitFor(() => Object.values(d.state.teamMessages).length===2,25_000,'peer exchange');
    const messages=Object.values(d.state.teamMessages);
    const question=messages.find(m => m.kind==='question')!,reply=messages.find(m => m.kind==='reply')!;
    expect(question.sender).toEqual(agentActor('claude'));
    expect(question.recipients).toEqual(['codex']);
    expect(reply.sender).toEqual(agentActor('codex'));expect(reply.replyTo).toBe(question.id);
    await waitFor(() => d.state.teamMessages[reply.id].acknowledgedBy.claude,15_000,'reply acknowledgement');
    expect(d.state.teamMessages[question.id].acknowledgedBy.codex).toBeTruthy();
    for(const id of [sender.id,receiver.id]) await waitFor(() => d.state.workItems[id].evidence.find(e => e.kind==='test' && e.verified),20_000,'verified checks');
    for(const id of [ra.runId!,rb.runId!]) {
      expect(d.state.runs[id].state).toBe('finished');
      expect(d.state.runs[id].handoff).toBeTruthy();
      const token=JSON.parse(fs.readFileSync(path.join(d.paths.runs,id,'mcp.json'),'utf8')).token;
      await expect(d.mcp.call(token,'send_team_message',{recipients:['cursor'],subject:'Stale',body:'x'})).rejects.toThrow(/expired run token/);
    }
  },60_000);

  it('bounded snapshots preserve every agent through paging and never duplicate transcripts',async () => {
    const cfg=makeConfig(makeRepo());
    cfg.agents=Array.from({length:65},(_,i) => ({...cfg.agents[0],id:`agent-${i}`,name:'Agent '+i}));
    h=await startDaemon(cfg,{probe:false,server:false});
    const first=h.d.team.snapshot('agent-0');
    expect(first.agents).toHaveLength(32);expect(first.nextOffset).toBe(32);
    expect(h.d.team.snapshot('agent-0',64).agents).toHaveLength(1);
    expect(h.d.team.dispatchContext('agent-0').length).toBeLessThanOrEqual(6000);
    expect(first.agents.every(a => !('transcript' in a))).toBe(true);
  });
});
