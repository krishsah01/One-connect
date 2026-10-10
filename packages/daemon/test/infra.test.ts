// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Event store durability, failure classification, binary detection, the local server's auth.
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { describe, expect, it } from 'vitest';
import { applyEvent, emptyState, type EventEnvelope } from '@acc/core';
import { chooseBinary, newerCandidate, parseVersion } from '../src/adapters/agents/detect.ts';
import { sanitizeEnv } from '../src/adapters/agents/env.ts';
import { classifyFailure, parseResetTime } from '../src/adapters/agents/failures.ts';
import { isUnderTemp, resolveDataPaths, TempDataDirError } from '../src/paths.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { makeConfig, makeRepo, startDaemon, tmpDir, waitFor } from './helpers.ts';

describe('event store', () => {
  it('is append-only, replays to the same state and keeps outbox + tail atomic', () => {
    const file = path.join(tmpDir('es'), 'e.sqlite');
    const s = new EventStore(file);
    const env = s.append([{ type: 'kill_switch.set', data: { engaged: true } }], [{ workItemId: 'w1', op: 'comment', payload: { body: 'x' } }], { inTx: () => s.setTail('r1', 10, 5) });
    expect(env[0].seq).toBe(1);
    expect(() => s.db.exec("UPDATE events SET type = 'x'")).toThrow(/append-only/);
    expect(() => s.db.exec('DELETE FROM events')).toThrow(/append-only/);
    expect(s.pendingOutbox('9999')).toHaveLength(1);
    expect(s.getTail('r1')).toEqual({ stdout: 10, stderr: 5 });
    // A failing inTx rolls back the events and the outbox rows.
    expect(() => s.append([{ type: 'kill_switch.set', data: { engaged: false } }], [{ workItemId: 'w2', op: 'comment', payload: {} }], { inTx: () => { throw new Error('boom'); } })).toThrow('boom');
    expect(s.lastSeq()).toBe(1);
    expect(s.pendingOutbox('9999')).toHaveLength(1);
    s.close();
    const again = new EventStore(file);
    expect(again.loadState(applyEvent).killSwitch.engaged).toBe(true);
    again.saveSnapshot(again.loadState(applyEvent));
    expect(again.loadState(applyEvent)).toEqual([...again.iterate()].reduce(applyEvent, emptyState()));
    again.close();
  });

  it('reads newest-first pages, filters by mentioned ids and treats kv prefixes literally', () => {
    const s = new EventStore(path.join(tmpDir('es'), 'e.sqlite'));
    s.append(Array.from({ length: 5 }, (_, i) => ({ type: 'rule.toggled' as const, data: { rule: 'auto_refill' as const, enabled: i % 2 === 0 } })));
    s.append([{ type: 'alert.resolved', data: { alertId: 'al_target', resolution: 'x' } }, { type: 'alert.resolved', data: { alertId: 'al_other', resolution: 'y' } }]);
    expect(s.list({ types: ['rule.toggled'], limit: 2, order: 'desc' }).map((e) => e.seq)).toEqual([5, 4]);
    expect(s.list({ types: ['rule.toggled'], limit: 2 }).map((e) => e.seq)).toEqual([1, 2]);
    expect(s.list({ containsAny: ['al_target'] }).map((e) => e.seq)).toEqual([6]);
    expect(s.list({ limit: Number.NaN })).toHaveLength(7);
    s.kvSet('a_b:1', 'x');
    s.kvSet('aXb:2', 'y');
    expect(s.kvKeys('a_b:')).toEqual(['a_b:1']);
    s.close();
  });

  it('refuses temp directories for durable state unless explicitly allowed (tests)', () => {
    const t = tmpDir('dd');
    expect(isUnderTemp(t)).toBe(true);
    expect(() => resolveDataPaths(t, { allowTemp: false })).toThrow(TempDataDirError);
    expect(resolveDataPaths(t, { allowTemp: true }).db).toBe(path.join(t, 'acc.sqlite'));
  });
});

