// SPDX-License-Identifier: Apache-2.0
// Bundled local models: availability needs the exact files, the Ollama-compatible bridge refuses
// browsers and foreign hosts, and a model whose SHA-256 does not match is never loaded.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_MODELS, LocalModels, localModelsDir } from '../src/localModels.ts';

const open: LocalModels[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(m => m.close())); });

/** Model files of the right size (sparse, so cheap) and a stand-in server binary. */
function fakeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-models-'));
  fs.mkdirSync(path.join(dir, 'llama', 'llama-b11540'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'llama', 'llama-b11540', 'llama-server'), '#!/bin/sh\n', { mode: 0o755 });
  for (const m of [LOCAL_MODELS.chat, LOCAL_MODELS.embed]) { const fd = fs.openSync(path.join(dir, m.file), 'w'); fs.ftruncateSync(fd, m.bytes); fs.closeSync(fd); }
  return dir;
}

function request(port: number, p: string, o: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: o.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...o.headers } }, res => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data || '{}') }));
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(JSON.stringify(o.body));
    req.end();
  });
}

describe('bundled local models', () => {
  it('are available only with an explicit folder holding every exact file', () => {
    expect(localModelsDir({})).toBeNull();
    expect(new LocalModels({ dir: null }).status().available).toBe(false);
    const dir = fakeDir();
    expect(localModelsDir({ ACC_LOCAL_MODELS_DIR: dir })).toBe(dir);
    expect(new LocalModels({ dir }).status()).toMatchObject({ available: true, runtime: { present: true } });
    fs.truncateSync(path.join(dir, LOCAL_MODELS.embed.file), 10);
    expect(new LocalModels({ dir }).status().available).toBe(false);
  });

  it('serves an Ollama-compatible bridge that refuses browsers, foreign hosts and unverified models', async () => {
    const port = 21000 + Math.floor(Math.random() * 20000);
    let spawned = 0;
    const m = new LocalModels({ dir: fakeDir(), port, spawnServer: () => { spawned++; throw new Error('must not start'); } });
    open.push(m);
    m.startBridge();
    await m.bridgeReady;
    expect((await request(port, '/api/version')).body).toEqual({ version: 'one-connect-local-models/1' });
    expect((await request(port, '/api/tags', { headers: { origin: 'https://example.com' } })).status).toBe(403);
    expect((await request(port, '/api/tags', { headers: { host: 'attacker.example' } })).status).toBe(403);
    const tags = await request(port, '/api/tags');
    expect((tags.body.models as { name: string }[]).map(x => x.name)).toEqual([LOCAL_MODELS.chat.id, LOCAL_MODELS.embed.id]);
    expect((await request(port, '/api/show', { method: 'POST', body: { model: 'qwen3-embedding:0.6b' } })).body).toMatchObject({ capabilities: ['embedding'] });
    expect((await request(port, '/api/show', { method: 'POST', body: { model: 'llama3' } })).status).toBe(404);
    // The fake files are zeros, so their SHA-256 never matches: nothing is ever loaded.
    const embed = await request(port, '/api/embed', { method: 'POST', body: { model: 'qwen3-embedding:0.6b', input: ['hello'] } });
    expect(embed.status).toBe(500);
    expect(String(embed.body.error)).toMatch(/SHA-256/);
    expect(spawned).toBe(0);
    expect((await request(port, '/api/generate', { method: 'POST', body: { model: 'qwen3:1.7b', prompt: 'x', stream: true } })).status).toBe(400);
  });
});
