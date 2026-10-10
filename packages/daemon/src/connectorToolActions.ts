// SPDX-License-Identifier: Apache-2.0
// Per-call MCP tool approvals. Connection activation makes a command/tool inventory eligible only;
// each invocation needs its own human Decision bound to exact validated arguments before any process starts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { containsSecret, HUMAN, isActiveRun, newId, type Actor, type Connector, type EventEnvelope } from '@acc/core';
import { CommandError, type Daemon } from './daemon.ts';
import type { AnswerOptions } from './decisions.ts';
import type { Connectors } from './connectors.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const utf8Bytes = (s: string) => Buffer.byteLength(s, 'utf8');

const TOOL_CALL_TTL_MS = 15 * 60_000;
const TOOL_OUTPUT_LIMIT = 32_000;
const MAX_ARGS_BYTES = 16_384;
const MAX_ARGS_DEPTH = 16;
const REQUEST_PREFIX = 'connector-tool-req:';
const BINDING_PREFIX = 'connector-tool:';

export type ConnectorToolStatus = 'pending' | 'running' | 'succeeded' | 'error' | 'uncertain' | 'denied' | 'expired' | 'invalidated';

export interface ConnectorToolRequest {
  id: string;
  connectorId: string;
  tool: string;
  status: ConnectorToolStatus;
  decisionId: string | null;
  configHash: string;
  argumentsHash: string;
  runId: string | null;
  assignmentId: string | null;
  workItemId: string | null;
  requesterType: Actor['type'];
  requesterId: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  result: { text: string; isError: boolean; truncated: boolean } | null;
  error: string | null;
}

interface ToolCallBinding {
  requestId: string;
  connectorId: string;
  configHash: string;
  projectHash: string;
  activationDecisionId: string;
  tool: string;
  argumentsCanonical: string;
  argumentsHash: string;
  command: string;
  argv: string[];
  readRoots: string[];
  runId: string | null;
  assignmentId: string | null;
  workItemId: string | null;
  requesterType: Actor['type'];
  requesterId: string;
  expires: number;
  consumed: boolean;
}

type Revalidate = () => Connector;

interface OwnedInvocation {
  runId: string | null;
  client: Client | null;
  transport: StdioClientTransport | null;
  cancelled: boolean;
  interruption: Promise<never>;
  cancel: () => void;
  done: Promise<void>;
  finish: () => void;
  closing?: Promise<void>;
}

export class ConnectorToolActions {
  readonly connectors: Connectors;
  /** Test hook: awaited before and after each MCP await during execution. */
  connectGate: (() => Promise<void>) | null = null;
  private resolving = new Set<string>();
  private inflight = new Set<string>();
  private active = new Map<string, OwnedInvocation>();
  private stoppedRuns = new Set<string>();
  private closing = false;
  private onEvents = (events: EventEnvelope[]) => {
    for (const event of events) {
      const run = event.runId ? this.d.state.runs[event.runId] : null;
      if (run && event.runId && (event.type === 'run.ended' || event.type === 'run.state') && !isActiveRun(run)) {
        void this.stopRun(event.runId).catch(() => undefined);
      }
    }
  };

  constructor(connectors: Connectors) {
    this.connectors = connectors;
    this.recoverInterrupted();
    this.d.bus.on('events', this.onEvents);
  }

  private get d(): Daemon {
    return this.connectors.d;
  }

  private kvRequest(id: string, req: ConnectorToolRequest): void {
    this.d.store.kvSet(`${REQUEST_PREFIX}${id}`, JSON.stringify(req));
  }

  private loadRequest(id: string): ConnectorToolRequest {
    const raw = this.d.store.kvGet(`${REQUEST_PREFIX}${id}`);
    if (!raw) throw new CommandError('Unknown tool request', 404);
    return JSON.parse(raw) as ConnectorToolRequest;
  }

  private saveBinding(decisionId: string, binding: ToolCallBinding): void {
    this.d.store.kvSet(`${BINDING_PREFIX}${decisionId}`, JSON.stringify(binding));
  }

  private loadBinding(decisionId: string): ToolCallBinding {
    const raw = this.d.store.kvGet(`${BINDING_PREFIX}${decisionId}`);
    if (!raw) throw new CommandError('Approval missing or already used', 409);
    return JSON.parse(raw) as ToolCallBinding;
  }

