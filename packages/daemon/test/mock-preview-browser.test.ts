// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
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
  const child = spawn(executable!, ['--headless', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { cwd: path.resolve(import.meta.dirname, '../../..'), stdio: ['ignore', 'ignore', 'pipe'] });
  const childExit = once(child, 'exit');
  let output = ''; child.stderr.on('data', b => { output += b; });
  let ws: WebSocket | undefined;
  try {
    let endpoint: string | undefined;
    for (let i = 0; i < 300 && !endpoint && child.exitCode === null && child.signalCode === null; i++) { endpoint = output.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]; await new Promise(r => setTimeout(r, 50)); }
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
    type Context = { id: number; session: string };
    const evaluate = async (expression: string, context?: Context) => {
      const r = await send('Runtime.evaluate', { expression, contextId: context?.id, returnByValue: true, awaitPromise: true }, context?.session ?? sessionId);
      if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value;
    };
    // Opaque sandboxed frames may run in separate renderer processes. Observe them through
    // their own CDP sessions instead of disabling Chromium's process isolation for this test.
    const frameSessions = new Map<string, string>();
    const frames = async () => {
      const targets = (await send('Target.getTargets')).targetInfos.filter((t: any) => t.type === 'iframe');
      for (const t of targets) if (!frameSessions.has(t.targetId)) {
        const attached = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        frameSessions.set(t.targetId, attached.sessionId);
        await send('Page.enable', {}, attached.sessionId);
        await send('Runtime.enable', {}, attached.sessionId);
      }
      const active = new Set(targets.map((t: any) => t.targetId));
      for (const id of frameSessions.keys()) if (!active.has(id)) frameSessions.delete(id);
      const found = new Map<string, any>();
      for (const sid of [sessionId, ...frameSessions.values()]) {
        const tree = (await send('Page.getFrameTree', {}, sid)).frameTree;
        const visit = (node: any) => {
          if (!found.has(node.frame.id)) found.set(node.frame.id, { ...node.frame, session: sid });
          for (const child of node.childFrames ?? []) visit(child);
        };
        visit(tree);
      }
      return [...found.values()];
    };
    const mockFrame = async () => {
      const all = await frames();
      const outer = all.find(f => f.parentId === targetId);
      return outer ? all.find(f => f.parentId === outer.id) : undefined;
    };
    const load = async (name: string, html: string, pages: Record<string, string> = {}) => {
      const shell = mockPreviewShell(html, pages);
      documents.set(`/${name}`, `<html><head><link rel="icon" href="data:,"></head><body><script>window.__TAURI_INTERNALS__={invoke:()=>{window.ipcEscaped=true}}</script><iframe id="shell" sandbox="allow-scripts"></iframe><script>shell.srcdoc=${JSON.stringify(shell).replace(/</g, '\\u003c')}</script></body></html>`);
      await send('Page.navigate', { url: `${origin}/${name}` }, sessionId);
      let inner;
      for (let i = 0; i < 40 && !inner; i++) { await new Promise(r => setTimeout(r, 25)); inner = await mockFrame(); }
      expect(inner, `${name}: preview frame`).toBeTruthy();
      const world = await send('Page.createIsolatedWorld', { frameId: inner.id, worldName: 'verification', grantUniveralAccess: false }, inner.session);
      const { executionContextId } = world;
      expect(executionContextId, JSON.stringify({ inner, world })).toBeTypeOf('number');
      const context = { id: executionContextId, session: inner.session };
      let ready = false;
      for (let i = 0; i < 40 && !ready; i++) {
        ready = await evaluate('Boolean(document.body?.querySelector("button, a"))', context);
        if (!ready) await new Promise(r => setTimeout(r, 25));
      }
      if (!ready) throw Error(`${name}: preview document did not load. ${JSON.stringify({ inner, context })}; ${JSON.stringify(await evaluate('({url:location.href,html:document.body?.innerHTML?.slice(0,200)})', context))}`);
      return context;
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
      const inner = await mockFrame();
      expect(inner, `${name}: preview remains present`).toBeTruthy();
      expect(inner.url).not.toMatch(/^https?:/);
    }
    const next = '<body data-local="yes">Local second page</body>';
    const local = await load('local-pages', `<a id="local" href="page2.html" onclick="event.preventDefault();parent.postMessage({source:'one-connect-mock',type:'navigate',page:'page2.html'},'*')">Next</a>`, { 'page2.html': next });
    await evaluate(`document.getElementById('local').click()`, local); await new Promise(r => setTimeout(r, 100));
    const inner = await mockFrame();
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: inner.id, worldName: 'local-check' }, inner.session);
    expect(await evaluate(`document.body.dataset.local`, { id: executionContextId, session: inner.session })).toBe('yes');
    expect(forbidden).toEqual([]);
  } finally {
    ws?.close(); child.kill(); await childExit;
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);
