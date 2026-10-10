// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { makeConfig, makeRepo, startDaemon, waitFor, type Harness } from './helpers.ts';
let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });
async function api(method: string, route: string, body?: unknown) {
  const token = fs.readFileSync(h!.d.paths.installToken,'utf8').trim();
  const response = await fetch(h!.url + route,{ method, headers:{ authorization:'Bearer '+token,'content-type':'application/json' }, body:method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { status:response.status, body:await response.json() as any };
}
async function setup() {
  h = await startDaemon(makeConfig(makeRepo()),{probe:false});
  const workflows = [];
  for (let i=0;i<3;i++) {
    const item = h.d.createIssue({title:`HTTP workflow ${i}`});
    await waitFor(() => h!.d.state.workItems[item.id].key,5000);
    workflows.push(h.d.workflows.save({definition:{name:`HTTP ${i}`,tasks:[{id:'work',kind:'coordination',agentId:'ag',workItemId:item.id}]}}));
  }
  return workflows;
}
it('supports canvas-generated link ids, waiting updates, listing and cancel over authenticated HTTP', async () => {
  const [from,to] = await setup();
  const saved = await api('POST','/api/workflow-links',{id:'canvas-chain-1',from:from.id,to:[to.id],gate:null});
  expect(saved.status).toBe(200); expect(saved.body.link.id).toBe('canvas-chain-1');
  expect((await api('GET','/api/workflow-links')).body.links[0].id).toBe('canvas-chain-1');
  expect((await api('POST','/api/workflow-links',{id:'canvas-chain-1',from:from.id,to:[to.id],gate:null})).status).toBe(200);
  expect((await api('POST','/api/workflow-links/canvas-chain-1/cancel')).body.link.status).toBe('canceled');
  expect((await api('POST','/api/workflow-links/canvas-chain-1/decide',{option:'Unknown'})).status).toBe(409);
});
it('answers a human gate through its endpoint and saves explicit project defaults without activation', async () => {
  const [from,a,b] = await setup(); const d = h!.d;
  const saved = await api('POST','/api/workflow-links',{from:from.id,to:[a.id,b.id],gate:{kind:'human',question:'Which next?',options:[{label:'A',to:a.id},{label:'B',to:b.id}]}});
  d.commit([{type:'workflow.task_updated',data:{workflowId:from.id,taskId:'work',patch:{status:'done'}}},{type:'workflow.status',data:{workflowId:from.id,status:'completed',reason:'HTTP lifecycle fixture'}}]);
  await d.workflowLinks.idle();
  expect((await api('POST',`/api/workflow-links/${saved.body.link.id}/decide`,{option:'Missing'})).status).toBe(400);
  const chosen = await api('POST',`/api/workflow-links/${saved.body.link.id}/decide`,{option:'B'});
  expect(chosen.status).toBe(200); expect(chosen.body.link.status).toBe('started');
  expect(chosen.body.link.decision.by).toBe('human'); expect(d.state.workflows[a.id].status).toBe('draft');
  expect((await api('GET','/api/workflow-defaults')).body.connectors).toEqual([]);
  const c = d.connectors.save({id:'default-tools',name:'Default tools',config:{kind:'mcp',command:process.execPath,args:[],tools:['read'],read_roots:[]}},null);
  expect((await api('POST','/api/workflow-defaults',{connectors:[c.id]})).body.connectors).toEqual([c.id]);
  expect(d.state.connectors![c.id].approvals).toEqual({});
});
