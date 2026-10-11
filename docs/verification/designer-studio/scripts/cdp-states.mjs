// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Executed browser check for the demo mock: installed Chrome, headless, DevTools protocol only.
// Network is blocked except the loopback server that serves the trusted preview shell.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const path_join = path.join;

const [chrome, url, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-states-'));
const child = spawn(chrome, ['--headless', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-site-isolation-trials', '--disable-features=IsolateOrigins,site-per-process', '--remote-debugging-port=0', `--user-data-dir=${profile}`], { stdio: ['ignore', 'ignore', 'pipe'] });
let log = ''; child.stderr.on('data', b => { log += b; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { tool: '', url, checks: [] };
try {
  let endpoint;
  for (let i = 0; i < 600 && !endpoint; i++) { endpoint = log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]; await sleep(50); }
  if (!endpoint) throw Error(`no DevTools endpoint: ${log.slice(-800)}`);
  const ws = new WebSocket(endpoint); await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(String(e.data)); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } });
  const send = async (method, params = {}, sessionId) => { const k = ++id; const p = new Promise(r => pending.set(k, r)); ws.send(JSON.stringify({ id: k, method, params, sessionId })); const m = await p; if (m.error) throw Error(`${method}: ${JSON.stringify(m.error)}`); return m.result; };
  report.tool = `Google Chrome ${(await send('Browser.getVersion')).product} headless via DevTools protocol`;
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  const evaluate = async (expression, contextId) => { const r = await send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true }, sessionId); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  const plan = [['phone', 390, 844, ['empty', 'loading', 'error', 'success']], ['tablet', 820, 1180, ['success']], ['desktop', 1280, 800, ['success', 'error']]];
  for (const [name, width, height, states] of plan) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: name === 'phone' }, sessionId);
    await send('Page.navigate', { url }, sessionId);
    let frame;
    for (let i = 0; i < 80 && !frame; i++) { await sleep(50); frame = (await send('Page.getFrameTree', {}, sessionId)).frameTree.childFrames?.[0]?.frame; }
    if (!frame) throw Error('mock frame not found');
    await sleep(300);
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'state-check' }, sessionId);
    for (const state of states) {
      const seen = await evaluate(`(() => { const s = document.getElementById('state'); s.value = ${JSON.stringify(state)}; s.dispatchEvent(new Event('change', { bubbles: true })); const v = [...document.querySelectorAll('[data-when]')].filter(el => !el.hidden).map(el => el.dataset.when); return { visible: v, announced: document.getElementById('announce').textContent, overflowX: document.documentElement.scrollWidth > innerWidth, width: innerWidth }; })()`, executionContextId);
      await sleep(150);
      const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const file = path.join(outDir, `${name}-${state}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      report.checks.push({ viewport: { name, width, height }, page: 'index.html', state, ...seen, passed: seen.visible.length === 1 && seen.visible[0] === state && !seen.overflowX, screenshot: file });
    }
  }
  // Keyboard: real key events (Input.dispatchKeyEvent), focus read back from the mock frame.
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  let frame;
  for (let i = 0; i < 80 && !frame; i++) { await sleep(50); frame = (await send('Page.getFrameTree', {}, sessionId)).frameTree.childFrames?.[0]?.frame; }
  await sleep(300);
  const { executionContextId: kctx } = await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'keyboard-check' }, sessionId);
  const key = async (k, code, keyCode) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode, ...(k === 'Enter' ? { text: '\r' } : {}) }, sessionId); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode }, sessionId); await sleep(60); };
  const focused = () => evaluate(`(() => { const a = document.activeElement; return a ? (a.getAttribute('aria-label') || a.textContent || a.tagName).trim().slice(0, 40) + '|' + a.tagName + '|' + (a.closest('[role=dialog]') ? 'dialog' : 'page') + '|' + getComputedStyle(a).outlineStyle : null; })()`, kctx);
  const tabPath = [];
  let opener = null;
  for (let i = 0; i < 14; i++) { await key('Tab', 'Tab', 9); const f = await focused(); tabPath.push(f); if (f && f.startsWith('Re-run|BUTTON')) { opener = f; break; } }
  const before = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  await key('Enter', 'Enter', 13); await sleep(150);
  const inDialog = await focused();
  const open = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  await key('Escape', 'Escape', 27); await sleep(150);
  const after = await focused();
  const closed = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  for (const [n, sh] of [['keyboard-focus', before], ['keyboard-dialog', open], ['keyboard-returned', closed]]) fs.writeFileSync(path_join(outDir, `${n}.png`), Buffer.from(sh.data, 'base64'));
  report.keyboard = { tabPath, opener, inDialog, afterEscape: after, passed: Boolean(opener && inDialog?.includes('|dialog|') && after === opener && !tabPath.some(p => p?.endsWith('|none') && !p.includes('|BODY|'))), screenshots: ['keyboard-focus', 'keyboard-dialog', 'keyboard-returned'].map(n => path_join(outDir, `${n}.png`)) };
  ws.close();
} finally {
  child.kill(); await new Promise(r => child.once('exit', r));
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
