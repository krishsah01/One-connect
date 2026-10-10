// SPDX-License-Identifier: Apache-2.0
// One Ask UI: honest per-stage status, progress and cancel, evidence verdicts, verbatim
// citations that open the committed file at the cited lines, and the structure explorer.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRemoteSession } from '../src/lib/remote';
import { emptyState, type DocAnswer, type DictionaryStatus } from '@acc/core';
import { AgentPacketPreview, AskPanel, FileViewer, DictionaryStatusCard, StructureExplorer, Tabs } from '../src/components/Dictionary';

afterEach(() => { cleanup(); vi.unstubAllGlobals();setRemoteSession(null,'checking'); });
const SHA = 'a'.repeat(40), OLD = 'b'.repeat(40);
const status = (over: Partial<DictionaryStatus> = {}): DictionaryStatus => ({
  state: 'partial', revision: SHA, ref: 'integration', updatedAt: null, files: 12, totalFiles: 20, excludedFiles: 8, truncated: false, languages: { TypeScript: 10 }, packages: [],
  notesRevision: SHA, embeddingsRevision: null, graphRevision: null, error: 'Graphify AST extraction failed (3)', generation: 'g1', structure: null,
  job: { id: 'intake_1', state: 'partial', reason: 'poll', revision: SHA, startedAt: '', finishedAt: '', done: 2, total: 2, stage: null, error: null, coalesced: 0 },
  stages: { extract: { state: 'ready', revision: SHA, detail: null }, notes: { state: 'ready', revision: SHA, detail: null }, structure: { state: 'ready', revision: SHA, detail: null }, keywords: { state: 'ready', revision: SHA, detail: '40 passages' }, vectors: { state: 'off', revision: null, detail: 'Semantic search is off; keyword retrieval is available.' }, graph: { state: 'stale', revision: OLD, detail: 'Graphify AST extraction failed (3)' } },
  changes: { from: OLD, to: SHA, mode: 'incremental', added: ['tools/add.py'], modified: ['src/edit.ts'], deleted: ['docs/old.md'], renamed: [{ from: 'a.ts', to: 'b.ts' }], reused: 10, reread: 2, reason: 'integration branch moved' },
  ...over,
});
let calls: { method: string; url: string; body: unknown }[] = [];
const answer: DocAnswer = {
  backend: 'keywords', mode: 'excerpts', warning: null, contextChars: 120, candidateChars: 400, budgetChars: 6000, indexedAt: null, claims: [],
  evidence: { support: 'insufficient', coverage: 0.33, terms: ['budget', 'forecast', 'quarter'], missing: ['budget', 'forecast'] },
  retrieval: { expanded: 1, deduplicated: 2, generation: 'g1', revision: SHA },
  citations: [{ id: 'S1', path: 'One Connect/x/Dictionary/n.md', title: 'n', line: 1, endLine: 8, excerpt: 'export const ledger = 1;', url: '', via: 'graph', projectSource: { path: 'src/ledger.ts', revision: SHA, hash: 'c'.repeat(64), line: 2, endLine: 3 } }],
};
beforeEach(() => {
  setRemoteSession(null,'local');
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    if (url === '/api/context/answer/cancel') return json({ cancelled: true });
    if (url === '/api/context/answer/refresh') return json({ accepted: true });
    if (url === '/api/context/answer/search') return json(answer);
    if (url.startsWith('/api/context/answer/file')) return json({ path: 'src/ledger.ts', revision: SHA, language: 'TypeScript', lines: 3, content: "import { add } from './math.js';\nexport const ledger = 1;\nexport const two = 2;\n" });
    if (url.startsWith('/api/context/answer/structure')) return json({ generation: 'g1', revision: SHA, summary: { files: 3, symbols: 4, edges: 1, entryPoints: ['README.md'], manifests: [], truncated: false }, central: [{ path: 'src/math.js', inbound: 1, outbound: 0 }], file: url.includes('file=') ? { path: 'src/math.js', symbols: [{ name: 'add', kind: 'const', line: 2 }], edges: [{ from: 'src/ledger.ts', to: 'src/math.js', kind: 'import', line: 1 }] } : null, note: 'Parsed declaratively from committed source. It is not a call graph and not Graphify.' });
    return json({ error: 'unexpected' }, 404);
  }));
});

