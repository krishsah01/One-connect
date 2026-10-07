#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Stand-in for the GitHub CLI covering the `gh issue|label|repo` calls the tracker adapter makes.
// State lives in $FAKE_GH_STATE (JSON). Records every call in state.calls for assertions.
import fs from 'node:fs';
const file = process.env.FAKE_GH_STATE;
const st = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { n: 0, issues: {}, labels: [], comments: {}, calls: [] };
const a = process.argv.slice(2);
st.calls.push(a.slice(0, 2).join(' '));
const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const all = (k) => a.flatMap((x, i) => (x === k ? [a[i + 1]] : []));
const stdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };
const save = () => fs.writeFileSync(file, JSON.stringify(st));
const view = (i) => ({ number: i.number, title: i.title, body: i.body, labels: i.labels.map((name) => ({ name })), state: i.state, stateReason: i.stateReason ?? null, updatedAt: i.updatedAt, url: `https://github.com/o/r/issues/${i.number}` });
const now = () => new Date().toISOString();
const [g, cmd] = a;
if (process.env.FAKE_GH_FAIL) { console.error('HTTP 502: Bad Gateway'); process.exit(1); }
if (g === 'repo' && cmd === 'view') { console.log('{"name":"r"}'); }
else if (g === 'label' && cmd === 'create') { if (!st.labels.includes(a[2])) st.labels.push(a[2]); }
else if (g === 'issue' && cmd === 'create') {
  for (const l of all('--label')) if (!st.labels.includes(l)) { console.error(`could not add label: '${l}' not found`); process.exit(1); }
  const n = ++st.n; st.issues[n] = { number: n, title: opt('--title'), body: stdin(), labels: all('--label'), state: 'OPEN', updatedAt: now() };
  console.log(`https://github.com/o/r/issues/${n}`);
} else if (g === 'issue' && cmd === 'view') { const i = st.issues[a[2]]; if (!i) { console.error('not found'); process.exit(1); } console.log(JSON.stringify(view(i))); }
else if (g === 'issue' && cmd === 'list') { console.log(JSON.stringify(Object.values(st.issues).map(view))); }
else if (g === 'issue' && cmd === 'edit') {
  const i = st.issues[a[2]];
  for (const l of all('--add-label')) { if (!st.labels.includes(l)) { console.error(`'${l}' not found`); process.exit(1); } if (!i.labels.includes(l)) i.labels.push(l); }
  for (const l of (opt('--remove-label') ?? '').split(',').filter(Boolean)) i.labels = i.labels.filter((x) => x !== l);
  i.updatedAt = now();
} else if (g === 'issue' && cmd === 'close') { const i = st.issues[a[2]]; i.state = 'CLOSED'; i.stateReason = opt('--reason') === 'not planned' ? 'NOT_PLANNED' : 'COMPLETED'; i.updatedAt = now(); }
else if (g === 'issue' && cmd === 'reopen') { const i = st.issues[a[2]]; i.state = 'OPEN'; i.stateReason = null; i.updatedAt = now(); }
else if (g === 'issue' && cmd === 'comment') { (st.comments[a[2]] ??= []).push(stdin()); }
else { console.error(`fake gh: unsupported ${a.join(' ')}`); process.exit(2); }
save();
