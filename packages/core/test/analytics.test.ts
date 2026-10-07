// SPDX-License-Identifier: Apache-2.0
import { describe,expect,it } from 'vitest';
import { emptyState,newAgentState,parseConfig,projectAnalytics,remainingCapacity,type Run,type UsageInfo } from '../src/index.ts';
const usage: UsageInfo={windows:[],status:'unknown',checkedAt:'',source:'vendor'};
describe('recorded analytics',() => {
  it('capacity is unknown without numeric vendor data and uses the tightest shared window',() => {
    expect(remainingCapacity(usage)).toBeNull();
    expect(remainingCapacity({...usage,windows:[{name:'5h',usedPercent:null,resetsAt:null}]})).toBeNull();
    expect(remainingCapacity({...usage,windows:[{name:'5h',usedPercent:40,resetsAt:null},{name:'week',usedPercent:95,resetsAt:null}]})).toBe(5);
    expect(remainingCapacity({...usage,windows:[{name:'5h',usedPercent:100,resetsAt:null}]})).toBe(0);
  });
  it('does not double-count concurrent run time or call a completed session verified work',() => {
    const s=emptyState();
    s.agents.a=newAgentState(parseConfig({project:{name:'example',repo:'/r'},agents:[{id:'a',name:'A',role:'engineer',adapter:'codex-cli'}]}).agents[0]);
    s.project={...parseConfig({project:{name:'example',repo:'/r'},agents:[s.agents.a.config]}).project};
    s.runs.one={id:'one',agentId:'a',state:'finished',startedAt:'2026-10-06T12:00:00Z',endedAt:'2026-10-06T12:02:00Z',usage:{inputTokens:20,outputTokens:10}} as Run;
    s.runs.two={id:'two',agentId:'a',state:'running',startedAt:'2026-10-06T12:01:00Z',endedAt:null,usage:{inputTokens:30,outputTokens:5}} as Run;
    const a=projectAnalytics(s,'2026-10-06T12:03:00Z');
    expect(a.agents[0].runTimeMs).toBe(180000);
    expect(a.inputTokens).toBe(50);expect(a.outputTokens).toBe(15);
    expect(a.finishedRuns).toBe(1);expect(a.verifiedItems).toBe(0);expect(a.activeRuns).toBe(1);
  });
});
