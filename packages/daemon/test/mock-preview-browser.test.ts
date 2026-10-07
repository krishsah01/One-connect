// SPDX-License-Identifier: Apache-2.0
// Real Chromium test; no Playwright install. Supply an existing headless executable explicitly.
// This tests the immutable ancestor CSP/sandbox, not a JS navigation shim. Generic web execution
// remains disabled because CSP cannot provide an engine-level WebRTC denial.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { mockPreviewShell } from '@acc/core';
import { tmpDir } from './helpers.ts';
const executable = process.env.ACC_MOCK_TEST_CHROMIUM;
it.skipIf(!executable)('enforces navigation/resource/parent isolation while inline script handlers remain interactive in Chromium', async () => {
  const profile = tmpDir('mock-chromium');
  const forbidden: string[] = [];
  const documents = new Map<string, string>();
  const server = http.createServer((req, res) => {
    const html = documents.get(req.url ?? '');
    if (!html) forbidden.push(req.url ?? '');
    res.setHeader('Content-Type', 'text/html'); res.end(html ?? 'ESCAPED');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const child = spawn(executable!, ['--headless', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`], { cwd: path.resolve(import.meta.dirname, '../../..'), stdio: ['ignore', 'ignore', 'pipe'] });
  let output = ''; child.stderr.on('data', b => { output += b; });
  let ws: WebSocket | undefined;
  try {
    let endpoint: string | undefined;
    for (let i = 0; i < 100 && !endpoint; i++) { endpoint = output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]; await new Promise(r => setTimeout(r, 50)); }
    if (!endpoint) throw Error(`Browser failed: ${output.slice(-1000)}`);
    ws = new WebSocket(endpoint); await once(ws, 'open');
    let id = 0; const pending = new Map<number, (value: any) => void>();
    ws.onmessage = e => { const m = JSON.parse(String(e.data)); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
    const send = async (method: string, params: object = {}, sessionId?: string): Promise<any> => {
      const key = ++id; const result = new Promise<any>(r => pending.set(key, r));
      ws!.send(JSON.stringify({ id: key, method, params, sessionId }));
      const m = await result; if (m.error) throw Error(JSON.stringify(m.error)); return m.result;
    };
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId);
    const evaluate = async (expression: string, contextId?: number) => {
      const r = await send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value;
    };
    const load = async (name: string, html: string, pages: Record<string, string> = {}) => {
      const shell = mockPreviewShell(html, pages);
      documents.set(`/${name}`, `<html><head></head><body><script>window.__TAURI_INTERNALS__={invoke:()=>{window.ipcEscaped=true}}</script><iframe id="shell" sandbox="allow-scripts"></iframe><script>shell.srcdoc=${JSON.stringify(shell).replace(/</g, '\\u003c')}</script></body></html>`);
      await send('Page.navigate', { url: `${origin}/${name}` }, sessionId);
      let inner;
      for (let i = 0; i < 40 && !inner; i++) { await new Promise(r => setTimeout(r, 25)); const tree = await send('Page.getFrameTree', {}, sessionId); inner = tree.frameTree.childFrames?.[0]?.childFrames?.[0]?.frame; }
      expect(inner, name).toBeTruthy();
      const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: inner.id, worldName: 'verification', grantUniveralAccess: false }, sessionId);
      return executionContextId;
    };
    const context = await load('interactive', `<button id="b" onclick="document.body.dataset.clicked='yes'">Change state</button><a id="a" href="${origin}/anchor">Remote</a><script>
document.body.dataset.script='yes';try{parent.document.body.dataset.escaped='yes'}catch(e){document.body.dataset.parentDenied='yes'};
try{top.__TAURI_INTERNALS__.invoke()}catch(e){document.body.dataset.ipcDenied='yes'};
fetch('${origin}/fetch').catch(()=>document.body.dataset.fetchDenied='yes');
try{const w=new WebSocket('${origin.replace('http:', 'ws:')}/socket');w.onerror=()=>document.body.dataset.socketDenied='yes'}catch(e){document.body.dataset.socketDenied='yes'};
new Image().src='${origin}/image';document.body.style.backgroundImage='url(${origin}/css)';
</script>`);
    await evaluate(`document.getElementById('b').click()`, context);
    await new Promise(r => setTimeout(r, 100));
    expect(await evaluate(`({...document.body.dataset})`, context)).toMatchObject({ script: 'yes', clicked: 'yes', parentDenied: 'yes', ipcDenied: 'yes', fetchDenied: 'yes', socketDenied: 'yes' });
    expect(await evaluate('window.ipcEscaped')).toBeUndefined();
    await evaluate(`document.getElementById('a').click()`, context);
    await new Promise(r => setTimeout(r, 150));
    for (const [name, action] of [
      ['obfuscated-href', `location[String.fromCharCode(104,114,101,102)]=${JSON.stringify(origin + '/href')}`],
      ['assign', `location.assign(${JSON.stringify(origin + '/assign')})`],
      ['replace', `location.replace(${JSON.stringify(origin + '/replace')})`],
      ['event-handler', `document.getElementById('b').click()`],
      ['popup', `window.open(${JSON.stringify(origin + '/popup')})`],
      ['form', `document.getElementById('form').submit()`],
    ]) {
      const ctx = await load(name, `<button id="b" onclick="location.replace('${origin}/event')">Go</button><form id="form" action="${origin}/form"></form><script>document.body.dataset.ready='yes'</script>`);
      expect(await evaluate(`document.body.dataset.ready`, ctx)).toBe('yes');
      await evaluate(action, ctx); await new Promise(r => setTimeout(r, 150));
      const tree = await send('Page.getFrameTree', {}, sessionId);
      expect(tree.frameTree.frame.url).toBe(`${origin}/${name}`);
      expect(tree.frameTree.childFrames?.[0]?.childFrames?.[0]?.frame.url ?? '').not.toMatch(/^https?:/);
    }
    const next = '<body data-local="yes">Local second page</body>';
    const local = await load('local-pages', `<a id="local" href="page2.html" onclick="event.preventDefault();parent.postMessage({source:'one-connect-mock',type:'navigate',page:'page2.html'},'*')">Next</a>`, { 'page2.html': next });
    await evaluate(`document.getElementById('local').click()`, local); await new Promise(r => setTimeout(r, 100));
    const tree = await send('Page.getFrameTree', {}, sessionId);
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: tree.frameTree.childFrames[0].childFrames[0].frame.id, worldName: 'local-check' }, sessionId);
    expect(await evaluate(`document.body.dataset.local`, executionContextId)).toBe('yes');
    expect(forbidden).toEqual([]);
  } finally {
    ws?.close(); child.kill(); await once(child, 'exit');
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);