describe('failure classification', () => {
  it.each([
    ["You've hit your usage limit. Try again in 2h 5m.", 'usage_limit'],
    ['Claude AI usage limit reached|1791322922', 'usage_limit'],
    ['Error: 429 Too Many Requests', 'usage_limit'],
    ['stream error: connection timed out', 'network'],
    ['Error: getaddrinfo ENOTFOUND api.anthropic.com', 'network'],
    ['Not logged in. Please run codex login', 'auth_expired'],
    ['The model `gpt-9` does not exist or is not available on your plan', 'model_unsupported'],
    ["fatal: Unable to create '/repo/.git/worktrees/x/index.lock': Operation not permitted", 'sandbox_denied'],
  ])('%s → %s', (text, kind) => {
    expect(classifyFailure(text)?.kind).toBe(kind);
  });

  it('parses reset times', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(parseResetTime('Try again in 2h 5m', now)).toBe('2026-01-01T02:05:00.000Z');
    expect(parseResetTime('limit reached|1791322922', now)).toBe(new Date(1791322922 * 1000).toISOString());
    expect(parseResetTime('resets 2026-01-02T03:00:00Z', now)).toBe('2026-01-02T03:00:00.000Z');
    expect(parseResetTime('nothing here', now)).toBeNull();
  });
});

