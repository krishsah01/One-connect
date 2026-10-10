#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// A scripted stand-in for vendor CLIs (claude / codex / cursor-agent) used by tests and the demo.
// It speaks each vendor's real headless output format, runs REAL commands in its working
// directory (tests, git commit) and reports their actual results, so the whole pipeline
// (streaming, evidence verification, handoff parsing, MCP, failures) is exercised for free.
//
// Scenario comes from a marker in the prompt, e.g. "[fake:network-fail]", or FAKE_SCENARIO:
//   success (default) | slow | network-fail | usage-limit | ask-human | hang | no-handoff | out-of-scope | auth-expired | break-tests
// Review prompts: review-approve (default) | review-changes | review-handoff-approve
import { execFileSync, execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const vendor = process.env.FAKE_VENDOR ?? 'claude';
const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STEP = Number(process.env.FAKE_STEP_MS ?? 30);

// ---- probe subcommands --------------------------------------------------------------------
if (args.includes('--version')) {
  console.log(vendor === 'codex' ? 'codex-cli 9.9.0' : vendor === 'cursor' ? '2099.01.01-fake' : '9.9.0 (Claude Code)');
  process.exit(0);
}
if (vendor === 'claude' && args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: process.env.FAKE_LOGGED_OUT !== '1', authMethod: process.env.FAKE_AUTH_METHOD ?? 'claude.ai', apiProvider: 'firstParty' }, null, 2));
  process.exit(0);
}
if (vendor === 'codex' && args[0] === 'login' && args[1] === 'status') {
  console.error(process.env.FAKE_LOGGED_OUT === '1' ? 'Not logged in' : process.env.FAKE_AUTH_METHOD === 'api' ? 'Logged in using an API key - sk-***' : 'Logged in using ChatGPT');
  process.exit(process.env.FAKE_LOGGED_OUT === '1' ? 1 : 0);
}
if (vendor === 'codex' && args[0] === 'debug' && args[1] === 'models') {
  const m = (slug, priority, visibility = 'list') => ({ slug, display_name: slug.toUpperCase(), priority, visibility, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }], upgrade: null });
  console.log(JSON.stringify({ models: [m('gpt-6-astra', 2), m('gpt-reserve', 4, 'hide'), m('gpt-5.6-sol', 5), m('gpt-5.6-terra', 8)] }));
  process.exit(0);
}
if (vendor === 'cursor' && (args[0] === 'status' || args[0] === 'whoami')) {
  console.log(process.env.FAKE_LOGGED_OUT === '1' ? 'Not logged in' : '✓ Logged in as fake@example.com');
  process.exit(0);
}
if (vendor === 'cursor' && args[0] === 'about') {
  console.log('About Cursor CLI\n\nCLI Version         2099.01.01-fake\nSubscription Tier   Pro\n');
  process.exit(0);
}
if (vendor === 'cursor' && (args[0] === 'models' || args.includes('--list-models'))) {
  console.log('Available models\n\nauto - Auto (default)\nclaude-opus-5-thinking-high - Claude Opus 5 Thinking\nclaude-opus-4-8-thinking-high - Claude Opus 4.8 Thinking\ngpt-5.6-sol-high - GPT-5.6 Sol High\ngemini-3.7-flash-high - Gemini 3.7 Flash\n');
  process.exit(0);
}

// ---- run mode -----------------------------------------------------------------------------
function argAfter(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function readPrompt() {
  if (vendor === 'cursor') return args[args.length - 1] ?? '';
  const chunks = [];
  if (vendor === 'claude') {
    // stream-json input: first line is the user message; keep stdin open (we never read more).
    return await new Promise((resolve) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => {
        buf += d;
        const i = buf.indexOf('\n');
        if (i >= 0) {
          const msg = JSON.parse(buf.slice(0, i));
          resolve(msg.message.content.map((c) => c.text).join(''));
        }
      });
      process.stdin.on('end', () => resolve(buf));
    });
  }
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const cwd = vendor === 'cursor' ? (argAfter('--workspace') ?? process.cwd()) : vendor === 'codex' ? (argAfter('-C') ?? process.cwd()) : process.cwd();
const resumed = args.includes('--resume') || args.includes('resume');
// codex: `exec resume [OPTIONS] <SESSION_ID> -`; claude/cursor: `--resume <id>`.
const sessionId = argAfter('--resume') ?? (vendor === 'codex' && args.includes('resume') ? args[args.length - 2] : null) ?? `fake-${Date.now().toString(36)}`;