  private projectHash(): string {
    const project = this.d.config.project;
    const settingsDecisionId = Object.values(this.d.state.decisions).filter(decision => decision.kind === 'settings' && decision.answer === 'save' && decision.answeredAt).at(-1)?.id ?? null;
    return sha(stable({ projectRepo: path.resolve(project.repo), projectName: project.name, tracker: this.d.config.tracker, settingsDecisionId }));
  }

  /** Read descriptors, never getters/toJSON, and bound bytes while serializing (including DAGs). */
  private canonicalArguments(args: unknown): string {
    const invalid = () => new CommandError('Tool arguments must be valid JSON', 400);
    if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new CommandError('Tool arguments must be a JSON object', 400);
    const ancestors = new WeakSet<object>();
    const parts: string[] = [];
    let bytes = 0;
    const append = (part: string) => {
      bytes += utf8Bytes(part);
      if (bytes > MAX_ARGS_BYTES) throw new CommandError('Tool arguments are too large', 400);
      parts.push(part);
    };
    const visit = (value: unknown, depth: number): void => {
      if (depth > MAX_ARGS_DEPTH) throw new CommandError('Tool arguments are too deeply nested', 400);
      if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
        if (typeof value === 'number' && !Number.isFinite(value)) throw invalid();
        if (typeof value === 'string' && utf8Bytes(value) > MAX_ARGS_BYTES) throw new CommandError('Tool arguments are too large', 400);
        append(JSON.stringify(value));
        return;
      }
      if (typeof value !== 'object' || types.isProxy(value)) throw invalid();
      const array = Array.isArray(value);
      const proto = Object.getPrototypeOf(value);
      if (array ? proto !== Array.prototype : proto !== null && proto !== Object.prototype) throw invalid();
      if (ancestors.has(value)) throw invalid();
      ancestors.add(value);
      const keys = Reflect.ownKeys(value);
      if (keys.length > MAX_ARGS_BYTES) throw new CommandError('Tool arguments are too large', 400);
      if (keys.some(key => typeof key !== 'string')) throw invalid();
      if (array) {
        const length = Object.getOwnPropertyDescriptor(value, 'length')!.value as number;
        if (length > MAX_ARGS_BYTES) throw new CommandError('Tool arguments are too large', 400);
        // Sparse arrays, custom properties and exotic array descriptors are not JSON.
        if (keys.length !== length + 1) throw invalid();
        append('[');
        for (let i = 0; i < length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw invalid();
          if (i) append(',');
          visit(descriptor.value, depth + 1);
        }
        append(']');
      } else {
        append('{');
        for (const [i, key] of (keys as string[]).sort((a, b) => a.localeCompare(b)).entries()) {
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new CommandError('Tool arguments contain unsafe keys', 400);
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
          if (!descriptor.enumerable || !('value' in descriptor)) throw invalid();
          if (i) append(',');
          if (utf8Bytes(key) > MAX_ARGS_BYTES) throw new CommandError('Tool arguments are too large', 400);
          append(JSON.stringify(key));
          append(':');
          visit(descriptor.value, depth + 1);
        }
        append('}');
      }
      ancestors.delete(value);
    };
    visit(args, 0);
    return parts.join('');
  }

  validateArguments(args: unknown): Record<string, unknown> {
    let canonical: string;
    try { canonical = this.canonicalArguments(args); } catch (error) {
      if (error instanceof CommandError) throw error;
      throw new CommandError('Tool arguments must be valid JSON', 400);
    }
    if (containsSecret(canonical, { denylist: this.d.denylist() }).length) throw new CommandError('Tool arguments contain a credential', 400);
    return JSON.parse(canonical) as Record<string, unknown>;
  }

  private actionHash(binding: ToolCallBinding): string {
    // Mutable consumption state is the only field excluded from the immutable action.
    const { consumed: _consumed, ...action } = binding;
    return sha(stable(action));
  }

  private assertRequester(binding: Pick<ToolCallBinding, 'runId' | 'assignmentId' | 'workItemId' | 'requesterId' | 'requesterType'>): void {
    if (binding.workItemId && !this.d.state.workItems[binding.workItemId]) throw new CommandError('The requesting issue is missing.', 409);
    if (binding.requesterType === 'human' && binding.requesterId === HUMAN.id && !binding.runId && !binding.assignmentId) return;
    if (binding.requesterType !== 'agent' || !binding.runId || !binding.assignmentId) throw new CommandError('Invalid tool requester', 403);
    const run = this.d.state.runs[binding.runId];
    const assignment = this.d.state.assignments[binding.assignmentId];
    const agent = this.d.state.agents[binding.requesterId];
    if (!run || !isActiveRun(run) || run.endedAt || this.stoppedRuns.has(run.id)) throw new CommandError('The requesting run ended or expired.', 409);
    if (!agent || agent.config.enabled === false || run.id !== binding.runId || run.agentId !== binding.requesterId || run.assignmentId !== binding.assignmentId || run.workItemId !== binding.workItemId || !assignment || assignment.id !== binding.assignmentId || assignment.agentId !== run.agentId || assignment.workItemId !== run.workItemId || ['done', 'canceled'].includes(assignment.position)) {
      throw new CommandError('The requesting run, assignment or issue changed.', 409);
    }
  }

  /** Integrity is independent of mutable connector eligibility, so a stale action can be denied. */
  private assertImmutable(binding: ToolCallBinding, decisionId: string, req: ConnectorToolRequest): void {
    const decision = this.d.state.decisions[decisionId];
    const action = decision?.action;
    // Decision.expiresAt is also used by the shared confirmation projection; the immutable
    // action hash carries this request's expiry independently of the fresh nonce's shorter TTL.
    if (!action || action.kind !== 'connector_tool' || action.connectorId !== binding.connectorId || action.tool !== binding.tool || action.hash !== this.actionHash(binding) || decision.workItemId !== binding.workItemId) throw new CommandError('Approval binding does not match this request', 409);
    if (req.id !== binding.requestId || req.decisionId !== decisionId || req.connectorId !== binding.connectorId || req.configHash !== binding.configHash || req.tool !== binding.tool || req.argumentsHash !== binding.argumentsHash || req.runId !== binding.runId || req.assignmentId !== binding.assignmentId || req.workItemId !== binding.workItemId || req.requesterId !== binding.requesterId || req.requesterType !== binding.requesterType) throw new CommandError('Approval binding does not match this request', 409);
    if (sha(binding.argumentsCanonical) !== binding.argumentsHash) throw new CommandError('Arguments do not match this request', 409);
    try {
      if (this.canonicalArguments(JSON.parse(binding.argumentsCanonical)) !== binding.argumentsCanonical) throw new Error('noncanonical');
    } catch {
      throw new CommandError('Arguments do not match this request', 409);
    }
  }

  private recheckDenied(binding: ToolCallBinding): void {
    const blob = stable({ command: binding.command, argv: binding.argv, args: binding.argumentsCanonical });
    if (containsSecret(blob, { denylist: this.d.denylist() }).length) throw new CommandError('Tool arguments contain a credential', 400);
  }

  private requireInventory(id: string): Connector {
    const c = this.connectors.requireApproved(id, 'execute');
    if (c.config.kind !== 'mcp') throw new CommandError('Not a tool connection', 412);
    return c;
  }

  private assertBinding(binding: ToolCallBinding, decisionId: string): Connector {
    this.assertImmutable(binding, decisionId, this.loadRequest(binding.requestId));
    if (this.closing || this.d.closed) throw new CommandError('This project engine has stopped.', 409);
    if (this.d.state.killSwitch.engaged) throw new CommandError('The kill switch is engaged.', 409);
    if (binding.expires <= this.d.now().getTime()) throw new CommandError('Request expired', 409);
    this.assertRequester(binding);
    const c = this.connectors.revalidateToolBinding(binding);
    this.recheckDenied(binding);
    return c;
  }

  private question(c: Connector, tool: string, argsCanonical: string): string {
    if (c.config.kind !== 'mcp') throw new CommandError('Not a tool connection', 412);
    const cmd = [c.config.command, ...c.config.args].join(' ');
    const short = c.configHash.slice(0, 12);
    return `Run ${tool} on "${c.name}" with exactly these arguments?\n\nCommand: ${cmd}\nRead roots: ${c.config.read_roots.join(', ') || '(none)'}\nArguments: ${argsCanonical}\n\nThis may contact networks or change data outside One Connect. The program runs with your user permissions; roots and tool names are not a sandbox. (config ${short})`;
  }

  private presentRequest(req: ConnectorToolRequest): ConnectorToolRequest {
    const redact = (text: string) => this.d.redactText(text);
    return {
      ...req,
      error: req.error ? redact(req.error) : null,
      result: req.result ? { ...req.result, text: redact(req.result.text) } : null,
    };
  }

  /** Running or consumed-but-unfinished requests become uncertain after restart; never replay. */
  recoverInterrupted(): void {
    for (const key of this.d.store.kvKeys(REQUEST_PREFIX)) {
      const raw = this.d.store.kvGet(key);
      if (!raw) continue;
      const req = JSON.parse(raw) as ConnectorToolRequest;
      const bindingRaw = req.decisionId ? this.d.store.kvGet(`${BINDING_PREFIX}${req.decisionId}`) : null;
      const consumed = bindingRaw ? (JSON.parse(bindingRaw) as ToolCallBinding).consumed : false;
      // A saved preview survives restart, but its previous confirmation step does not.
      if (!consumed && req.decisionId) this.d.store.kvDelete(`decision-confirm:${req.decisionId}`);
      if (req.status !== 'running' && !(req.status === 'pending' && consumed)) continue;
      this.kvRequest(req.id, {
        ...req,
        status: 'uncertain',
        endedAt: this.d.nowIso(),
        error: 'Interrupted before completion. Inspect manually; it was not run again.',
      });
    }
  }

  request(id: string, tool: string, args: unknown, o: { runId?: string | null; workItemId?: string | null; requester?: Actor; timeoutMs?: number } = {}) {
    const validated = this.validateArguments(args);
    const c = this.requireInventory(id);
    if (c.config.kind !== 'mcp') throw new CommandError('Not a tool connection', 412);
    const cfg = c.config;
    if (!cfg.tools.includes(tool)) throw new CommandError(`${tool} is not one of the approved tools (${cfg.tools.join(', ')})`, 403);
    const activationDecisionId = c.approvals.execute!.decisionId;
    const argumentsCanonical = stable(validated);
    const argumentsHash = sha(argumentsCanonical);
    const requestId = newId('toolreq');
    const now = this.d.nowIso();
    const expires = this.d.now().getTime() + TOOL_CALL_TTL_MS;
    const binding: ToolCallBinding = {
      requestId,
      connectorId: id,
      configHash: c.configHash,
      projectHash: this.projectHash(),
      activationDecisionId,
      tool,
      argumentsCanonical,
      argumentsHash,
      command: cfg.command,
      argv: cfg.args,
      readRoots: cfg.read_roots,
      runId: o.runId ?? null,
      assignmentId: o.runId ? this.d.state.runs[o.runId]?.assignmentId ?? null : null,
      requesterType: (o.requester ?? HUMAN).type,
      workItemId: o.workItemId ?? null,
      requesterId: (o.requester ?? HUMAN).id,
      expires,
      consumed: false,
    };
    this.assertRequester(binding);
    this.recheckDenied(binding);
    if (this.closing || this.d.closed || this.d.state.killSwitch.engaged) throw new CommandError('This project engine is stopped or kill-switched.', 409);
    const actionHash = this.actionHash(binding);
    const decisionInput = {
      question: this.question(c, tool, argumentsCanonical),
      options: ['approve', 'deny'],
      recommendation: null,
      evidenceLinks: [],
      urgency: 'high' as const,
      irreversible: true,
      kind: 'connector' as const,
      workItemId: o.workItemId ?? null,
      risk: 'high' as const,
      action: { kind: 'connector_tool' as const, connectorId: id, tool, hash: actionHash },
      confirmOptions: ['approve'],
      expiresAt: new Date(expires).toISOString(),
      evidence: [
        { label: 'Request ID', detail: requestId },
        { label: 'Requester', detail: `${binding.requesterType}:${binding.requesterId}` },
        { label: 'Requesting run', detail: binding.runId ?? '(human request)' },
        { label: 'Assignment', detail: binding.assignmentId ?? '(none)' },
        { label: 'Issue', detail: binding.workItemId ?? '(none)' },
        { label: 'Request expires', detail: new Date(expires).toISOString() },
        { label: 'Configuration hash', detail: binding.configHash },
        { label: 'Command', detail: [cfg.command, ...cfg.args].join(' ') },
        { label: 'Read roots', detail: cfg.read_roots.join('\n') || '(none)' },
        { label: 'Tool', detail: tool },
        { label: 'Arguments (exact)', detail: argumentsCanonical },
        { label: 'Unmediated program warning', detail: 'This local program can access networks and files outside the listed roots. One Connect does not sandbox it.' },
      ],
    };
    const request: ConnectorToolRequest = {
      id: requestId,
      connectorId: id,
      tool,
      status: 'pending',
      decisionId: null,
      configHash: c.configHash,
      argumentsHash,
      runId: binding.runId,
      assignmentId: binding.assignmentId,
      requesterType: binding.requesterType,
      workItemId: binding.workItemId,
      requesterId: binding.requesterId,
      createdAt: now,
      startedAt: null,
      endedAt: null,
      result: null,
      error: null,
    };
    const decision = this.d.decisions.createBound(decisionInput, o.requester ?? HUMAN, decisionId => [
      { type: 'connector.tool_requested', actor: o.requester ?? HUMAN, data: { requestId, connectorId: id, tool, decisionId, configHash: c.configHash, argumentsHash } },
    ], decisionId => {
      binding.requestId = requestId;
      request.decisionId = decisionId;
      this.saveBinding(decisionId, binding);
      this.kvRequest(requestId, request);
    });
    return { request, decision, pending: true as const };
  }

  get(requestId: string, o: { runId?: string | null; requester?: Actor } = {}): ConnectorToolRequest {
    let req = this.loadRequest(requestId);
    if (req.id !== requestId) throw new CommandError('Tool request identity changed', 409);
    if (o.runId) {
      if (req.runId !== o.runId) throw new CommandError('This tool request belongs to another run', 403);
      this.assertRequester(req);
      if (!req.decisionId) throw new CommandError('Approval binding missing', 409);
      this.assertImmutable(this.loadBinding(req.decisionId), req.decisionId, req);
      if (o.requester && (o.requester.type !== req.requesterType || o.requester.id !== req.requesterId)) throw new CommandError('This tool request belongs to another requester', 403);
    } else if ((o.requester ?? HUMAN).type !== 'human' || (o.requester ?? HUMAN).id !== HUMAN.id) {
      throw new CommandError('Only the human owner can read this tool request', 403);
    }
    if (req.status === 'pending') {
      try {
        if (!req.decisionId) throw new CommandError('Approval binding missing', 409);
        const binding = this.loadBinding(req.decisionId);
        this.assertBinding(binding, req.decisionId);
        if (binding.consumed || this.d.state.decisions[req.decisionId]?.answeredAt) throw new CommandError('Approval already consumed', 409);
      } catch (e) {
        const expired = e instanceof CommandError && e.message === 'Request expired';
        req = { ...req, status: expired ? 'expired' : 'invalidated', endedAt: this.d.nowIso(), error: expired ? 'Request expired' : 'Request no longer valid. Review and request again.' };
        this.kvRequest(requestId, req);
      }
    }
    const presented = this.presentRequest(req);
    if (JSON.stringify(presented) !== JSON.stringify(req)) this.kvRequest(requestId, presented);
    return presented;
  }

  async resolve(decisionId: string, answer: string, actor: Actor = HUMAN, o: AnswerOptions = {}) {
    if (actor.type !== 'human') throw new CommandError('Only a human can approve a tool call', 403);
    if (!['approve', 'deny'].includes(answer)) throw new CommandError('Choose approve or deny');
    if (this.resolving.has(decisionId)) throw new CommandError('Approval already being resolved', 409);
    this.resolving.add(decisionId);
    try {
      const binding = this.loadBinding(decisionId);
      const decision = this.d.state.decisions[decisionId];
      if (!decision || decision.answeredAt) throw new CommandError('Approval missing or already used', 409);
      const req = this.loadRequest(binding.requestId);
      if (binding.consumed || !['pending', 'expired', 'invalidated'].includes(req.status)) throw new CommandError('Approval missing or already used', 409);
      this.assertImmutable(binding, decisionId, req);
      if (answer === 'deny') {
        this.d.decisions.answerAtomic(decisionId, answer, { channel: 'dashboard', ...o }, actor, [
          { type: 'connector.tool_denied', actor, data: { requestId: binding.requestId, connectorId: binding.connectorId, tool: binding.tool, decisionId } },
        ], () => {
          this.saveBinding(decisionId, { ...binding, consumed: true });
          this.markRequest(binding.requestId, { status: 'denied', endedAt: this.d.nowIso(), error: 'Denied by owner' });
        });
        return { request: this.presentRequest(this.loadRequest(binding.requestId)), executed: false };
      }
      try {
        this.assertBinding(binding, decisionId);
        if (req.status !== 'pending') throw new CommandError('Request no longer valid. Review and request again.', 409);
      } catch (e) {
        this.markRequest(binding.requestId, { status: e instanceof CommandError && e.message === 'Request expired' ? 'expired' : 'invalidated', error: e instanceof CommandError && e.message === 'Request expired' ? 'Request expired' : 'Request no longer valid. Review and request again.', endedAt: this.d.nowIso() });
        throw e;
      }
      this.d.decisions.validateAnswer(decisionId, answer, o, actor);
      if (this.inflight.has(binding.requestId)) throw new CommandError('This tool call is already executing', 409);
      this.inflight.add(binding.requestId);
      let executed = false;
      let owned: OwnedInvocation | null = null;
      try {
        this.assertBinding(binding, decisionId);
        const startedAt = this.d.nowIso();
        this.d.decisions.answerAtomic(decisionId, answer, { channel: 'dashboard', ...o }, actor, [
          { type: 'connector.tool_execution_started', actor, data: { requestId: binding.requestId, connectorId: binding.connectorId, tool: binding.tool, decisionId } },
        ], () => {
          this.saveBinding(decisionId, { ...binding, consumed: true });
          this.kvRequest(binding.requestId, { ...req, status: 'running', startedAt });
        });
        executed = true;
        owned = this.ownInvocation(binding);
        let result = await this.execute(binding, () => this.assertBinding(binding, decisionId), owned);
        // Transport cleanup itself awaits the child exit. Authorization may change during it.
        if (!result.uncertain && result.invoked) {
          try {
            if (owned.cancelled) throw new CommandError('Owned plugin invocation stopped.', 409);
            this.assertBinding(binding, decisionId);
          } catch {
            result = { text: '', isError: true, truncated: false, invoked: true, uncertain: true, error: 'Tool invocation interrupted or authorization changed. Inspect manually; it was not run again.' };
          }
        }
        result.text = this.d.redactText(result.text);
        this.markRequest(binding.requestId, {
          status: result.uncertain ? 'uncertain' : result.isError ? 'error' : 'succeeded',
          endedAt: this.d.nowIso(),
          result: { text: result.text, isError: result.isError, truncated: result.truncated },
          error: result.error ?? null,
        });
        this.connectors.recordUse(this.d.state.connectors![binding.connectorId], 'execute', !result.isError && !result.uncertain, `${binding.tool}: ${result.text.length} chars`);
        this.d.commit([{ type: 'connector.tool_executed', actor, data: { requestId: binding.requestId, connectorId: binding.connectorId, tool: binding.tool, decisionId, ok: !result.isError && !result.uncertain } }]);
        return { request: this.presentRequest(this.loadRequest(binding.requestId)), executed: true, result };
      } catch (e) {
        if (executed) {
          this.markRequest(binding.requestId, { status: 'uncertain', endedAt: this.d.nowIso(), error: 'Execution was interrupted. Inspect manually; it was not run again.' });
        }
        throw e;
      } finally {
        this.inflight.delete(binding.requestId);
        this.active.delete(binding.requestId);
        owned?.finish();
      }
    } finally {
      this.resolving.delete(decisionId);
    }
  }

  private markRequest(id: string, patch: Partial<ConnectorToolRequest>): void {
    const req = this.loadRequest(id);
    this.kvRequest(id, { ...req, ...patch });
  }

  private ownInvocation(binding: ToolCallBinding): OwnedInvocation {
    let reject!: (error: Error) => void;
    let finish!: () => void;
    const interruption = new Promise<never>((_, fail) => { reject = fail; });
    // Cancellation can arrive between protocol awaits.
    void interruption.catch(() => undefined);
    const owned: OwnedInvocation = {
      runId: binding.runId, client: null, transport: null, cancelled: false, interruption,
      done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish(),
      cancel: () => {
        if (owned.cancelled) return;
        owned.cancelled = true;
        reject(new CommandError('Owned plugin invocation stopped.', 409));
      },
    };
    this.active.set(binding.requestId, owned);
    return owned;
  }

  private closeTransport(owned: OwnedInvocation): Promise<void> {
    return owned.closing ??= (async () => {
      // These handles belong to this exact call; the SDK closes only its own child process.
      if (owned.client) await owned.client.close().catch(() => undefined);
      if (owned.transport) await owned.transport.close().catch(() => undefined);
    })();
  }

  private async stopOwned(owned: OwnedInvocation[]): Promise<void> {
    for (const call of owned) call.cancel();
    await Promise.all(owned.map(async call => {
      await this.closeTransport(call);
      await call.done;
    }));
  }

  /** Called before asking the requesting agent runner to stop; other runs stay live. */
  async stopRun(runId: string): Promise<void> {
    this.stoppedRuns.add(runId);
    await this.stopOwned([...this.active.values()].filter(call => call.runId === runId));
  }

  async stopAll(): Promise<void> {
    await this.stopOwned([...this.active.values()]);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.d.bus.off('events', this.onEvents);
    await this.stopAll();
  }

  private async execute(binding: ToolCallBinding, revalidate: Revalidate, owned: OwnedInvocation): Promise<{ text: string; isError: boolean; truncated: boolean; invoked: boolean; uncertain?: boolean; error?: string }> {
    let invocationStarted = false;
    const check = () => {
      if (owned.cancelled) throw new CommandError('Owned plugin invocation stopped.', 409);
      return revalidate();
    };
    const gate = async () => {
      await Promise.race([Promise.resolve(this.connectGate?.()), owned.interruption]);
      check();
    };
    try {
      const c = check();
      if (c.config.kind !== 'mcp') throw new CommandError('Not a tool connection', 412);
      const cfg = c.config;
      const home = path.join(this.d.paths.root, 'connectors', c.id);
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      const cwd = cfg.read_roots.find(r => fs.existsSync(r) && fs.statSync(r).isDirectory()) ?? home;
      const transport = owned.transport = new StdioClientTransport({ command: cfg.command, args: cfg.args, cwd, stderr: 'pipe', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: os.tmpdir(), LANG: 'C.UTF-8' } });
      const client = owned.client = new Client({ name: 'one-connect', version: '0.1.0' }, { capabilities: { roots: { listChanged: false } } });
      client.setRequestHandler(ListRootsRequestSchema, async () => {
        check();
        return { roots: cfg.read_roots.map(r => ({ uri: `file://${r}`, name: path.basename(r) })) };
      });
      const timeout = 20_000;
      await gate();
      await Promise.race([client.connect(transport, { timeout }), owned.interruption]);
      await gate();
      const listed = await Promise.race([client.listTools(undefined, { timeout }), owned.interruption]);
      await gate();
      if (!listed.tools.some(t => t.name === binding.tool)) throw new CommandError('The server does not offer the reviewed tool', 404);
      await gate();
      const argumentsValue = JSON.parse(binding.argumentsCanonical);
      // No await or test gate between this flag and the actual call.
      invocationStarted = true;
      const r = await Promise.race([client.callTool({ name: binding.tool, arguments: argumentsValue }, undefined, { timeout }), owned.interruption]);
      // A response may arrive after revocation/expiry/stop or after new denylist entries.
      await gate();
      const content = (Array.isArray(r.content) ? r.content : []) as { type: string; text?: string }[];
      const text = content.map(x => (x.type === 'text' ? x.text ?? '' : `[${x.type} omitted]`)).join('\n');
      const out = this.d.redactText(text);
      return { text: out.slice(0, TOOL_OUTPUT_LIMIT), isError: Boolean(r.isError), truncated: out.length > TOOL_OUTPUT_LIMIT, invoked: true };
    } catch {
      // Arbitrary server errors can contain arguments/credentials. Persist a bounded generic error.
      return { text: '', isError: true, truncated: false, invoked: invocationStarted, uncertain: invocationStarted, error: invocationStarted ? 'Tool invocation interrupted or authorization changed. Its outcome is uncertain; inspect manually before making a new request.' : 'Tool execution stopped before invocation.' };
    } finally {
      await this.closeTransport(owned);
    }
  }
}