describe('One Ask status', () => {
  it('spells out every stage, marks an older graph as stale, and summarizes the incremental change', () => {
    render(<DictionaryStatusCard status={status()} />);
    expect(screen.getByText('Partial')).toBeTruthy();
    const stages = screen.getByRole('list', { name: 'Pipeline stages' });
    expect(within(stages).getAllByText('Current')).toHaveLength(4);
    expect(within(stages).getByText('Stale')).toBeTruthy();
    expect(within(stages).getByText(`${OLD.slice(0, 12)} · older revision`)).toBeTruthy();
    expect(within(stages).getByText('Off')).toBeTruthy();
    expect(screen.getByText(/incremental \(integration branch moved\) · 1 added · 1 modified · 1 deleted · 1 renamed · 2 read from Git/)).toBeTruthy();
    expect(screen.getByText(/Graphify AST extraction failed/, { selector: 'p' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-index project' })).toBeTruthy();
  });
  it('shows progress while running and cancels through the daemon', async () => {
    render(<DictionaryStatusCard status={status({ state: 'extracting', job: { ...status().job!, state: 'running', done: 30, total: 120, stage: 'extract', coalesced: 2 } })} />);
    const bar = screen.getByRole('progressbar', { name: 'Files read for this intake' });
    expect(bar.getAttribute('aria-valuenow')).toBe('30');expect(bar.getAttribute('aria-valuemax')).toBe('120');
    expect(screen.getByText('2 more requests will run once, after this intake.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel intake' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/context/answer/cancel' && c.method === 'POST')).toBe(true));
  });
  it('offers a retry after a failed or cancelled intake', () => {
    render(<DictionaryStatusCard status={status({ state: 'cancelled', error: 'Project intake was cancelled.' })} />);
    expect(screen.getByRole('button', { name: 'Retry intake' })).toBeTruthy();
  });
});

describe('Ask and sources', () => {
  it('labels insufficient evidence, shows how each source was found, and opens the committed file at the cited lines', async () => {
    const opened: unknown[] = [];
    render(<AskPanel disabled={false} onOpenFile={(...a) => opened.push(a)} />);
    fireEvent.change(screen.getByLabelText('Ask about this project'), { target: { value: 'quarterly budget forecast' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask One Ask' }));
    expect(await screen.findByText('Insufficient evidence')).toBeTruthy();
    expect(screen.getByText(/do not clearly answer this \(not found: budget, forecast\)/)).toBeTruthy();
    expect(screen.getByText(/related by imports/)).toBeTruthy();
    expect(screen.getByText(/1 added through imports · 2 duplicates removed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open ledger.ts at line 2' }));
    expect(opened).toEqual([['src/ledger.ts', 2, 3, SHA]]);
  });
  it('renders committed source with the cited lines highlighted', async () => {
    const { container } = render(<FileViewer target={{ path: 'src/ledger.ts', line: 2, endLine: 3 }} onClose={() => undefined} />);
    expect(await screen.findByText(`revision ${SHA.slice(0, 12)} · TypeScript · 3 lines · redacted`)).toBeTruthy();
    expect([...container.querySelectorAll('li.hit')].map((li) => li.getAttribute('data-line'))).toEqual(['2', '3']);
  });
});

describe('One Ask late responses',()=>{
  it('keeps the cited revision in the request and ignores a response for the previously opened file',async()=>{
    let finishOld!:(response:Response)=>void;
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
      if(String(url).includes('src%2Fold.ts'))return new Promise<Response>(r=>{finishOld=r;});
      return new Response(JSON.stringify({path:'src/new.ts',revision:SHA,language:'TypeScript',lines:1,content:'current source marker'}));
    }));
    const view=render(<FileViewer target={{path:'src/old.ts',revision:OLD,line:1}} onClose={()=>{}}/>);
    await waitFor(()=>expect(finishOld).toBeTruthy());
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain(`&revision=${OLD}`);
    view.rerender(<FileViewer target={{path:'src/new.ts',revision:SHA,line:1}} onClose={()=>{}}/>);
    await screen.findByText('current source marker');
    finishOld(new Response(JSON.stringify({path:'src/old.ts',revision:OLD,language:'TypeScript',lines:1,content:'obsolete source marker'})));
    await waitFor(()=>expect(screen.queryByText('obsolete source marker')).toBeNull());
    expect(screen.getByText('current source marker')).toBeTruthy();
  });

  it('does not show an earlier issue packet after the issue selection changes',async()=>{
    let finish!:(response:Response)=>void;
    vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(r=>{finish=r;})));
    const state=emptyState();
    state.workItems.item={id:'item',key:'LOCAL-1',title:'Issue B',state:'backlog',priority:1} as typeof state.workItems[string];
    render(<AgentPacketPreview state={state}/>);
    fireEvent.click(screen.getByRole('button',{name:'Preview packet'}));
    await waitFor(()=>expect(finish).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Issue'),{target:{value:'item'}});
    finish(new Response(JSON.stringify({key:'old',budget:{used:2345,limit:9000,trimmed:[]},project:{revision:OLD,state:'partial',warnings:['old packet marker']},architecture:{entryPoints:[],central:[]},team:[],context:null})));
    await waitFor(()=>expect(screen.getByRole('button',{name:'Preview packet'})).toBeTruthy());
    expect(screen.queryByText('old packet marker')).toBeNull();
  });
});

describe('Structure explorer and tabs', () => {
  it('distinguishes the import graph from Graphify and navigates to a file', async () => {
    render(<StructureExplorer state={{ ...emptyState(), context: { ...emptyState().context, graph: null, answer: status() } }} onOpenFile={() => undefined} />);
    expect(await screen.findByText(/not a call graph and not Graphify/)).toBeTruthy();
    expect(screen.getByText(/Graphify: off for this project/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /src\/math\.js/ }));
    expect(await screen.findByText('Used by (1)')).toBeTruthy();
    expect(screen.getByRole('button', { name: /add const · line 2/ })).toBeTruthy();
  });
  it('supports arrow-key tab navigation', () => {
    const changed: string[] = [];
    render(<Tabs active="ask" onChange={(id) => changed.push(id)} tabs={[{ id: 'ask', label: 'Ask' }, { id: 'structure', label: 'Explore structure' }]} />);
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(changed).toEqual(['structure']);
    expect(screen.getByRole('tab', { name: 'Ask' }).getAttribute('aria-selected')).toBe('true');
  });
});
