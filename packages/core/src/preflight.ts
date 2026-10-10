// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Dispatch pre-flight. Pure: the daemon gathers the facts, this decides.
import type { Policy, ProjectConfig } from './config.ts';
import type { AgentState, Assignment, PreflightCheck, PreflightResult, WorkItem } from './entities.ts';
import { checkQualityFloor, eligibleModels, isNewest, matchesAny, modelFamilyKey, newestInFamily, selectNewestModel, workCategory, type PickOptions } from './models.ts';
import { scopesOverlap } from './pathScope.ts';
import { containsSecret } from './redact.ts';
import { isManualRelay } from './adapterProfiles.ts';

export const COORDINATION_LABELS = ['coordination', 'planning', 'triage', 'research'];

export interface PreflightInput {
  now: string;
  item: WorkItem | undefined;
  assignment: Assignment;
  agent: AgentState | undefined;
  project: ProjectConfig;
  policies: Policy;
  killSwitch: boolean;
  /** Other assignments that currently hold a worktree (position now, not done). */
  activeAssignments: Assignment[];
  /** Daemon's check that the pinned vendor binary is still the one that was probed. */
  binaryCheck?: { status: 'pass' | 'warn' | 'fail'; message: string };
  denylist?: readonly string[];
  /** Spend recorded today for this agent (metered providers). */
  spentTodayUsd?: number;
  /** Whether the provider's API key / local server is available. */
  providerCheck?: { status: 'pass' | 'warn' | 'fail'; message: string };
  /** Human confirmation for paid settings the official CLI cannot expose, verified by the daemon. */
  subscriptionConfirmation?: { valid: boolean; message: string };
}

export function pickOptions(agent: AgentState, policies: Policy): PickOptions {
  return {
    family: agent.config.model_family,
    effort: agent.config.effort ?? null,
    allowed: agent.config.allowed_models ?? policies.allowed_models,
    denied: policies.denied_models,
  };
}

/**
 * The model a dispatch would use right now. `newest` is the newest model in the same line as the
 * configured model; `blocked` explains an ambiguous selection across unrelated model lines.
 */
export function resolveModel(agent: AgentState, policies: Policy): { model: string | null; newest: string | null; blocked: string | null } {
  const opts = pickOptions(agent, policies);
  if (agent.config.model !== 'newest') return { model: agent.config.model, newest: newestInFamily(agent.config.model, agent.models.available, opts)?.id ?? null, blocked: null };
  const sel = selectNewestModel(agent.models.available, opts);
  if (sel.reason === 'ambiguous') return { model: null, newest: null, blocked: sel.message };
  const newest = sel.model?.id ?? null;
  return { model: newest ?? agent.config.model_family ?? null, newest, blocked: null };
}