// Vendor-shaped event emitters.
const emit = {
  init(model) {
    if (vendor === 'claude') out({ type: 'system', subtype: 'init', session_id: sessionId, model, apiKeySource: process.env.FAKE_API_KEY_SOURCE ?? 'none', tools: ['Bash', 'Edit'] });
    else if (vendor === 'codex') {
      out({ type: 'thread.started', thread_id: sessionId });
      out({ type: 'turn.started' });
    } else out({ type: 'system', subtype: 'init', session_id: sessionId, model, apiKeySource: process.env.FAKE_API_KEY_SOURCE ?? 'login', cwd });
  },
  async say(text) {
    // Token streaming like the real CLIs: Claude stream_event deltas, Cursor partial assistant events.
    const chunks = text.match(/[\s\S]{1,12}/g) ?? [];
    const tokenMs = Number(process.env.FAKE_TOKEN_MS ?? 0);
    if (vendor === 'codex') return out({ type: 'item.completed', item: { id: `i${Math.random()}`, type: 'agent_message', text } });
    if (vendor === 'claude' && args.includes('--include-partial-messages')) {
      out({ type: 'stream_event', event: { type: 'message_start' }, session_id: sessionId });
      for (const c of chunks) {
        out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } }, session_id: sessionId });
        if (tokenMs) await sleep(tokenMs);
      }
    }
    if (vendor === 'cursor' && args.includes('--stream-partial-output')) {
      for (const c of chunks) {
        out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: c }] }, session_id: sessionId });
        if (tokenMs) await sleep(tokenMs);
      }
      return;
    }
    out({ type: 'assistant', message: { role: 'assistant', model: process.env.FAKE_SERVED_MODEL, content: [{ type: 'text', text }] }, session_id: sessionId });
  },
  command(id, command, exitCode, output) {
    if (vendor === 'claude') {
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: exitCode !== 0 }] } });
    } else if (vendor === 'codex') {
      out({ type: 'item.started', item: { id, type: 'command_execution', command, status: 'in_progress' } });
      out({ type: 'item.completed', item: { id, type: 'command_execution', command, aggregated_output: output, exit_code: exitCode, status: 'completed' } });
    } else {
      out({ type: 'tool_call', subtype: 'started', call_id: id, tool_call: { shellToolCall: { args: { command } } } });
      out({ type: 'tool_call', subtype: 'completed', call_id: id, tool_call: { shellToolCall: { args: { command }, result: exitCode === 0 ? { success: { exitCode, stdout: output, stderr: '' } } : { failure: { exitCode, stdout: output, stderr: '' } } } } });
    }
  },
  edit(id, file) {
    if (vendor === 'claude') {
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: path.join(cwd, file), content: '…' } }] } });
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'File created' }] } });
    } else if (vendor === 'codex') out({ type: 'item.completed', item: { id, type: 'file_change', changes: [{ path: path.join(cwd, file), kind: 'add' }], status: 'completed' } });
    else out({ type: 'tool_call', subtype: 'completed', call_id: id, tool_call: { writeToolCall: { args: { path: file }, result: { success: { path: file } } } } });
  },
  result(text, ok = true) {
    if (vendor === 'claude') out({ type: 'result', subtype: ok ? 'success' : 'error_during_execution', is_error: !ok, result: text, session_id: sessionId, usage: { input_tokens: 1200, output_tokens: 340 } });
    else if (vendor === 'codex') out(ok ? { type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 0, output_tokens: 340 } } : { type: 'turn.failed', error: { message: text } });
    else out({ type: 'result', subtype: ok ? 'success' : 'error', is_error: !ok, result: text, session_id: sessionId, duration_ms: 1000 });
  },
};

