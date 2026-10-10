// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { mockPreviewShell } from '@acc/core';
import { tmpDir } from './helpers.ts';
const binary = process.env.ACC_MOCK_TEST_WEBKIT;
it.skipIf(!binary)('WebKit disables peer connections in fresh realms and blocks hostile handlers/navigation/network while preserving DOM interaction', async () => {
  const hits: string[] = [];
  const server = http.createServer((req, res) => { hits.push(req.url ?? ''); res.end('ESCAPED'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const document = `<button id="interactive" onclick="document.body.dataset.clicked='yes'">Toggle state</button><a id="remote" href="${origin}/anchor">Remote anchor</a><button id="evil" onclick="location[String.fromCharCode(104,114,101,102)]='${origin}/event'">Hostile handler</button><form id="form" action="${origin}/form"></form><script>
(async()=>{const proof={}; document.getElementById('interactive').click();proof.interactive=document.body.dataset.clicked==='yes';
try{parent.document.body.dataset.pwned='yes';proof.parentDenied=false}catch(e){proof.parentDenied=true}
try{top.__TAURI_INTERNALS__.invoke('daemon_request');proof.parentIPC=false}catch(e){proof.parentIPC=true}
proof.rtcUnavailable=typeof RTCPeerConnection==='undefined'&&typeof webkitRTCPeerConnection==='undefined';
const nested=document.createElement('iframe');nested.srcdoc='<script>parent.postMessage({rtcRealm:typeof RTCPeerConnection},"*")<\\/script>';
proof.freshRealm=false;window.addEventListener('message',e=>{if(e.source===nested.contentWindow)proof.freshRealm=e.data.rtcRealm==='undefined'});document.body.append(nested);
try{await fetch('${origin}/fetch');proof.fetchDenied=false}catch(e){proof.fetchDenied=true}
new Image().src='${origin}/image';document.body.style.backgroundImage='url(${origin}/css)';
try{const w=new WebSocket('${origin.replace('http:', 'ws:')}/socket');w.onerror=()=>proof.socketDenied=true}catch(e){proof.socketDenied=true}
document.getElementById('remote').click();document.getElementById('evil').click();
try{location.assign('${origin}/assign')}catch(e){}try{location.replace('${origin}/replace')}catch(e){}
try{window.open('${origin}/popup')}catch(e){}try{document.getElementById('form').submit()}catch(e){}
setTimeout(()=>parent.postMessage({proof},'*'),800);
})();</script>`;
  // The test transport lives in the trusted shell; it forwards proof messages, not executable code.
  let shell = mockPreviewShell(document);
  shell = shell.replace('<script>\n', `<script>window.addEventListener('message',e=>{if(e.source===document.getElementById('mock').contentWindow&&e.data?.proof)window.postMessage({proof:e.data.proof},'*')});\n`);
  const file = path.join(tmpDir('webkit-proof'), 'shell.html'); fs.writeFileSync(file, shell);
  const native = fs.readFileSync(path.resolve(import.meta.dirname, '../../desktop/src-tauri/src/mock_preview.rs'), 'utf8');
  const csp = native.match(/pub const CSP: &str = "([^"]+)"/)![1];
  const rules = native.match(/pub const NETWORK_RULES: &str = r#"([\s\S]*?)"#;/)![1];
  try {
    const result = await promisify(execFile)(binary!, [file, csp, rules], { cwd: path.resolve(import.meta.dirname, '../../..'), timeout: 20_000, maxBuffer: 128 * 1024 });
    const proof = JSON.parse(result.stdout.trim());
    expect(proof).toMatchObject({ interactive: true, parentDenied: true, parentIPC: true, rtcUnavailable: true, freshRealm: true, fetchDenied: true, socketDenied: true });
    expect(hits).toEqual([]);
  } finally { await new Promise<void>(r => server.close(() => r())); }
}, 25_000);
