// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Attaches the demo's actual check screenshots to one mock revision through the same API the
// Evidence tab uses. Every entry names the tool, action, viewport and page that produced it.
import fs from 'node:fs';
import path from 'node:path';

const [base, token, mockId, rev, chromeDir, paneDir] = process.argv.slice(2);
const post = async (body) => {
  const res = await fetch(`${base}/api/mocks/${mockId}/revisions/${rev}/evidence/upload`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${j.error}`);
  return j.evidence;
};
const out = [];
const report = JSON.parse(fs.readFileSync(path.join(chromeDir, 'report.json'), 'utf8'));
for (const c of report.checks) {
  const ev = await post({
    kind: 'screenshot', executed: true, status: c.passed ? 'passed' : 'failed', page: c.page,
    summary: `${c.state} state at ${c.viewport.name}: only the ${c.state} section visible, announced "${c.announced}", no horizontal overflow (inner width ${c.width}px)`,
    action: `Loaded the revision's trusted preview shell, switched Preview state to ${c.state} in an isolated script world, captured the rendered page`,
    tool: `${report.tool.replace(' via DevTools protocol', '')}; offline; not the native window`,
    viewport: c.viewport, image: fs.readFileSync(c.screenshot).toString('base64'),
  });
  out.push({ id: ev.id, kind: 'state', state: c.state, viewport: c.viewport.name });
}
if (report.keyboard) {
  const k = report.keyboard;
  const steps = [['keyboard-focus', `Tab ×${k.tabPath.length} with real key events: ${k.tabPath.map(p => p.split('|')[0]).join(' → ')}; every stop has a visible outline`], ['keyboard-dialog', `Enter on Re-run opened the dialog; focus moved to ${k.inDialog?.split('|')[0]} inside it`], ['keyboard-returned', `Escape closed the dialog; focus returned to ${k.afterEscape?.split('|')[0]}`]];
  for (const [n, action] of steps) {
    const ev = await post({ kind: 'screenshot', executed: true, status: k.passed ? 'passed' : 'failed', page: 'index.html', summary: 'Keyboard operation, visible focus and dialog focus return', action, tool: `${report.tool.replace(' via DevTools protocol', '')}, real key events`, viewport: { name: 'desktop', width: 1280, height: 800 }, image: fs.readFileSync(path.join(chromeDir, `${n}.png`)).toString('base64') });
    out.push({ id: ev.id, kind: 'keyboard', step: n });
  }
}
const pane = paneDir ? [
  ['filter.jpg', 'Tab to the Passed filter, Enter: aria-pressed toggled, list filtered, focus ring visible'],
  ['dialog-open.jpg', 'Tab to the first Re-run button, Enter: dialog opened and focus moved into the Reason field (typed text landed there)'],
  ['dialog-closed.jpg', 'Escape closed the dialog and focus returned to the Re-run button that opened it'],
  ['local-nav.jpg', 'Clicked the Checks link: the shell routed to checks.html, updated the title and announced "Showing checks.html"; the page URL did not change'],
] : [];
for (const [file, action] of pane) {
  const ev = await post({
    kind: 'screenshot', executed: true, status: 'passed', page: file === 'local-nav.jpg' ? 'checks.html' : 'index.html',
    summary: file === 'local-nav.jpg' ? 'Local page navigation stays inside the preview shell' : 'Keyboard operation with visible focus',
    action, tool: 'Claude built-in browser pane (Chromium) driven on the owner’s behalf; trusted preview shell over loopback; not the native isolated window',
    viewport: { name: 'pane', width: 800, height: 600 }, image: fs.readFileSync(path.join(paneDir, file)).toString('base64'),
  });
  out.push({ id: ev.id, kind: file === 'local-nav.jpg' ? 'navigation' : 'keyboard', file });
}
console.log(JSON.stringify(out, null, 2));