// Runs the project's configured shell command (like a real agent would), e.g. "node --test".
function sh(command) {
  try {
    return { code: 0, out: execSync(command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0' } }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

// Minimal MCP stdio client, used by the ask-human scenario to call the real acc MCP server.
function mcpServerConfig() {
  if (vendor === 'claude') {
    const f = argAfter('--mcp-config');
    return f ? JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers.acc : null;
  }
  if (vendor === 'codex') {
    const get = (k) => {
      const i = args.findIndex((a, j) => args[j - 1] === '-c' && a.startsWith(`mcp_servers.acc.${k}=`));
      return i >= 0 ? JSON.parse(args[i].slice(args[i].indexOf('=') + 1)) : null;
    };
    const command = get('command');
    return command ? { command, args: get('args') } : null;
  }
  const f = path.join(cwd, '.cursor', 'mcp.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers.acc : null;
}

async function mcpCall(tool, toolArgs) {
  const cfg = mcpServerConfig();
  if (!cfg) throw new Error('no acc MCP server configured');
  const child = spawn(cfg.command, cfg.args, { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-agent', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const res = await rpc('tools/call', { name: tool, arguments: toolArgs });
  child.kill();
  return JSON.parse(res.result.content[0].text);
}

const prompt = await readPrompt();
// Like a real vendor session, a resumed session remembers what it was doing.
const sessionsDir = path.join(os.tmpdir(), 'acc-fake-agent-sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
const remembered = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionsDir, sessionId), 'utf8'));
  } catch {
    return {};
  }
})();
// Review prompts carry the exact target SHA; they only honour review-* markers (default: approve),
// so an issue can script both its author ([fake:x]) and its reviewer ([fake:review-x]).
const targetSha = /Target SHA: ([0-9a-f]{40})/.exec(prompt)?.[1] ?? null;
const markers = [...prompt.matchAll(/\[fake:([\w-]+)\]/g)].map((m) => m[1]);
const marked = targetSha ? (markers.find((m) => m.startsWith('review-')) ?? 'review-approve') : markers.find((m) => !m.startsWith('review-'));
// Designer studio prompts select the labelled design fixtures when no explicit marker is present.
const studioScenario = /## Independent design review/.test(prompt) ? 'design-review' : /## Design deliverable \(Designer studio (?:generate|refine) job/.test(prompt) ? 'design-studio' : undefined;
const scenario = marked ?? (resumed ? remembered.scenario : undefined) ?? studioScenario ?? process.env.FAKE_SCENARIO ?? 'success';
const originalPrompt = resumed && remembered.prompt ? remembered.prompt : prompt;
fs.writeFileSync(path.join(sessionsDir, sessionId), JSON.stringify({ scenario, prompt: originalPrompt }));
const key = /Assignment \S+ for ([A-Z]+-\d+)/.exec(originalPrompt)?.[1] ?? 'WORK';
const testCmd = /- test: `([^`]+)`/.exec(originalPrompt)?.[1] ?? 'node --test';
const model = argAfter('--model') ?? argAfter('-m') ?? 'fake-model-1';
const branch = sh('git rev-parse --abbrev-ref HEAD').out.trim();

emit.init(vendor === 'claude' ? `claude-${model}-resolved` : model);
// Bring-your-own-model runs: report which connection reached us (never the key itself).
const providerKeys = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'].filter((k) => process.env[k]);
if (providerKeys.length || args.includes('--oss')) await emit.say(`connection: ${args.includes('--oss') ? `local (${argAfter('--local-provider')})` : providerKeys.join(', ')}; CODEX_HOME=${process.env.CODEX_HOME ? 'isolated' : 'default'}`);
await sleep(STEP);

if (scenario === 'auth-expired') {
  process.stderr.write('Error: Authentication failed: token has expired. Please run login.\n');
  process.exit(1);
}
if (scenario === 'overage' && vendor === 'claude') {
  // Included usage exhausted and the account's paid extra usage kicks in (real event shape).
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000, rateLimitType: 'five_hour', overageStatus: 'allowed', isUsingOverage: true, overageInUse: true, unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1900000000 }, seven_day: { utilization: 0.4, resetsAt: 1900500000 } } }, session_id: sessionId });
  await sleep(Number(process.env.FAKE_SLOW_MS ?? 3000));
}
if (scenario === 'usage-limit') {
  await emit.say('Starting on it.');
  process.stderr.write("You've hit your usage limit. Try again in 2h 0m.\n");
  process.exit(1);
}
if (scenario === 'hang') {
  await emit.say('Thinking…');
  await sleep(10 * 60_000);
  process.exit(0);
}

await emit.say(resumed ? 'Resuming where I left off.' : `Working on ${key}.`);
const ls = sh('ls');
emit.command('c1', 'ls', ls.code, ls.out);
await sleep(STEP);

if (scenario === 'network-fail' || (scenario === 'network-fail-once' && !resumed)) {
  process.stderr.write('stream error: connection timed out while reading response (os error 60)\n');
  process.exit(1);
}

let answer = null;
if (scenario === 'ask-human') {
  const r = await mcpCall('ask_human', { question: `Should ${key} keep the old behaviour behind a flag?`, options: ['yes', 'no'] });
  answer = r.answer ?? 'no answer';
  await emit.say(`The owner answered: ${answer}`);
}

// Exercise the real stdio MCP bridge between two headless harnesses, without vendor calls.
if (scenario === 'team-sender' || scenario === 'team-receiver') {
  const team = await mcpCall('get_team', {});
  await emit.say(`Team context: ${team.agents.map(a => `${a.id} ${a.status}`).join(', ')}`);
  if (scenario === 'team-sender') await mcpCall('send_team_message', { recipients:['codex'],subject:'Coordinate the notes contract',body:'Please confirm the shared notes contract before I finish.',kind:'question' });
  let found = null;
  for (let i=0;i<45;i++) {
    const inbox = await mcpCall('read_messages', {});
    found = inbox.messages.find(m => m.kind === (scenario === 'team-sender' ? 'reply' : 'question'));
    if (found) break;
    await sleep(100);
  }
  if (!found) throw new Error('peer did not respond through the One Connect inbox');
  await mcpCall('ack_team_message', { messageId:found.id });
  if (scenario === 'team-receiver') await mcpCall('send_team_message', { recipients:[found.sender.id],subject:'Shared notes contract confirmed',body:'Use Markdown headings, record checks, and keep separate issue files.',kind:'reply',replyTo:found.id });
  await emit.say(`Peer message received and acknowledged: ${found.subject}`);
}

// Read-only reviews: look at the exact SHA, report a typed verdict, never commit.
if (scenario.startsWith('review-')) {
  const head = sh('git rev-parse HEAD').out.trim();
  emit.command('r1', 'git rev-parse HEAD', 0, head);
  const approve = scenario !== 'review-changes';
  const finding = approve ? { severity: 'minor', title: `Mention the issue key in notes/${key}.md`, path: `notes/${key}.md`, line: 1 } : { severity: 'major', title: `notes/${key}.md does not explain the change`, body: 'Describe what changed and why.', path: `notes/${key}.md`, line: 3 };
  if (scenario !== 'review-handoff-approve') {
    const r = await mcpCall('submit_review', { reviewed_sha: targetSha, verdict: approve ? 'approve' : 'request_changes', summary: approve ? `Reviewed ${head.slice(0, 12)}; acceptance met.` : `Reviewed ${head.slice(0, 12)}; needs changes.`, findings: [finding] });
    await emit.say(`submit_review: ${JSON.stringify(r)}`);
  }
  const text = `Reviewed the change at ${head}.\n\n### Handoff\nDone: reviewed ${head.slice(0, 12)}\nEvidence:\n- \`git rev-parse HEAD\` → ${head.slice(0, 12)}\nCommit: none\nBlocked: none\nNext: ${approve ? 'merge after the owner decides' : 'address the findings'}\nVerdict: ${approve ? 'approve' : 'request changes'}\nFindings:\n- ${scenario === 'review-handoff-approve' ? 'nit' : finding.severity}: ${finding.path}:${finding.line} - ${finding.title}`;
  await emit.say(text);
  emit.result(text, true);
  process.exit(0);
}

