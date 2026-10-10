// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { agentActor, HUMAN, SYSTEM, type Run } from '@acc/core';
import { makeConfig, makeRepo, startDaemon, tmpDir, waitFor, type Harness } from './helpers.ts';

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const tokenOf = (d: Harness['d'], runId: string) => [...(d.runs as unknown as { tokens: Map<string, string> }).tokens.entries()].find(([, id]) => id === runId)?.[0];

let h: Harness | null = null;
afterEach(async () => { await h?.close(); h = null; });

async function approve(d: Harness['d'], decisionId: string) {
  const prep = d.decisions.prepare(decisionId, 'approve');
  const response = await d.decisions.respond(decisionId, 'approve', { nonce: prep.nonce }, HUMAN);
  return response;
}

async function approveInventory(d: Harness['d']) {
  const inv = d.connectors.requestActivation('tools', 'execute').decision!;
  const prep = d.decisions.prepare(inv.id, 'approve');
  await d.connectors.resolve(inv.id, 'approve', HUMAN, { nonce: prep.nonce });
}

async function setupMcp(marker?: string, tools: string[] = ['echo']) {
  const root = fs.realpathSync(tmpDir('root'));
  const log = marker ?? path.join(tmpDir('mcp'), 'starts.log');
  const config = { kind: 'mcp' as const, command: process.execPath, args: [path.join(FIX, 'fake-mcp-tools.mjs'), log], tools, read_roots: [root] };
  h = await startDaemon(makeConfig(makeRepo()), { probe: false, server: false });
  const d = h.d;
  d.connectors.save({ id: 'tools', name: 'Local tools', config }, null);
  await approveInventory(d);
  return { d, log, root, config };
}

function calledLines(log: string, name = 'echo') {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(l => l === `called:${name}`) : [];
}

function createRun(d: Harness['d'], agentId = 'cursor'): Run {
  const item = d.createIssue({ title: 'Connector run', acceptance: ['done'] });
  const assignment = d.createAssignment({ workItemId: item.id, agentId, allowedPaths: ['**'] });
  const runId = `run_${assignment.id}`;
  const run: Run = {
    id: runId, assignmentId: assignment.id, workItemId: item.id, agentId, adapter: 'relay', model: 'newest', resolvedModel: null,
    effort: 'high', attempt: 1, retryOf: null, pid: null, sessionId: null, state: 'running', createdAt: d.nowIso(), startedAt: d.nowIso(), endedAt: null,
    lastEventAt: null, lastMeaningful: null, eventCount: 0, usage: { inputTokens: 0, outputTokens: 0 }, exit: null, handoff: null, filesChanged: [],
    outOfScope: [], tests: null, logDir: '',
  };
  d.commit([{ type: 'run.created', actor: HUMAN, runId, agentId, workItemId: item.id, assignmentId: assignment.id, data: { run } }]);
  return d.state.runs[runId];
}

