// SPDX-License-Identifier: Apache-2.0
// Subscription agents on one vendor login share limits. Capacity is never multiplied by cloning.
import type { AgentConfig } from './config.ts';
import type { AgentState, UsageInfo } from './entities.ts';

export function subscriptionGroup(config:AgentConfig):string|null {
  // Ollama's paid cloud models draw on one Ollama account plan, however many agents use it.
  if(config.provider==='ollama-cloud') return 'ollama';
  if(config.provider!=='subscription') return null;
  const official=({'claude-headless':'anthropic','codex-cli':'openai','cursor-agent-cli':'cursor'} as Record<string,string>)[config.adapter];
  // These adapters use the same native login. A renamed group is not a different account.
  if(official) return official;
  return config.subscription_group ?? config.vendor?.toLowerCase() ?? `${config.adapter}:${config.command ?? ''}`;
}

export function subscriptionPeers(agents:Record<string,AgentState>,id:string):AgentState[] {
  const a=agents[id];if(!a)return [];
  const group=subscriptionGroup(a.config);
  return group===null?[a]:Object.values(agents).filter(p=>subscriptionGroup(p.config)===group);
}

const checkedMs=(u:UsageInfo)=>Date.parse(u.checkedAt)||0;

export function sharedCapacity(agents:Record<string,AgentState>,id:string) {
  const peers=subscriptionPeers(agents,id),own=agents[id];
  if(!own) throw new Error(`unknown agent ${id}`);
  const reported=peers.filter(a=>a.usage.windows.some(w=>typeof w.usedPercent==='number') || a.usage.status==='limited').sort((a,b)=>checkedMs(b.usage)-checkedMs(a.usage));
  const limited=peers.find(a=>a.limitedUntil);
  return {group:subscriptionGroup(own.config),peerIds:peers.map(a=>a.id),usage:reported[0]?.usage ?? own.usage,limitedUntil:limited?.limitedUntil ?? null};
}

export interface SharedUsageView {
  group: string | null;
  shared: boolean;
  /** Other agents drawing on the same included usage. */
  peers: { id: string; name: string }[];
  usage: UsageInfo;
  /** Agent whose probe or run reported these numbers; null when nobody has. */
  reportedBy: { id: string; name: string } | null;
  checkedAt: string | null;
  limitedUntil: string | null;
  limitedBy: { id: string; name: string } | null;
  /** One honest sentence for cards and consoles. */
  note: string;
}

/** What a card should say about usage when several agents share one vendor login. */
export function sharedUsageView(agents:Record<string,AgentState>,id:string):SharedUsageView {
  const cap=sharedCapacity(agents,id);
  const name=(a:AgentState)=>({id:a.id,name:a.config.name});
  const peerStates=cap.peerIds.filter(p=>p!==id).map(p=>agents[p]).filter(Boolean);
  const reporter=cap.peerIds.map(p=>agents[p]).find(a=>a && a.usage===cap.usage && (a.usage.windows.some(w=>typeof w.usedPercent==='number') || a.usage.status==='limited'));
  const limitedBy=cap.limitedUntil?cap.peerIds.map(p=>agents[p]).find(a=>a?.limitedUntil)??null:null;
  const shared=peerStates.length>0;
  const parts:string[]=[];
  if(shared) parts.push(`Shared ${cap.group} subscription with ${peerStates.map(a=>a.config.name).join(', ')}`);
  else parts.push(cap.group?`${cap.group} subscription`:'Own connection');
  if(cap.limitedUntil) parts.push(`limited${cap.limitedUntil!=='unknown'?` until ${cap.limitedUntil}`:''}${limitedBy&&limitedBy.id!==id?` (hit by ${limitedBy.config.name})`:''}`);
  if(!reporter) parts.push(cap.usage.status==='unknown'?'vendor does not expose remaining usage':`usage ${cap.usage.status}`);
  else if(reporter.id!==id) parts.push(`numbers reported by ${reporter.config.name}`);
  return {
    group:cap.group,
    shared,
    peers:peerStates.map(name),
    usage:cap.usage,
    reportedBy:reporter?name(reporter):null,
    checkedAt:cap.usage.checkedAt||null,
    limitedUntil:cap.limitedUntil,
    limitedBy:limitedBy?name(limitedBy):null,
    note:parts.join(' · '),
  };
}