// Designer studio fixture (labelled, no model): load one skill on demand, pull the frozen contract,
// ask the human a real question through One Connect, write a multi-page accessible mock with local
// fixture data, commit, and register it with a structured handoff. Follow-ups refine the same folder.
if (scenario === 'design-studio') {
  const dir = /`(design\/[a-z0-9][a-z0-9-]*)\/`/.exec(originalPrompt)?.[1] ?? `design/${key.toLowerCase()}`;
  const pagesLine = /- Pages: (.+)\. Link pages/.exec(originalPrompt)?.[1] ?? '`index.html` (Overview)';
  const refine = (resumed && /Refinement request from the Designer studio/.test(prompt) ? (/Request: (.+)/.exec(prompt)?.[1] ?? 'refine') : null)
    ?? (/Designer studio refine job/.test(originalPrompt) ? (/- Request: (.+)/.exec(originalPrompt)?.[1] ?? 'refine') : null);
  const existing = fs.existsSync(path.join(cwd, dir)) ? fs.readdirSync(path.join(cwd, dir)).filter((f) => f.endsWith('.html')).sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b))) : [];
  const listedPages = [...pagesLine.matchAll(/`([a-z0-9-]+\.html)` \(([^)]+)\)/g)].map((m) => ({ path: m[1], name: m[2] }));
  // A refinement keeps the pages it starts from; their names come from each page's <h1>.
  const pages = refine && existing.length ? existing.map((f) => ({ path: f, name: /<h1>([^<]+)<\/h1>/.exec(fs.readFileSync(path.join(cwd, dir, f), 'utf8'))?.[1] ?? f.replace('.html', '') })) : listedPages;
  const states = (/covers (.+?) states/.exec(originalPrompt)?.[1] ?? 'empty, loading, error, success').split(/,\s*/).filter(Boolean);
  const listed = await mcpCall('list_skills', {});
  const pick = listed.skills.find((x) => x.id === 'responsive-mocks') ?? listed.skills[0];
  if (pick && !refine) { const page = await mcpCall('get_skill', { id: pick.id, budget: 2000 }); await emit.say(`Loaded skill ${pick.id}@${pick.version} on demand (${page.content.length} chars).`); }
  const design = await mcpCall('get_design_system', {});
  const designHash = design.design?.revision?.hash;
  await emit.say(`Using design contract v${design.design?.revision?.version ?? '?'} (${String(designHash ?? 'none').slice(0, 12)}). Fixture design agent: no model is called.`);
  let answer = null;
  if (!refine) {
    const r = await mcpCall('ask_human', { question: `Should ${pages[0]?.name ?? 'the first screen'} list failures before passing items?`, options: ['yes', 'no'] });
    answer = r.answer ?? 'no answer';
    await emit.say(`The owner answered: ${answer}`);
  }
  const abs = path.join(cwd, dir);
  fs.mkdirSync(abs, { recursive: true });
  const nav = (current) => `<nav aria-label="Mock pages"><ul>${pages.map((p) => `<li><a href="${p.path}"${p.path === current ? ' aria-current="page"' : ''}>${p.name}</a></li>`).join('')}</ul></nav>`;
  const checks = ['Unit tests:passed:42s', 'Integration tests:failed:3m 12s', 'Accessibility scan of the settings, billing and team pages:failed:1m 04s', 'Bundle size:passed:18s', 'Type check:passed:51s', 'Visual regression:passed:2m 40s'].map((c) => { const [name, status, time] = c.split(':'); return { name, status, time }; });
  // Without scripts (the dashboard's static render) the success state and its rows are visible.
  const hid = (st) => (st === 'success' ? '' : ' hidden');
  const rowsHtml = checks.map((c) => `<tr><td>${c.name}</td><td><span class="badge ${c.status}">${c.status === 'failed' ? '× Failed' : '✓ Passed'}</span></td><td class="num">${c.time}</td><td><button type="button" class="secondary" data-open-dialog>Re-run</button></td></tr>`).join('');
  const stateSections = (p, i) => states.map((st) => {
    if (st === 'empty') return `<section data-when="empty"${hid('empty')}><h2>Nothing here yet</h2><p class="muted">${p.name} shows checks after the first scheduled run.</p><button type="button" class="primary" data-open-dialog>Schedule a run</button></section>`;
    if (st === 'loading') return `<section data-when="loading"${hid('loading')} aria-busy="true"><h2>Loading ${p.name.toLowerCase()}…</h2><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton short"></div></section>`;
    if (st === 'error') return `<section data-when="error"${hid('error')} role="alert"><h2 class="danger">${p.name} could not load</h2><p>Your filters are kept. Check the connection and try again.</p><button type="button" class="secondary" data-retry>Try again</button></section>`;
    if (st === 'success') return `<section data-when="success"${hid('success')}>${i === 0 ? `<div class="toolbar" role="group" aria-label="Filter by status"><button type="button" aria-pressed="true" data-filter="all">All</button><button type="button" aria-pressed="false" data-filter="failed">Failed</button><button type="button" aria-pressed="false" data-filter="passed">Passed</button></div><table><caption class="visually-hidden">Release checks</caption><thead><tr><th scope="col">Check</th><th scope="col">Status</th><th scope="col" class="num">Duration</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead><tbody id="rows">${rowsHtml}</tbody></table>` : `<div class="card"><h2>${p.name}</h2><p>${p.name} for the selected check, built from local fixture data.</p><button type="button" class="primary" data-open-dialog>Re-run check</button></div>`}</section>`;
    return `<section data-when="${st}"${hid(st)}><h2>${st[0].toUpperCase() + st.slice(1)} state</h2><p class="muted">Shown when ${p.name.toLowerCase()} is ${st}.</p></section>`;
  }).join('\n');
  const html = (p, i) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${p.name} · ${key} mock</title><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="styles.css"></head>