function fixturePid(log: string): number | null {
  const matches = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').match(/^pid:(\d+)$/gm) : null;
  return matches ? Number(matches.at(-1)!.slice(4)) : null;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function expectFixtureExit(log: string) {
  const pid = fixturePid(log);
  expect(pid).not.toBeNull();
  await waitFor(() => !alive(pid!), 10_000, 'owned fixture child exit');
}

describe('connector tool per-call approvals', () => {
  it('does not start the MCP server before exact human confirmation', async () => {
    const log = path.join(tmpDir('mcp'), 'starts.log');
    const { d } = await setupMcp(log);
    const req = d.connectors.requestToolCall('tools', 'echo', { text: 'hi' });
    expect(fs.existsSync(log)).toBe(false);
    await approve(d, req.decision.id);
    expect(fs.readFileSync(log, 'utf8')).toContain('called:echo');
  }, 30_000);

  it('rejects edited connector configuration, disabled connectors and stale inventory without executing', async () => {
    const log = path.join(tmpDir('mcp'), 'starts.log');
    const { d, config } = await setupMcp(log);
    const req = d.connectors.requestToolCall('tools', 'echo', { text: 'first' });
    d.connectors.save({ id: 'tools', name: 'Local tools', config: { ...config, tools: ['echo', 'dump_env'] } }, d.state.connectors!.tools.configHash);
    await expect(approve(d, req.decision.id)).rejects.toThrow(/changed|inventory|binding/);
    expect(calledLines(log)).toHaveLength(0);

    const fresh = d.connectors.requestActivation('tools', 'execute');
    const prep = d.decisions.prepare(fresh.decision!.id, 'approve');
    await d.connectors.resolve(fresh.decision!.id, 'approve', HUMAN, { nonce: prep.nonce });
    const again = d.connectors.requestToolCall('tools', 'echo', { text: 'x' });
    d.connectors.setDisabled('tools', true);
    await expect(approve(d, again.decision.id)).rejects.toThrow(/disabled/);
    expect(calledLines(log)).toHaveLength(0);
  }, 30_000);

  it('rejects tampered argument bytes and changed arguments after approval', async () => {
    const log = path.join(tmpDir('mcp'), 'starts.log');
    const { d } = await setupMcp(log);
    const req = d.connectors.requestToolCall('tools', 'echo', { text: 'original' });
    const binding = JSON.parse(d.store.kvGet(`connector-tool:${req.decision.id}`)!);
    binding.argumentsCanonical = '{"text":"tampered"}';
    d.store.kvSet(`connector-tool:${req.decision.id}`, JSON.stringify(binding));
    await expect(approve(d, req.decision.id)).rejects.toThrow(/match|binding/);
    expect(calledLines(log)).toHaveLength(0);

    const fresh = d.connectors.requestToolCall('tools', 'echo', { text: 'approved-args' });
    const tampered = JSON.parse(d.store.kvGet(`connector-tool:${fresh.decision.id}`)!);
    tampered.argumentsCanonical = '{"text":"different"}';
    tampered.argumentsHash = createHash('sha256').update(tampered.argumentsCanonical).digest('hex');
    const alteredRequest = JSON.parse(d.store.kvGet(`connector-tool-req:${fresh.request.id}`)!);
    alteredRequest.argumentsHash = tampered.argumentsHash;
    d.store.kvSet(`connector-tool-req:${fresh.request.id}`, JSON.stringify(alteredRequest));
    d.store.kvSet(`connector-tool:${fresh.decision.id}`, JSON.stringify(tampered));
    await expect(approve(d, fresh.decision.id)).rejects.toThrow(/match|binding/);
    expect(calledLines(log)).toHaveLength(0);
  }, 30_000);

  it('prevents duplicate concurrent approvals from executing twice', async () => {
    const log = path.join(tmpDir('mcp'), 'starts.log');
    const { d } = await setupMcp(log);
    const req = d.connectors.requestToolCall('tools', 'echo', { text: 'once' });
    const prep = d.decisions.prepare(req.decision.id, 'approve');
    const results = await Promise.allSettled([
      d.connectors.resolveToolCall(req.decision.id, 'approve', HUMAN, { nonce: prep.nonce }),
      d.connectors.resolveToolCall(req.decision.id, 'approve', HUMAN, { nonce: prep.nonce }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(calledLines(log)).toHaveLength(1);
  }, 30_000);

  it('closes transport when revoked during delayed connect/listTools', async () => {
    const log = path.join(tmpDir('mcp'), 'starts.log');
    const { d } = await setupMcp(log);
    const req = d.connectors.requestToolCall('tools', 'echo', { text: 'late' });
    let gate = 0;
    d.connectors.toolActions.connectGate = async () => {
      gate++;
      if (gate === 2) d.connectors.setDisabled('tools', true);
    };
    const prep = d.decisions.prepare(req.decision.id, 'approve');
    await d.connectors.resolveToolCall(req.decision.id, 'approve', HUMAN, { nonce: prep.nonce });
    expect(d.connectors.getToolCallResult(req.request.id).status).toBe('error');
    await expectFixtureExit(log);
    expect(fs.readFileSync(log, 'utf8').split('\n').filter(l => l.startsWith('called:')).length).toBe(0);
    d.connectors.toolActions.connectGate = null;
  }, 30_000);

  it('keeps secrets out of visible request state and redacts tool output on every read', async () => {
    const { d } = await setupMcp();
    d.addSecret('a-runtime-secret-1234');
    expect(() => d.connectors.requestToolCall('tools', 'echo', { text: 'a-runtime-secret-1234' })).toThrow(/credential/);
    const req = d.connectors.requestToolCall('tools', 'echo', { text: 'safe-text' });
    expect(JSON.stringify(d.state.decisions[req.decision.id])).not.toContain('a-runtime-secret-1234');
    const redacted = d.connectors.requestToolCall('tools', 'echo', { text: 'leak-pattern' });
    await approve(d, redacted.decision.id);
    const out = d.connectors.getToolCallResult(redacted.request.id).result!.text;
    expect(out).toContain('[REDACTED');
    expect(out).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
    const later = d.connectors.requestToolCall('tools', 'echo', { text: 'post-read-secret-xyz' });
    await approve(d, later.decision.id);
    expect(d.connectors.getToolCallResult(later.request.id).result!.text).toContain('post-read-secret-xyz');
    d.addSecret('post-read-secret-xyz');
    expect(d.connectors.getToolCallResult(later.request.id).result!.text).not.toContain('post-read-secret-xyz');
    expect(d.store.kvGet(`connector-tool-req:${later.request.id}`)).not.toContain('post-read-secret-xyz');
    const reread = d.connectors.getToolCallResult(redacted.request.id).result!.text;
    expect(reread).toContain('[REDACTED');
    expect(reread).not.toContain('post-read-secret-xyz');
  }, 30_000);

  it('routes tool-call answers through the decisions respond path and rejects nonce-free approval', async () => {
    const log = path.join(tmpDir('mcp'), 'starts.log');
    const { d } = await setupMcp(log);
    const req = d.connectors.requestToolCall('tools', 'echo', { text: 'route' });
    await expect(d.connectors.resolveToolCall(req.decision.id, 'approve', HUMAN)).rejects.toThrow(/confirm/);
    expect(calledLines(log)).toHaveLength(0);
    const prep = d.decisions.prepare(req.decision.id, 'approve');
    await d.decisions.respond(req.decision.id, 'approve', { nonce: prep.nonce }, HUMAN);
    expect(d.connectors.getToolCallResult(req.request.id).status).toBe('succeeded');
    await expect(d.decisions.respond(req.decision.id, 'approve', { nonce: prep.nonce }, agentActor('codex'))).rejects.toMatchObject({ status: 403 });
    const generic = d.connectors.requestToolCall('tools', 'echo', { text: 'generic' });
    const nonce = d.decisions.prepare(generic.decision.id, 'approve').nonce;
    expect(() => d.decisions.answer(generic.decision.id, 'approve', { nonce }, HUMAN)).toThrow(/action executor/);
    await expect(d.decisions.respond(generic.decision.id, 'approve', { nonce }, SYSTEM)).rejects.toMatchObject({ status: 403 });
    await expect(d.decisions.respond(generic.decision.id, 'approve', { nonce }, { type: 'human', id: 'jev' })).rejects.toMatchObject({ status: 403 });
    expect(calledLines(log)).toHaveLength(1);
  }, 30_000);

  it('preserves pending requests across restart without replaying execution', async () => {
    const log = path.join(tmpDir('mcp'), 'starts.log');
    const repo = makeRepo();
    const cfg = makeConfig(repo);
    h = await startDaemon(cfg, { probe: false, server: false });
    const root = fs.realpathSync(tmpDir('root'));
    const config = { kind: 'mcp' as const, command: process.execPath, args: [path.join(FIX, 'fake-mcp-tools.mjs'), log], tools: ['echo'], read_roots: [root] };
    h.d.connectors.save({ id: 'tools', name: 'Local tools', config }, null);
    await approveInventory(h.d);
    const d = h.d;
    const req = d.connectors.requestToolCall('tools', 'echo', { text: 'survive' });
    const dataDir = h!.dataDir;
    const staleNonce = d.decisions.prepare(req.decision.id, 'approve').nonce;
    await h!.close(); h = null;
    h = await startDaemon(cfg, { probe: false, server: false, dataDir });
    await h.d.setKillSwitch(false);
    const pending = h.d.connectors.getToolCallResult(req.request.id);
    expect(pending.status).toBe('pending');
    expect(fs.existsSync(log)).toBe(false);
    await expect(h.d.decisions.respond(req.decision.id, 'approve', { nonce: staleNonce }, HUMAN)).rejects.toMatchObject({ status: 428 });
    if (!h.d.state.connectors!.tools.approvals.execute) await approveInventory(h.d);
    await approve(h.d, req.decision.id);
    expect(h.d.connectors.getToolCallResult(req.request.id).status).toBe('succeeded');
  }, 30_000);

  it('marks running requests uncertain after restart without replay', async () => {
    const log = path.join(tmpDir('mcp'), 'starts.log');
    const repo = makeRepo();
    const cfg = makeConfig(repo);
    const root = fs.realpathSync(tmpDir('root'));
    const config = { kind: 'mcp' as const, command: process.execPath, args: [path.join(FIX, 'fake-mcp-tools.mjs'), log], tools: ['echo'], read_roots: [root] };
    h = await startDaemon(cfg, { probe: false, server: false });
    h.d.connectors.save({ id: 'tools', name: 'Local tools', config }, null);
    await approveInventory(h.d);
    const req = h.d.connectors.requestToolCall('tools', 'echo', { text: 'running' });
    const prep = h.d.decisions.prepare(req.decision.id, 'approve');
    h.d.connectors.toolActions.connectGate = () => new Promise(() => {});
    const executing = h.d.connectors.resolveToolCall(req.decision.id, 'approve', HUMAN, { nonce: prep.nonce });
    await waitFor(() => h!.d.connectors.getToolCallResult(req.request.id).status === 'running', 10_000, 'running');
    // Copy the actual committed SQLite checkpoint while execution is suspended. Restart from
    // that crash image, rather than from graceful shutdown's finalized request state.
    const dataDir = tmpDir('crash-image');
    h.d.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(h.d.paths.db, path.join(dataDir, path.basename(h.d.paths.db)));
    const committedBinding = JSON.parse(h.d.store.kvGet(`connector-tool:${req.decision.id}`)!);
    expect(committedBinding.consumed).toBe(true);
    expect(h.d.state.decisions[req.decision.id].answeredBy).toEqual(HUMAN);
    expect(h.d.state.decisions[req.decision.id].answer).toBe('approve');
    expect(h.d.store.list({ types: ['connector.tool_execution_started'] })).toHaveLength(1);
    expect(fs.existsSync(log)).toBe(false);
    await h.close();
    await executing;
    h = null;
    h = await startDaemon(cfg, { probe: false, server: false, dataDir });
    const recovered = h.d.connectors.getToolCallResult(req.request.id);
    expect(recovered.status).toBe('uncertain');
    expect(calledLines(log)).toHaveLength(0);
    await expect(approve(h.d, req.decision.id)).rejects.toThrow(/already|used/);
  }, 30_000);

  it('denial and expiry cause zero fixture starts', async () => {
    const log = path.join(tmpDir('mcp'), 'starts.log');
    const { d } = await setupMcp(log);
    const denied = d.connectors.requestToolCall('tools', 'echo', { text: 'no' });
    const prep = d.decisions.prepare(denied.decision.id, 'deny');
    await d.connectors.resolveToolCall(denied.decision.id, 'deny', HUMAN, { nonce: prep.nonce });
    expect(d.connectors.getToolCallResult(denied.request.id).status).toBe('denied');
    expect(calledLines(log)).toHaveLength(0);

    const expired = d.connectors.requestToolCall('tools', 'echo', { text: 'old' });
    const future = new Date(d.now().getTime() + 16 * 60_000);
    d.opts.clock = () => future;
    expect(d.connectors.getToolCallResult(expired.request.id).status).toBe('expired');
    await expect(approve(d, expired.decision.id)).rejects.toThrow(/expired/);
    expect(calledLines(log)).toHaveLength(0);
  }, 30_000);

  it('rejects invalid JSON shapes, cycles, deep nesting and UTF-8 byte limits', async () => {
    const { d } = await setupMcp();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => d.connectors.requestToolCall('tools', 'echo', cyclic)).toThrow(/valid JSON/);
    expect(() => d.connectors.requestToolCall('tools', 'echo', { x: undefined })).toThrow(/valid JSON/);
    expect(() => d.connectors.requestToolCall('tools', 'echo', { n: Number.NaN })).toThrow(/valid JSON/);
    expect(() => d.connectors.requestToolCall('tools', 'echo', { d: new Date() })).toThrow(/valid JSON/);
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(() => d.connectors.requestToolCall('tools', 'echo', deep)).toThrow(/deeply nested/);
    const emoji = '😀'.repeat(5000);
    expect(() => d.connectors.requestToolCall('tools', 'echo', { text: emoji })).toThrow(/too large/);
  }, 30_000);

  it('blocks execution when denylist matches after request but before spawn', async () => {
    const log = path.join(tmpDir('mcp'), 'starts.log');
    const { d } = await setupMcp(log);
    const req = d.connectors.requestToolCall('tools', 'echo', { text: 'later-secret' });
    d.addSecret('later-secret');
    await expect(approve(d, req.decision.id)).rejects.toThrow(/credential/);
    expect(calledLines(log)).toHaveLength(0);
  }, 30_000);

  it('distinguishes tool errors from uncertain invocation loss', async () => {
    const log = path.join(tmpDir('mcp'), 'starts.log');
    const { d } = await setupMcp(log, ['echo', 'fail', 'drop']);
    const failReq = d.connectors.requestToolCall('tools', 'fail', {});
    await approve(d, failReq.decision.id);
    expect(d.connectors.getToolCallResult(failReq.request.id).status).toBe('error');
    expect(calledLines(log, 'fail')).toHaveLength(1);

    const loss = d.connectors.requestToolCall('tools', 'drop', {});
    await approve(d, loss.decision.id);
    const result = d.connectors.getToolCallResult(loss.request.id);
    expect(result.status).toBe('uncertain');
    expect(calledLines(log, 'drop')).toHaveLength(1);
    await expectFixtureExit(log);
    await expect(approve(d, loss.decision.id)).rejects.toThrow(/already|used/);
    expect(calledLines(log, 'drop')).toHaveLength(1);
  }, 30_000);

  it('scopes poll results to the requesting run and rejects ended runs at approval', async () => {
    const log = path.join(tmpDir('mcp'), 'starts.log');
    const { d } = await setupMcp(log);
    const run = createRun(d);
    const item = d.state.workItems[run.workItemId];
    const owned = d.connectors.requestToolCall('tools', 'echo', { text: 'mine' }, { runId: run.id, workItemId: item.id, requester: agentActor('cursor') });
    expect(() => d.connectors.getToolCallResult(owned.request.id, { runId: 'run_foreign' })).toThrow(/another run/);
    d.commit([{ type: 'run.ended', actor: HUMAN, runId: run.id, agentId: run.agentId, workItemId: run.workItemId, assignmentId: run.assignmentId, data: { exit: { kind: 'completed', message: 'test' } } }]);
    await expect(approve(d, owned.decision.id)).rejects.toThrow(/run ended/);
    expect(calledLines(log)).toHaveLength(0);
  }, 30_000);

  it('routes MCP tool requests and polls through authenticated run tokens', async () => {
    const log = path.join(tmpDir('mcp'), 'starts.log');
    const repo = makeRepo();
    const cfg = makeConfig(repo);
    h = await startDaemon(cfg, { probe: false });
    const d = h.d;
    const root = fs.realpathSync(tmpDir('root'));
    const config = { kind: 'mcp' as const, command: process.execPath, args: [path.join(FIX, 'fake-mcp-tools.mjs'), log], tools: ['echo'], read_roots: [root] };
    d.connectors.save({ id: 'tools', name: 'Local tools', config }, null);
    await approveInventory(d);
    const item = d.createIssue({ title: 'Connector run', description: '[fake:ask-human]', acceptance: ['done'] });
    const assignment = d.createAssignment({ workItemId: item.id, agentId: 'cursor', allowedPaths: ['src/**'] });
    await d.dispatch(assignment.id);
    const run = await waitFor(() => Object.values(d.state.runs).find(r => r.assignmentId === assignment.id)!, 20_000, 'run');
    const token = tokenOf(d, run.id)!;
    const created = await d.mcp.call(token, 'call_connector_tool', { connector: 'tools', tool: 'echo', arguments: { text: 'agent' } }) as { requestId: string; decisionId: string };
    await expect(d.mcp.call(token, 'get_connector_tool_result', { requestId: created.requestId })).resolves.toMatchObject({ status: 'pending' });
    await approve(d, created.decisionId);
    const result = await d.mcp.call(token, 'get_connector_tool_result', { requestId: created.requestId }) as { status: string };
    expect(result.status).toBe('succeeded');
    expect(calledLines(log)).toHaveLength(1);
    const otherItem = d.createIssue({ title: 'Other fixture run', description: '[fake:ask-human]', acceptance: ['done'] });
    const otherAssignment = d.createAssignment({ workItemId: otherItem.id, agentId: 'codex', allowedPaths: ['test/**'] });
    await d.dispatch(otherAssignment.id);
    const otherRun = await waitFor(() => Object.values(d.state.runs).find(r => r.assignmentId === otherAssignment.id)!, 20_000, 'other run');
    const otherToken = tokenOf(d, otherRun.id)!;
    await expect(d.mcp.call(otherToken, 'get_connector_tool_result', { requestId: created.requestId })).rejects.toMatchObject({ status: 403 });
    d.commit([{ type: 'assignment.updated', assignmentId: otherAssignment.id, data: { patch: { agentId: 'cursor' } } }]);
    await expect(d.mcp.call(otherToken, 'call_connector_tool', { connector: 'tools', tool: 'echo', arguments: { text: 'spoof' } })).rejects.toThrow(/changed/);
    await d.runs.stop(run.id, 'fixture stop');
    await waitFor(() => !d.runs.runForToken(token), 20_000, 'expired run token');
    await expect(d.mcp.call(token, 'get_connector_tool_result', { requestId: created.requestId })).rejects.toMatchObject({ status: 401 });
    await expect(d.mcp.call(token, 'call_connector_tool', { connector: 'tools', tool: 'echo', arguments: { text: 'stopped' } })).rejects.toMatchObject({ status: 401 });
    expect(calledLines(log)).toHaveLength(1);
  }, 60_000);
  it('executes legitimate nested arrays of objects and repeated noncyclic values', async () => {
    const { d, log } = await setupMcp(undefined, ['nested']);
    const shared = { tags: ['one', 'two'], value: 2 };
    const args = { items: [shared, shared, { tags: [], value: 3 }] };
    const created = d.connectors.requestToolCall('tools', 'nested', args);
    expect(fs.existsSync(log)).toBe(false);
    await approve(d, created.decision.id);
    const result = d.connectors.getToolCallResult(created.request.id);
    expect(result.status).toBe('succeeded');
    expect(JSON.parse(result.result!.text)).toEqual(args);
    expect(calledLines(log, 'nested')).toHaveLength(1);
    await expectFixtureExit(log);
  });

  it('rejects accessors without executing them, exotic objects, nonJSON values and explosive DAGs', async () => {
    const { d, log } = await setupMcp();
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'text', { enumerable: true, get() { getterCalls++; throw new Error('credential-must-not-escape'); } });
    const arrayAccessor = Object.defineProperty([1], '0', { enumerable: true, get() { getterCalls++; return 'bad'; } });
    const bad = [null, [], undefined, { value: () => 1 }, { value: Symbol('x') }, { value: 1n }, { value: Infinity }, { value: new Map() }, { value: /x/ }, { value: new Proxy({}, {}) }, accessor, { items: arrayAccessor }, { items: new Array(2) }, { items: Object.assign([], { extra: true }) }, { toJSON() { getterCalls++; return {}; } }, { [Symbol('x')]: 'bad' }, Object.defineProperty({}, 'hidden', { value: 'bad' }), JSON.parse('{"__proto__":{"x":1}}'), { constructor: 'bad' }, { prototype: 'bad' }];
    for (const args of bad) expect(() => d.connectors.toolActions.request('tools', 'echo', args)).toThrow();
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => d.connectors.requestToolCall('tools', 'echo', { items: cyclic })).toThrow(/valid JSON/);
    let dag: unknown = { text: 'x'.repeat(1000) };
    for (let i = 0; i < 15; i++) dag = [dag, dag];
    expect(() => d.connectors.requestToolCall('tools', 'echo', { items: dag })).toThrow(/too large|deeply nested/);
    expect(getterCalls).toBe(0);
    expect(fs.existsSync(log)).toBe(false);
    expect(Object.values(d.state.decisions).filter(decision => decision.action?.kind === 'connector_tool')).toHaveLength(0);
  });

  it('binds request IDs and assignment IDs even when mutable request and binding copies agree', async () => {
    const { d, log } = await setupMcp();
    const first = d.connectors.requestToolCall('tools', 'echo', { text: 'identical' });
    const second = d.connectors.requestToolCall('tools', 'echo', { text: 'identical' });
    const binding = JSON.parse(d.store.kvGet(`connector-tool:${first.decision.id}`)!);
    binding.requestId = second.request.id;
    const other = JSON.parse(d.store.kvGet(`connector-tool-req:${second.request.id}`)!);
    other.decisionId = first.decision.id;
    d.store.kvSet(`connector-tool:${first.decision.id}`, JSON.stringify(binding));
    d.store.kvSet(`connector-tool-req:${second.request.id}`, JSON.stringify(other));
    await expect(approve(d, first.decision.id)).rejects.toThrow(/binding/);

    const run = createRun(d);
    const owned = d.connectors.requestToolCall('tools', 'echo', { text: 'assigned' }, { runId: run.id, workItemId: run.workItemId, requester: agentActor(run.agentId) });
    expect(owned.decision.evidence).toEqual(expect.arrayContaining([
      { label: 'Request ID', detail: owned.request.id },
      { label: 'Requester', detail: `agent:${run.agentId}` },
      { label: 'Requesting run', detail: run.id },
      { label: 'Assignment', detail: run.assignmentId },
      { label: 'Issue', detail: run.workItemId },
    ]));
    const altered = JSON.parse(d.store.kvGet(`connector-tool:${owned.decision.id}`)!);
    const alteredReq = JSON.parse(d.store.kvGet(`connector-tool-req:${owned.request.id}`)!);
    altered.assignmentId = alteredReq.assignmentId = 'assignment_foreign';
    d.store.kvSet(`connector-tool:${owned.decision.id}`, JSON.stringify(altered));
    d.store.kvSet(`connector-tool-req:${owned.request.id}`, JSON.stringify(alteredReq));
    await expect(approve(d, owned.decision.id)).rejects.toThrow(/binding/);
    expect(fs.existsSync(log)).toBe(false);
  });

  it('validates requester/run/assignment/issue identity before creating a Decision', async () => {
    const { d, log } = await setupMcp();
    const run = createRun(d);
    const foreign = d.createIssue({ title: 'foreign', acceptance: ['done'] });
    const count = Object.keys(d.state.decisions).length;
    const request = (requester = agentActor(run.agentId), runId: string | null = run.id, workItemId = run.workItemId) => d.connectors.requestToolCall('tools', 'echo', { text: 'identity' }, { requester, runId, workItemId });
    expect(() => request(agentActor('codex'))).toThrow(/changed/);
    expect(() => request(SYSTEM)).toThrow(/requester/);
    expect(() => request(HUMAN)).toThrow(/requester/);
    expect(() => request(agentActor('jev'))).toThrow();
    expect(() => request(agentActor(run.agentId), null)).toThrow(/requester/);
    expect(() => request(agentActor(run.agentId), 'run_missing')).toThrow();
    expect(() => request(agentActor(run.agentId), run.id, foreign.id)).toThrow(/changed/);
    expect(() => request(agentActor(run.agentId), run.id, 'issue_missing')).toThrow(/issue/);
    d.commit([{ type: 'assignment.updated', assignmentId: run.assignmentId, data: { patch: { agentId: 'codex' } } }]);
    expect(() => request()).toThrow(/changed/);
    d.commit([{ type: 'run.ended', runId: run.id, agentId: run.agentId, workItemId: run.workItemId, assignmentId: run.assignmentId, data: { exit: { kind: 'stopped', message: 'test' } } }]);
    expect(() => request()).toThrow(/run ended/);
    expect(Object.keys(d.state.decisions)).toHaveLength(count);
    expect(fs.existsSync(log)).toBe(false);
  });

  it('invalidates a pending action when its assignment changes and supports human polling after run end', async () => {
    const { d, log } = await setupMcp();
    const run = createRun(d);
    const created = d.connectors.requestToolCall('tools', 'echo', { text: 'identity' }, { requester: agentActor(run.agentId), runId: run.id, workItemId: run.workItemId });
    d.commit([{ type: 'assignment.updated', assignmentId: run.assignmentId, data: { patch: { agentId: 'codex' } } }]);
    await expect(approve(d, created.decision.id)).rejects.toThrow(/changed/);
    expect(d.connectors.getToolCallResult(created.request.id).status).toBe('invalidated');
    expect(fs.existsSync(log)).toBe(false);
  });

  it.each(['disabled', 'edited', 'expired'] as const)('allows safe human denial of an intact %s action after polling', async change => {
    const { d, log, config } = await setupMcp();
    const created = d.connectors.requestToolCall('tools', 'echo', { text: 'deny stale' });
    if (change === 'disabled') d.connectors.setDisabled('tools', true);
    if (change === 'edited') d.connectors.save({ id: 'tools', name: 'Local tools', config: { ...config, tools: ['echo', 'fail'] } }, d.state.connectors!.tools.configHash);
    if (change === 'expired') {
      const future = new Date(d.now().getTime() + 16 * 60_000);
      d.opts.clock = () => future;
    }
    const polled = d.connectors.getToolCallResult(created.request.id);
    expect(polled.status).toBe(change === 'expired' ? 'expired' : 'invalidated');
    expect(polled.endedAt).not.toBeNull();
    await d.decisions.respond(created.decision.id, 'deny', {}, HUMAN);
    expect(d.connectors.getToolCallResult(created.request.id).status).toBe('denied');
    expect(d.state.decisions[created.decision.id].answer).toBe('deny');
    expect(fs.existsSync(log)).toBe(false);
  });

  it('does not label a gate failure before the actual call as uncertain', async () => {
    const { d, log } = await setupMcp();
    const created = d.connectors.requestToolCall('tools', 'echo', { text: 'never invoked' });
    let gates = 0;
    d.connectors.toolActions.connectGate = async () => { if (++gates === 4) throw new Error('gate failed'); };
    await approve(d, created.decision.id);
    expect(d.connectors.getToolCallResult(created.request.id).status).toBe('error');
    expect(calledLines(log)).toHaveLength(0);
    await expectFixtureExit(log);
  });

  it.each(['denylist', 'disabled', 'revoked', 'ended'] as const)('revalidates after a real delayed tool response when %s changes in flight', async change => {
    const { d, log } = await setupMcp(undefined, ['delayed']);
    const run = createRun(d);
    const created = d.connectors.requestToolCall('tools', 'delayed', { text: 'inflight-value' }, { runId: run.id, workItemId: run.workItemId, requester: agentActor(run.agentId) });
    const executing = approve(d, created.decision.id);
    await waitFor(() => calledLines(log, 'delayed').length === 1, 10_000, 'actual delayed call');
    if (change === 'denylist') d.addSecret('inflight-value');
    if (change === 'disabled') d.connectors.setDisabled('tools', true);
    if (change === 'revoked') {
      // Disabling is the existing inventory revocation path; re-enable without re-approval.
      d.connectors.setDisabled('tools', true);
      d.connectors.setDisabled('tools', false);
    }
    if (change === 'ended') d.commit([{ type: 'run.ended', runId: run.id, agentId: run.agentId, workItemId: run.workItemId, assignmentId: run.assignmentId, data: { exit: { kind: 'completed', message: 'test' } } }]);
    fs.writeFileSync(`${log}.release`, 'release');
    await executing;
    const result = d.connectors.getToolCallResult(created.request.id);
    expect(result.status).toBe('uncertain');
    if (change !== 'ended') expect(fs.readFileSync(log, 'utf8')).toContain('returned:delayed');
    expect(result.result?.text ?? '').toBe('');
    expect(JSON.stringify(result)).not.toContain('inflight-value');
    expect(calledLines(log, 'delayed')).toHaveLength(1);
    await expectFixtureExit(log);
    await expect(approve(d, created.decision.id)).rejects.toThrow(/already|used/);
    expect(calledLines(log, 'delayed')).toHaveLength(1);
  });

  it('reports a real outstanding tool timeout as uncertain and closes its owned child', async () => {
    const { d, log } = await setupMcp(undefined, ['delayed']);
    const created = d.connectors.requestToolCall('tools', 'delayed', { text: 'timeout' });
    await approve(d, created.decision.id);
    expect(calledLines(log, 'delayed')).toHaveLength(1);
    expect(d.connectors.getToolCallResult(created.request.id).status).toBe('uncertain');
    await expectFixtureExit(log);
    await expect(approve(d, created.decision.id)).rejects.toThrow(/already|used/);
    expect(calledLines(log, 'delayed')).toHaveLength(1);
  }, 35_000);

  it.each(['stop', 'kill', 'shutdown'] as const)('closes owned active transports on %s and preserves another project', async operation => {
    const { d, log } = await setupMcp(undefined, ['delayed']);
    const run = createRun(d);
    const created = d.connectors.requestToolCall('tools', 'delayed', { text: 'owned' }, { runId: run.id, workItemId: run.workItemId, requester: agentActor(run.agentId) });
    const executing = approve(d, created.decision.id);
    await waitFor(() => calledLines(log, 'delayed').length === 1, 10_000, 'owned call');
    const peer = await startDaemon(makeConfig(makeRepo()), { probe: false, server: false });
    const peerLog = path.join(tmpDir('peer-marker'), 'calls');
    let peerExecuting: Promise<unknown> | undefined;
    try {
      peer.d.connectors.save({ id: 'tools', name: 'Peer', config: { kind: 'mcp', command: process.execPath, args: [path.join(FIX, 'fake-mcp-tools.mjs'), peerLog], tools: ['delayed'], read_roots: [] } }, null);
      await approveInventory(peer.d);
      const peerReq = peer.d.connectors.requestToolCall('tools', 'delayed', { text: 'peer' });
      peerExecuting = approve(peer.d, peerReq.decision.id);
      await waitFor(() => calledLines(peerLog, 'delayed').length === 1, 10_000, 'peer call');
      if (operation === 'stop') await d.runs.stop(run.id, 'fixture stop');
      if (operation === 'kill') await d.setKillSwitch(true);
      if (operation === 'shutdown') await d.shutdown();
      await executing;
      await expectFixtureExit(log);
      expect(alive(fixturePid(peerLog)!)).toBe(true);
      expect(peer.d.connectors.getToolCallResult(peerReq.request.id).status).toBe('running');
      // Peer output still finishes normally without another approval or restart.
      fs.writeFileSync(`${peerLog}.release`, 'release');
      await peerExecuting;
      expect(peer.d.connectors.getToolCallResult(peerReq.request.id).status).toBe('succeeded');
      if (operation !== 'shutdown') expect(d.connectors.getToolCallResult(created.request.id).status).toBe('uncertain');
      else {
        const dataDir = h!.dataDir;
        h = null;
        h = await startDaemon(d.config, { probe: false, server: false, dataDir });
        expect(h.d.connectors.getToolCallResult(created.request.id).status).toBe('uncertain');
        expect(calledLines(log, 'delayed')).toHaveLength(1);
      }
    } finally {
      await peer.close();
      await peerExecuting;
    }
  }, 45_000);

  it('stopping one run leaves another owned invocation in the same project active', async () => {
    const { d, log, config } = await setupMcp(undefined, ['delayed']);
    const otherLog = path.join(tmpDir('other-run'), 'calls');
    d.connectors.save({ id: 'other', name: 'Other', config: { ...config, args: [path.join(FIX, 'fake-mcp-tools.mjs'), otherLog] } }, null);
    const inv = d.connectors.requestActivation('other', 'execute').decision!;
    const prep = d.decisions.prepare(inv.id, 'approve');
    await d.connectors.resolve(inv.id, 'approve', HUMAN, { nonce: prep.nonce });
    const firstRun = createRun(d);
    const secondRun = createRun(d, 'codex');
    const make = (connector: string, run: Run) => d.connectors.requestToolCall(connector, 'delayed', { text: 'run' }, { runId: run.id, workItemId: run.workItemId, requester: agentActor(run.agentId) });
    const first = make('tools', firstRun);
    const second = make('other', secondRun);
    const executing = approve(d, first.decision.id);
    const peerExecuting = approve(d, second.decision.id);
    await waitFor(() => calledLines(log, 'delayed').length === 1 && calledLines(otherLog, 'delayed').length === 1, 10_000, 'both calls');
    await d.runs.stop(firstRun.id, 'fixture stop');
    await executing;
    await expectFixtureExit(log);
    expect(alive(fixturePid(otherLog)!)).toBe(true);
    expect(d.connectors.getToolCallResult(second.request.id).status).toBe('running');
    fs.writeFileSync(`${otherLog}.release`, 'release');
    await peerExecuting;
    expect(d.connectors.getToolCallResult(second.request.id).status).toBe('succeeded');
  });

  it('uses authenticated HTTP request/prepare/answer/poll routes for exact human execution', async () => {
    h = await startDaemon(makeConfig(makeRepo()), { probe: false });
    const d = h.d;
    const log = path.join(tmpDir('http-mcp'), 'calls');
    d.connectors.save({ id: 'tools', name: 'HTTP fixture', config: { kind: 'mcp', command: process.execPath, args: [path.join(FIX, 'fake-mcp-tools.mjs'), log], tools: ['echo'], read_roots: [] } }, null);
    await approveInventory(d);
    const headers = { authorization: `Bearer ${fs.readFileSync(d.paths.installToken, 'utf8').trim()}`, 'content-type': 'application/json' };
    const post = (route: string, body: unknown) => fetch(h!.url + route, { method: 'POST', headers, body: JSON.stringify(body) });
    const request = await post('/api/connectors/tools/tools/echo', { arguments: { text: 'HTTP exact' } });
    expect(request.status).toBe(200);
    const created = await request.json() as { request: { id: string }; decision: { id: string } };
    expect(fs.existsSync(log)).toBe(false);
    expect((await post(`/api/decisions/${created.decision.id}/answer`, { answer: 'approve' })).status).toBe(428);
    const prepare = await post(`/api/decisions/${created.decision.id}/prepare`, { answer: 'approve' });
    expect(prepare.status).toBe(200);
    const { nonce } = await prepare.json() as { nonce: string };
    const answered = await post(`/api/decisions/${created.decision.id}/answer`, { answer: 'approve', nonce, channel: 'phone' });
    expect(answered.status).toBe(200);
    const response = await answered.json() as { tool: { request: { id: string; status: string } } };
    expect(response.tool.request).toMatchObject({ id: created.request.id, status: 'succeeded' });
    expect(d.state.decisions[created.decision.id]).toMatchObject({ answeredBy: HUMAN, channel: 'phone', answer: 'approve' });
    const poll = await fetch(h.url + `/api/connectors/tool-requests/${created.request.id}`, { headers });
    expect(poll.status).toBe(200);
    expect(await poll.json()).toMatchObject({ request: { id: created.request.id, status: 'succeeded' } });
    expect((await post(`/api/decisions/${created.decision.id}/answer`, { answer: 'approve', nonce })).status).toBe(409);
    expect(calledLines(log)).toHaveLength(1);
    await expectFixtureExit(log);
  });

  it('kill closes a human call with no agent run and leaves an unowned fixture child alive', async () => {
    const { d, log } = await setupMcp(undefined, ['delayed']);
    const unownedLog = path.join(tmpDir('unowned-fixture'), 'calls');
    // This handle belongs to the test, never to the plugin action registry.
    const unowned = spawn(process.execPath, [path.join(FIX, 'fake-mcp-tools.mjs'), unownedLog], { stdio: ['pipe', 'ignore', 'ignore'] });
    const closed = new Promise<void>(resolve => unowned.once('close', () => resolve()));
    try {
      await waitFor(() => fs.existsSync(unownedLog), 10_000, 'unowned fixture startup');
      const created = d.connectors.requestToolCall('tools', 'delayed', { text: 'human owned' });
      const executing = approve(d, created.decision.id);
      await waitFor(() => calledLines(log, 'delayed').length === 1, 10_000, 'human owned call');
      expect(await d.setKillSwitch(true)).toBe(0);
      await executing;
      expect(d.connectors.getToolCallResult(created.request.id).status).toBe('uncertain');
      await expectFixtureExit(log);
      expect(alive(unowned.pid!)).toBe(true);
    } finally {
      // Clean up only the disposable fixture spawned by this test's exact handle.
      unowned.kill('SIGTERM');
      await closed;
    }
  });

  it('rolls back consume, running, human answer and start event together if the transaction fails', async () => {
    const { d, log } = await setupMcp();
    const created = d.connectors.requestToolCall('tools', 'echo', { text: 'atomic rollback' });
    const prep = d.decisions.prepare(created.decision.id, 'approve');
    const original = d.store.kvSet.bind(d.store);
    d.store.kvSet = (key, value) => {
      if (key === `connector-tool-req:${created.request.id}` && JSON.parse(value).status === 'running') throw new Error('fixture transaction failure');
      original(key, value);
    };
    try {
      await expect(d.connectors.resolveToolCall(created.decision.id, 'approve', HUMAN, { nonce: prep.nonce })).rejects.toThrow(/transaction failure/);
    } finally {
      d.store.kvSet = original;
    }
    expect(JSON.parse(d.store.kvGet(`connector-tool:${created.decision.id}`)!).consumed).toBe(false);
    expect(d.connectors.getToolCallResult(created.request.id).status).toBe('pending');
    expect(d.state.decisions[created.decision.id].answeredAt).toBeNull();
    expect(d.store.list({ types: ['connector.tool_execution_started'] })).toHaveLength(0);
    expect(fs.existsSync(log)).toBe(false);
    await d.decisions.respond(created.decision.id, 'approve', { nonce: prep.nonce }, HUMAN);
    expect(calledLines(log)).toHaveLength(1);
  });

});