export function runPreflight(i: PreflightInput): PreflightResult {
  const checks: PreflightCheck[] = [];
  const add = (c: PreflightCheck) => checks.push(c);
  const { item, agent, assignment, policies } = i;
  const relay = agent ? isManualRelay(agent.config) : false;

  add(i.killSwitch ? { id: 'kill_switch', label: 'Kill switch', status: 'fail', message: 'kill switch is engaged; release it to dispatch' } : { id: 'kill_switch', label: 'Kill switch', status: 'pass', message: 'not engaged' });

  if (!item) add({ id: 'issue', label: 'Issue exists', status: 'fail', message: 'no work item: no issue, no dispatch' });
  else if (!item.key || !item.trackerId) {
    add({ id: 'issue', label: 'Issue exists', status: 'fail', message: item.sync.status === 'dry_run' ? 'tracker is not live yet; issue not created in the tracker' : 'issue is not confirmed in the tracker yet' });
  } else if (item.state === 'verified' || item.state === 'canceled') {
    add({ id: 'issue', label: 'Issue exists', status: 'fail', message: `${item.key} is ${item.state}` });
  } else add({ id: 'issue', label: 'Issue exists', status: 'pass', message: `${item.key} is in the tracker` });

  if (!agent) {
    add({ id: 'agent', label: 'Agent', status: 'fail', message: `unknown agent ${assignment.agentId}` });
    return finish(checks, null, i.now);
  }

  if (agent.config.mode === 'coordinator-only') {
    const coordination = item?.labels.some((l) => COORDINATION_LABELS.includes(l.toLowerCase())) ?? false;
    add(coordination ? { id: 'coordinator', label: 'Coordinator-only', status: 'pass', message: 'coordination work' } : { id: 'coordinator', label: 'Coordinator-only', status: 'fail', message: `${agent.config.name} is coordinator-only; give code work to an engineer to save its usage` });
  }
  if(agent.config.enabled === false) add({id:'enabled',label:'Agent enabled',status:'fail',message:'This agent is a saved draft. Enable it in the agent builder before dispatch.'});

  let model: string | null = null;
  if (relay) {
    add({ id: 'relay', label: 'Relay agent', status: 'pass', message: 'the human pastes the prompt; auth, billing and model are checked in the vendor app' });
  } else {
    add(
      agent.auth.state === 'logged_in'
        ? { id: 'auth', label: 'Signed in', status: 'pass', message: agent.auth.detail ?? 'logged in' }
        : agent.auth.state === 'unknown'
          ? { id: 'auth', label: 'Signed in', status: 'warn', message: 'login state unknown; re-probe the agent', fix: { kind: 'reprobe' } }
          : { id: 'auth', label: 'Signed in', status: 'fail', message: `${agent.auth.state.replace('_', ' ')}${agent.auth.fix ? `: ${agent.auth.fix}` : ''}` },
    );

    const b = agent.billing;
    if (agent.config.billing === 'local' || b.mode === 'local') add({ id: 'billing', label: 'Billing', status: 'pass', message: `local model (${agent.config.provider}): runs on this machine, no cost` });
    else if (agent.config.metered_opt_in) {
      const cap = agent.config.budget_usd_per_day;
      const spent = i.spentTodayUsd ?? 0;
      add({ id: 'billing', label: 'Billing', status: 'warn', message: `metered (${agent.config.provider}), opted in: this run costs money${cap ? `; $${spent.toFixed(2)} of $${cap.toFixed(2)} spent today` : '; no daily cap set'}` });
      if (cap !== undefined && spent >= cap) add({ id: 'budget', label: 'Daily budget', status: 'fail', message: `$${spent.toFixed(2)} spent today reaches the $${cap.toFixed(2)} cap for ${agent.config.name}` });
    }
    else if (b.mode === 'metered') add({ id: 'billing', label: 'Billing', status: 'fail', message: `detected metered billing (${b.source}); zero extra spend blocks dispatch` });
    else if (b.mode === 'subscription') {
      const confirmed = b.overage === 'off' || (b.overage === 'unknown' && i.subscriptionConfirmation?.valid);
      add({ id: 'billing', label: 'Billing', status: confirmed ? 'pass' : 'fail', message: b.overage === 'on' ? 'paid overage is on; turn it off or opt in' : b.overage === 'unknown' ? i.subscriptionConfirmation?.message ?? 'The CLI cannot verify paid settings. Confirm overage, purchased credits and auto-recharge are off in Agents & subscriptions before dispatch.' : `included subscription usage (${b.source}); paid overage off` });
    }
    else add({ id: 'billing', label: 'Billing', status: 'fail', message: 'billing mode is unknown; dispatch requires a confirmed subscription or explicit per-agent paid opt-in' });

    if (agent.limitedUntil || agent.usage.status==='limited' || agent.usage.windows.some(w=>w.usedPercent!==null && w.usedPercent>=100)) add({ id: 'usage', label: 'Usage', status: 'fail', message: `usage limit reached${agent.limitedUntil && agent.limitedUntil !== 'unknown' ? ` until ${agent.limitedUntil}` : ''}` });
    else add({ id: 'usage', label: 'Usage', status: agent.usage.status === 'near_limit' ? 'warn' : 'pass', message: agent.usage.status === 'unknown' ? 'included usage not exposed by vendor' : `usage ${agent.usage.status}` });

    const resolved = assignment.model ? { model: assignment.model, blocked: null } : resolveModel(agent, policies);
    model = resolved.model;
    const opts = pickOptions(agent, policies);
    if (!model && resolved.blocked) add({ id: 'model', label: 'Model', status: 'fail', message: resolved.blocked, fix: { kind: 'text', text: 'Choose a model family or literal model for this agent in the builder.' } });
    else if (!model) add({ id: 'model', label: 'Model', status: 'fail', message: 'no eligible model found; re-probe or set model in config', fix: { kind: 'reprobe' } });
    else {
      const denied = matchesAny(model, policies.denied_models);
      const allowList = agent.config.allowed_models ?? policies.allowed_models;
      const notAllowed = allowList && allowList.length > 0 && !matchesAny(model, allowList);
      if (denied || notAllowed) add({ id: 'model', label: 'Model allowed', status: 'fail', message: `${model} is ${denied ? 'denied by policy' : 'not in the allowed list'}` });
      else add({ id: 'model', label: 'Model allowed', status: 'pass', message: model });

      const info = agent.models.available.find((m) => m.id === model);
      if (agent.config.adapter === 'opencode-server' && agent.config.provider === 'lmstudio') add({ id: 'tools', label: 'Tool calling', status: 'fail', message: 'LM Studio tool capabilities are unverified for OpenCode; no coding prompt can run.' });
      if ((agent.config.provider === 'ollama' || agent.config.provider === 'ollama-cloud') && (!info || info.hidden || info.tools !== true)) add({ id: 'tools', label: 'Tool calling', status: 'fail', message: 'Ollama model, route, authentication or tool support is unverified; re-probe.' });
      if (info?.tools === false) add({ id: 'tools', label: 'Tool calling', status: 'fail', message: `${model} cannot call tools, so it cannot edit files or run commands as a coding agent; choose a model with tool calling`, fix: { kind: 'text', text: 'Pick a model marked as supporting tools (the provider reports this).' } });
      if (agent.models.available.length === 0) {
        add({ id: 'newest', label: 'Newest model', status: 'warn', message: 'no model inventory; re-probe to verify', fix: { kind: 'reprobe' } });
      } else {
        // Only models of the same line are comparable; a different line is a choice, not staleness.
        const line = modelFamilyKey(model);
        const sameLine = eligibleModels(agent.models.available, { ...opts, family: undefined }).filter((m) => modelFamilyKey(m.id) === line);
        const n = isNewest(model, sameLine, { effort: opts.effort, allowFast: true });
        if (sameLine.length === 0) add({ id: 'newest', label: 'Newest model', status: 'warn', message: `${model} is not in ${agent.config.name}'s model list; can't compare versions`, fix: { kind: 'reprobe' } });
        else if (n.newest) add({ id: 'newest', label: 'Newest model', status: 'pass', message: `${model} is the newest eligible ${line} model` });
        else add({ id: 'newest', label: 'Newest model', status: policies.newest_model_rule ? 'fail' : 'warn', message: `${n.best} is newer than ${model}`, fix: n.best ? { kind: 'use_model', model: n.best } : undefined });
      }

      const cat = workCategory(item?.labels ?? [], i.project.categories);
      const floor = policies.quality_floor[cat];
      const q = checkQualityFloor(model, assignment.effort ?? agent.config.effort ?? null, floor, policies.model_classes ?? undefined);
      add({ id: 'quality', label: `Quality floor (${cat})`, status: q.status, message: q.message });
    }
    if (i.binaryCheck) add({ id: 'binary', label: 'Pinned binary', ...i.binaryCheck });
    if (i.providerCheck) add({ id: 'provider', label: `Provider (${agent.config.provider})`, ...i.providerCheck });
  }

  // Reviewers are read-only (their hook only admits review notes), so they never compete for paths.
  const overlaps = assignment.kind === 'review' ? [] : i.activeAssignments.filter((o) => o.id !== assignment.id && o.kind !== 'review' && scopesOverlap(o.allowedPaths, assignment.allowedPaths));
  add(
    overlaps.length === 0
      ? { id: 'paths', label: 'Path overlap', status: 'pass', message: 'no overlap with active assignments' }
      : { id: 'paths', label: 'Path overlap', status: 'fail', message: `overlaps ${overlaps.map((o) => `${o.agentId}:${o.allowedPaths.join(',') || '(whole repo)'}`).join('; ')}; narrow allowed paths or queue it` },
  );

  const secrets = containsSecret(assignment.prompt, { denylist: i.denylist });
  add(secrets.length === 0 ? { id: 'secrets', label: 'No secrets in prompt', status: 'pass', message: 'clean' } : { id: 'secrets', label: 'No secrets in prompt', status: 'fail', message: `prompt contains ${secrets.join(', ')}` });

  return finish(checks, model, i.now);
}

function finish(checks: PreflightCheck[], model: string | null, at: string): PreflightResult {
  return { ok: checks.every((c) => c.status !== 'fail'), checks, model, at };
}