<body><a class="skip" href="#main">Skip to content</a><header>${nav(p.path)}</header>
<main id="main" tabindex="-1"><div class="heading"><h1>${p.name}</h1><label>Preview state <select id="state">${states.map((st) => `<option value="${st}"${st === 'success' ? ' selected' : ''}>${st}</option>`).join('')}</select></label></div>
${refine ? `<p class="notice" role="note">Refined: ${refine.replace(/[<&>"]/g, '')}</p>` : ''}
${stateSections(p, i)}
<p id="announce" class="visually-hidden" role="status" aria-live="polite"></p></main>
<div class="backdrop" hidden><div role="dialog" aria-modal="true" aria-labelledby="dlg-title" id="dialog"><h2 id="dlg-title">Re-run this check?</h2><p>It runs on the integration branch. This mock simulates the result; nothing is sent.</p><form id="rerun"><label>Reason <input name="reason" required></label><div class="actions"><button type="submit" class="primary">Re-run</button><button type="button" class="secondary" data-close>Cancel</button></div></form></div></div>
<script src="data.js"></script><script src="app.js"></script></body></html>
`;
  fs.writeFileSync(path.join(abs, 'tokens.css'), design.design?.css ?? '');
  fs.writeFileSync(path.join(abs, 'styles.css'), `*{box-sizing:border-box}body{margin:0;background:var(--design-background);color:var(--design-text);font:var(--design-size-body,14px)/var(--design-leading,1.5) var(--design-font)}