describe('binaries & env', () => {
  it('pins the newest stable binary and flags a newer prerelease (app-bundled Codex)', () => {
    const cands = [
      { path: '/Users/x/.local/bin/codex', version: '0.154.0', prerelease: false, source: 'path' as const },
      { path: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', version: '0.159.0-alpha.12.1', prerelease: true, source: 'app-bundle' as const },
    ];
    expect(parseVersion('codex-cli 0.159.0-alpha.12.1')).toEqual({ version: '0.159.0-alpha.12.1', prerelease: true });
    expect(parseVersion('2026.10.01-e373342')).toEqual({ version: '2026.10.01', prerelease: false });
    expect(chooseBinary(cands)?.path).toBe('/Users/x/.local/bin/codex');
    expect(newerCandidate(chooseBinary(cands), cands)?.version).toBe('0.159.0-alpha.12.1');
    expect(chooseBinary([...cands, { path: '/pinned/codex', version: '0.1.0', prerelease: false, source: 'config' }])?.path).toBe('/pinned/codex');
  });

  it('strips API-key variables from agent runs unless the agent opted into metered billing', () => {
    const cfg = makeConfig('/tmp/x');
    const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-x', ACC_DATA_DIR: '/d', HOME: '/h' };
    const { env, stripped } = sanitizeEnv(cfg.agents[0], base);
    expect(env).toEqual({ PATH: '/bin', HOME: '/h' });
    expect(stripped.sort()).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    expect(sanitizeEnv({ ...cfg.agents[0], metered_opt_in: true }, base).env.ANTHROPIC_API_KEY).toBe('sk-ant-x');
  });
});

describe('local server security', () => {
  it('native WebSocket tickets require auth, work once, and never authenticate API requests', async () => {
    const h = await startDaemon(makeConfig(makeRepo()), { probe: false });
    const connect = (url: string) => new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once('open', () => resolve(ws));
      ws.once('error', () => reject(new Error('WebSocket authentication rejected')));
      ws.once('unexpected-response', (_request, response) => {
        response.resume(); ws.terminate(); reject(new Error('WebSocket authentication rejected'));
      });
    });
    try {
      expect((await fetch(`${h.url}/api/auth/ws-ticket`, { method: 'POST' })).status).toBe(401);
      const token = fs.readFileSync(h.d.paths.installToken, 'utf8').trim();
      const headers = { authorization: `Bearer ${token}` };
      const { ticket } = await (await fetch(`${h.url}/api/auth/ws-ticket`, { method: 'POST', headers })).json() as { ticket: string };
      expect((await fetch(`${h.url}/api/state?ticket=${ticket}`)).status).toBe(401);
      const url = `${h.url.replace('http:', 'ws:')}/ws?ticket=${ticket}`;
      const ws = await connect(url);
      ws.terminate();
      await expect(connect(url)).rejects.toThrow(/rejected/);
      expect((await fetch(`${h.url}/api/desktop/shutdown`, { method: 'POST', headers })).status).toBe(403);
    } finally { await h.close(); }
  });

  it('pages all UTF-8 log bytes and more than 5000 durable transcript events', async () => {
    const h = await startDaemon(makeConfig(makeRepo()));
    try {
      const item = h.d.createIssue({ title: 'Relay log test', description: '' });
      await waitFor(() => h.d.state.workItems[item.id].key);
      const assignment = h.d.createAssignment({ workItemId: item.id, agentId: 'ag' });
      const { runId } = await h.d.dispatch(assignment.id);
      const dir = h.d.runs.supervisor.runDir(runId!);
      fs.mkdirSync(dir, { recursive: true });
      const original = 'a'.repeat(128 * 1024 - 1) + '☃'.repeat(200000) + '\nlast line';
      fs.writeFileSync(path.join(dir, 'stdout.jsonl'), original);
      const token = fs.readFileSync(h.d.paths.installToken, 'utf8').trim();
      const headers = { authorization: `Bearer ${token}` };
      const read = async <T>(p: string) => (await fetch(`${h.url}${p}`, { headers })).json() as Promise<T>;
      let result = '', offset = 0;
      for (;;) {
        const page = await read<{ text: string; nextOffset: number; totalBytes: number }>(`/api/runs/${runId}/log/page?offset=${offset}`);
        expect(page.text).not.toContain('�');
        result += page.text;
        if (page.nextOffset === page.totalBytes) break;
        expect(page.nextOffset).toBeGreaterThan(offset);
        offset = page.nextOffset;
      }
      expect(result).toBe(original);
      expect(await (await fetch(`${h.url}/api/runs/${runId}/log`, { headers })).text()).toBe(original);
      h.d.store.append(Array.from({ length: 5001 }, (_, i) => ({ type: 't.message' as const, runId: runId!, data: { role: 'assistant' as const, text: `message ${i}` } })));
      let since = 0; const texts: string[] = [];
      for (;;) {
        const { events } = await read<{ events: EventEnvelope[] }>(`/api/runs/${runId}/events?since=${since}&limit=1000`);
        for (const e of events) if (e.type === 't.message') texts.push(e.data.text);
        if (events.length < 1000) break;
        since = events.at(-1)!.seq;
      }
      expect(texts.filter(t => t.startsWith('message '))).toHaveLength(5001);
      expect(texts.at(-1)).toBe('message 5000');
    } finally { await h.close(); }
  });
  it('requires a session, checks Host and Origin, and signs in with a one-time code', async () => {
    const h = await startDaemon(makeConfig(makeRepo()), { probe: false });
    try {
      const u = h.url;
      expect((await fetch(`${u}/api/state`)).status).toBe(401);
      // Bearer install token (CLI) works.
      const token = fs.readFileSync(h.d.paths.installToken, 'utf8').trim();
      expect((await fetch(`${u}/api/state`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
      // Cross-origin requests are refused even with a valid token.
      expect((await fetch(`${u}/api/state`, { headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' } })).status).toBe(403);
      // One-time code → HttpOnly SameSite=Strict cookie; reuse fails.
      const { code } = (await (await fetch(`${u}/api/auth/code`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).json()) as { code: string };
      const r = await fetch(`${u}/auth?code=${code}`, { redirect: 'manual' });
      expect(r.status).toBe(302);
      const cookie = r.headers.get('set-cookie')!;
      expect(cookie).toMatch(/HttpOnly; SameSite=Strict/);
      expect((await fetch(`${u}/auth?code=${code}`, { redirect: 'manual' })).status).toBe(401);
      const session = cookie.split(';')[0];
      expect((await fetch(`${u}/api/state`, { headers: { cookie: session } })).status).toBe(200);
      // State-changing request from the page's own origin works; without Origin it is refused.
      const post = (headers: Record<string, string>) => fetch(`${u}/api/issues`, { method: 'POST', headers: { cookie: session, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ title: 'From the UI' }) });
      expect((await post({})).status).toBe(403);
      expect((await post({ origin: u })).status).toBe(200);
      // The MCP bridge only accepts per-run tokens.
      expect((await fetch(`${u}/api/mcp/get_assignment`, { method: 'POST', headers: { cookie: session, 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
      expect(fs.statSync(h.d.paths.installToken).mode & 0o777).toBe(0o600);
    } finally {
      await h.close();
    }
  });
});