header{background:var(--design-surface);border-bottom:var(--design-border-width,1px) solid var(--design-border)}nav ul{display:flex;flex-wrap:wrap;gap:var(--design-space-2,8px);list-style:none;margin:0 auto;padding:var(--design-space-2,8px) var(--design-gutter,24px);max-width:var(--design-max-width,1200px)}
nav a{display:inline-flex;align-items:center;min-height:var(--design-target,44px);padding:0 var(--design-space-3,12px);color:var(--design-muted);text-decoration:none;border-radius:var(--design-radius)}nav a[aria-current=page]{color:var(--design-text);background:var(--design-subtle,var(--design-background));font-weight:600}
main{max-width:var(--design-max-width,1200px);margin:0 auto;padding:var(--design-space-5,24px) var(--design-gutter,24px);display:grid;gap:var(--design-space-4,16px)}.heading{display:flex;flex-wrap:wrap;gap:var(--design-space-3,12px);justify-content:space-between;align-items:end}
h1{font-family:var(--design-font-display,var(--design-font));font-size:var(--design-size-h1,24px);line-height:var(--design-leading-heading,1.25);margin:0}h2{font-size:var(--design-size-h3,17px);margin:0 0 var(--design-space-2,8px)}
.muted{color:var(--design-muted)}.danger{color:var(--design-danger,var(--design-text))}.card,section{background:var(--design-surface);border:var(--design-border-width,1px) solid var(--design-border);border-radius:var(--design-radius);padding:var(--design-space-4,16px);box-shadow:var(--design-shadow-1,none)}
button,select,input{font:inherit;min-height:var(--design-control-height,40px);border-radius:var(--design-radius)}button{min-width:var(--design-target,44px);padding:0 var(--design-space-4,16px);border:var(--design-border-width,1px) solid transparent;cursor:pointer}
select,input{border:var(--design-border-width,1px) solid var(--design-muted);background:var(--design-surface);color:var(--design-text);padding:0 var(--design-space-2,8px)}.primary{background:var(--design-accent);color:var(--design-accent-text)}.secondary,.toolbar button{background:var(--design-subtle,var(--design-background));color:var(--design-text)}
.toolbar{display:flex;gap:var(--design-space-2,8px);margin-bottom:var(--design-space-3,12px)}.toolbar [aria-pressed=true]{background:var(--design-accent);color:var(--design-accent-text)}
:focus-visible{outline:var(--design-focus-width,2px) solid var(--design-focus,var(--design-accent));outline-offset:2px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:var(--design-space-2,8px);border-bottom:var(--design-border-width,1px) solid var(--design-border)}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.badge{font-weight:600}.badge.failed{color:var(--design-danger,var(--design-text))}.badge.passed{color:var(--design-success,var(--design-text))}.skeleton{height:12px;margin:var(--design-space-2,8px) 0;border-radius:var(--design-radius-sm,4px);background:var(--design-subtle,var(--design-border))}.skeleton.short{width:60%}
.notice{margin:0;padding:var(--design-space-2,8px) var(--design-space-3,12px);border-radius:var(--design-radius);background:var(--design-subtle,var(--design-background))}
.backdrop{position:fixed;inset:0;display:grid;place-items:center;background:color-mix(in srgb,var(--design-text) 45%,transparent);padding:var(--design-space-4,16px)}.backdrop[hidden]{display:none}[role=dialog]{background:var(--design-surface);border-radius:var(--design-radius);box-shadow:var(--design-shadow-2,none);padding:var(--design-space-5,24px);max-width:420px;width:100%;display:grid;gap:var(--design-space-3,12px)}
.actions{display:flex;gap:var(--design-space-2,8px);margin-top:var(--design-space-3,12px)}label{display:grid;gap:var(--design-space-1,4px);font-weight:600}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;left:-999px}.skip:focus{left:var(--design-space-2,8px);top:var(--design-space-2,8px);background:var(--design-surface);padding:var(--design-space-2,8px)}
@media (max-width:640px){thead{display:none}tr{display:grid;padding:var(--design-space-2,8px) 0;border-bottom:var(--design-border-width,1px) solid var(--design-border)}td{border:0;padding:2px 0}td.num{text-align:left}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`);
  fs.writeFileSync(path.join(abs, 'data.js'), `window.MOCK_DATA=${JSON.stringify({ checks, failuresFirst: answer === 'yes' })};\n`);
  fs.writeFileSync(path.join(abs, 'app.js'), `(()=>{const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];const say=t=>{$('#announce').textContent=t};
const show=st=>{$$('[data-when]').forEach(el=>{el.hidden=el.dataset.when!==st});say('Showing the '+st+' state')};const sel=$('#state');sel.addEventListener('change',()=>show(sel.value));show(sel.value);
const data=window.MOCK_DATA||{checks:[]};let filter='all';const rows=$('#rows');
const render=()=>{if(!rows)return;const list=data.checks.filter(c=>filter==='all'||c.status===filter).sort((a,b)=>data.failuresFirst?(a.status==='failed'?-1:1)-(b.status==='failed'?-1:1):0);rows.replaceChildren(...list.map(c=>{const tr=document.createElement('tr');tr.innerHTML='<td></td><td><span class="badge '+c.status+'">'+(c.status==='failed'?'× Failed':'✓ Passed')+'</span></td><td class="num"></td><td><button type="button" class="secondary" data-open-dialog>Re-run</button></td>';tr.children[0].textContent=c.name;tr.children[2].textContent=c.time;return tr}));say(list.length+' checks shown')};
$$('[data-filter]').forEach(b=>b.addEventListener('click',()=>{filter=b.dataset.filter;$$('[data-filter]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));render()}));render();
const back=$('.backdrop'),dlg=$('#dialog');let opener=null;
const open=t=>{opener=t;back.hidden=false;dlg.querySelector('input').focus()};const close=()=>{back.hidden=true;if(opener)opener.focus()};
document.addEventListener('click',e=>{const t=e.target.closest('[data-open-dialog]');if(t)open(t);if(e.target.closest('[data-close]'))close();if(e.target.closest('[data-retry]')){sel.value='success';show('success')}});
dlg.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close()}if(e.key==='Tab'){const f=[...dlg.querySelectorAll('input,button')];const i=f.indexOf(document.activeElement);if(e.shiftKey&&i===0){e.preventDefault();f.at(-1).focus()}else if(!e.shiftKey&&i===f.length-1){e.preventDefault();f[0].focus()}}});
$('#rerun').addEventListener('submit',e=>{e.preventDefault();close();say('Re-run queued (simulated; nothing was sent)')});})();\n`);
  pages.forEach((p, i) => fs.writeFileSync(path.join(abs, p.path), html(p, i)));
  emit.edit('e2', `${dir}/index.html`);
  const t2 = sh(testCmd);
  emit.command('c2', testCmd, t2.code, t2.out);
  const committed2 = gitRun('add', '-A').code === 0 ? gitRun('-c', 'user.name=fake-agent', '-c', 'user.email=fake@example.com', 'commit', '-q', '-m', `${key}: ${refine ? 'refine' : 'add'} ${dir} mock (${vendor} fixture)`) : { code: 1, out: '' };
  const head2 = gitRun('rev-parse', 'HEAD');
  emit.command('c3', 'git add -A && git commit', committed2.code, committed2.out + head2.out);
  const reg = await mcpCall('register_design_mock', { dir, handoff: { summary: refine ? `Refined ${dir}: ${refine}` : `${pages.length}-page interactive mock with a state switcher, status filters and a re-run dialog.`, pages: pages.map((p) => ({ path: p.path, title: p.name })), states, interactions: ['Preview state select switches every state', 'Status filter buttons (aria-pressed)', 'Re-run dialog: focus moves in, Tab is trapped, Escape closes and returns focus', 'Form submit is simulated with preventDefault'], checks: [{ name: 'project tests', status: t2.code === 0 ? 'passed' : 'failed', command: testCmd }, { name: 'browser keyboard walkthrough', status: 'not_run' }], limitations: ['Fixture data only', 'No browser check was run by this fixture agent'], questions: [], designHash } });
  await sleep(300);
  await mcpCall('record_mock_evidence', { artifactId: reg.artifactId, revision: reg.revision, kind: 'command', summary: 'project tests', executed: true, status: 'passed', command: testCmd, exitCode: t2.code, tool: 'node' });
  await mcpCall('record_mock_evidence', { artifactId: reg.artifactId, revision: reg.revision, kind: 'viewport', summary: 'phone layout not checked in a browser by the fixture', executed: false, status: 'not_run', viewport: { name: 'phone', width: 390, height: 844 } });
  await emit.say(`Registered ${dir} as revision ${reg.revision} (${reg.gate}).`);
  const text = `${refine ? 'Refined' : 'Created'} the ${dir} mock.\n\n### Handoff\nDone: ${refine ? 'refined' : 'created'} ${dir}/ (${pages.map((p) => p.path).join(', ')}) and registered revision ${reg.revision}\nEvidence:\n- \`${testCmd}\` → exit ${t2.code}\nCommit: ${head2.out.trim().slice(0, 12)} on ${branch}\nBlocked: none\nNext: review the mock in One Connect`;
  await emit.say(text);
  emit.result(text, true);
  process.exit(0);
}

// Independent design review fixture: reads the exact revision over MCP and submits a static review.
if (scenario === 'design-review') {
  const artifactId = /Review mock `([^`]+)`/.exec(prompt)?.[1];
  const revision = Number(/revision (\d+), content/.exec(prompt)?.[1]);
  const meta = await mcpCall('get_design_mock', { artifactId, revision });
  const page = await mcpCall('get_design_mock', { artifactId, revision, path: 'index.html', budget: 4000 });
  await emit.say(`Reviewed ${meta.files.length} files of revision ${meta.rev} (${String(meta.hash).slice(0, 12)}); index.html has ${page.content?.length ?? 0} characters. Fixture reviewer: static inspection only.`);
  const items = ['responsive', 'keyboard', 'contrast', 'states', 'tokens'].map((id) => ({ id, result: 'pass', basis: 'static', note: 'Static source inspection by the fixture reviewer.' }));
  const r = await mcpCall('submit_design_review', { artifactId, revision, verdict: 'approve', summary: 'Static review: tokens only, all listed states present, dialog handles Escape and focus return in source.', checklist: items });
  const text = `Submitted an independent static review of revision ${revision}.\n\n### Handoff\nDone: reviewed ${artifactId} revision ${revision} (${r.decision})\nEvidence:\n- get_design_mock → ${meta.files.length} files\nCommit: none\nBlocked: none\nNext: a human decides`;
  await emit.say(text);
  emit.result(text, true);
  process.exit(0);
}

if (scenario === 'slow') await sleep(Number(process.env.FAKE_SLOW_MS ?? 4000));

const file = scenario === 'out-of-scope' ? `outside-${key}.txt` : `notes/${key}.md`;
fs.mkdirSync(path.join(cwd, path.dirname(file)), { recursive: true });
fs.writeFileSync(path.join(cwd, file), `# ${key}\n\nDone by the fake ${vendor} agent.${answer ? `\nOwner said: ${answer}` : ''}\n`);
emit.edit('e1', file);
if (scenario === 'break-tests') {
  fs.writeFileSync(path.join(cwd, `notes/${key}.test.mjs`), "import test from 'node:test';\ntest('broken on purpose', () => { throw new Error('broken'); });\n");
  emit.edit('e2', `notes/${key}.test.mjs`);
}
await sleep(STEP);

const t = sh(testCmd);
emit.command('c2', testCmd, t.code, t.out);
const summary = /(?:#|ℹ) pass (\d+)[\s\S]*?(?:#|ℹ) fail (\d+)/.exec(t.out);
const result = summary ? `${summary[1]} passed, ${summary[2]} failed` : `exit ${t.code}`;
await sleep(STEP);

// git via argument arrays (no shell): the commit message never goes through a shell.
function gitRun(...gitArgs) {
  try {
    return { code: 0, out: execFileSync('git', gitArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}
// Design agent: load a frozen skill, pull the contract, write a self-contained mock under design/.
let mockDir = null;
if (scenario === 'design-mock') {
  const listed = await mcpCall('list_skills', {});
  const pick = listed.skills.find((s) => s.source === 'project') ?? listed.skills[0];
  if (pick) {
    const page = await mcpCall('get_skill', { id: pick.id });
    await emit.say(`Loaded skill ${pick.id}@${pick.version} (${page.content.length} chars)`);
  }
  const design = await mcpCall('get_design_system', {});
  mockDir = `design/${key.toLowerCase()}`;
  const abs = path.join(cwd, mockDir);
  fs.mkdirSync(abs, { recursive: true });
  fs.writeFileSync(path.join(abs, 'tokens.css'), design.design?.css ?? '');
  fs.writeFileSync(path.join(abs, 'styles.css'), 'body{margin:0;background:var(--design-background);color:var(--design-text);font-family:var(--design-font)}\n.card{background:var(--design-surface);border:1px solid var(--design-border);border-radius:var(--design-radius);padding:16px}\nbutton{background:var(--design-accent);color:var(--design-accent-text);min-height:44px}\n');
  fs.writeFileSync(path.join(abs, 'app.js'), "document.querySelector('button').addEventListener('click',()=>{document.querySelector('[role=status]').textContent='Saved';});\n");
  fs.writeFileSync(path.join(abs, 'index.html'), `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${key} mock</title><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="styles.css"></head>\n<body><main class="card"><h1>${key}</h1><p>Settings mock for review.</p><button type="button">Save</button><p role="status"></p></main><script src="app.js"></script></body></html>\n`);
  emit.edit('e2', `${mockDir}/index.html`);
}

const added = gitRun('add', '-A');
const committed = added.code === 0 ? gitRun('-c', 'user.name=fake-agent', '-c', 'user.email=fake@example.com', 'commit', '-q', '-m', `${key}: add notes (${vendor})`) : added;
const c = committed.code === 0 ? gitRun('rev-parse', 'HEAD') : committed;
emit.command('c3', 'git add -A && git commit', c.code, committed.out + c.out);
const sha = c.code === 0 ? c.out.trim().slice(0, 12) : 'none';
if (mockDir) {
  const reg = await mcpCall('register_design_mock', { dir: mockDir });
  await sleep(600);
  await mcpCall('record_mock_evidence', { artifactId: reg.artifactId, kind: 'command', summary: 'project tests', executed: true, status: 'passed', command: testCmd, exitCode: t.code });
  await mcpCall('record_mock_evidence', { artifactId: reg.artifactId, kind: 'viewport', summary: 'phone layout not checked in a browser', executed: false, status: 'passed', viewport: { name: 'phone', width: 390, height: 844 } });
  await emit.say(`Registered ${mockDir} as revision ${reg.revision} (${reg.gate})`);
}

const handoff = scenario === 'no-handoff' ? 'All done, I think.' : `I added the notes file and ran the tests.\n\n### Handoff\nDone: added ${file}\nEvidence:\n- \`${testCmd}\` → ${result}\nCommit: ${sha} on ${branch}\nBlocked: none\nNext: review the notes`;
await emit.say(handoff);
emit.result(handoff, true);
process.exit(0);
