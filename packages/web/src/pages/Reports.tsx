// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Brief & Reports and Timeline. Everything shown is derived from this project's recorded events;
// every claim names the events (and SHAs) behind it, and gaps are stated rather than filled in.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Brief, Claim, ControlState, EvidenceRef, MorningReport, TimelineEntry } from '@acc/core';
import { Badge, Copy, ErrorLine } from '../components/common';
import { api } from '../lib/api';
import { ago, type Tone } from '../lib/format';

type Tab = 'brief' | 'timeline' | 'morning' | 'standup';
const TABS: { id: Tab; label: string }[] = [{ id: 'brief', label: 'Brief' }, { id: 'timeline', label: 'Timeline' }, { id: 'morning', label: 'Morning report' }, { id: 'standup', label: 'Standup' }];
const BASIS: Record<Claim['basis'], { label: string; tone: Tone }> = { recorded: { label: 'recorded', tone: 'ok' }, agent_reported: { label: 'agent-reported, unverified', tone: 'warn' }, derived: { label: 'counted from events', tone: 'info' } };

const qs = (o: Record<string, string>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v) p.set(k, v); const s = p.toString(); return s ? `?${s}` : ''; };
const sha = (s: string | null | undefined) => (s ? s.slice(0, 10) : '');

function useReport<T>(path: string, query: Record<string, string>, enabled: boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = path + qs(query);
  const load = useCallback(() => api<T>(key).then((d) => { setData(d); setError(null); }).catch((e: Error) => setError(e.message)), [key]);
  useEffect(() => { if (enabled) void load(); }, [enabled, load]);
  return { data, error, reload: load };
}

export function Reports({ state }: { state: ControlState }) {
  const [tab, setTab] = useState<Tab>('brief');
  const [issue, setIssue] = useState('');
  const [agent, setAgent] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const iso = (d: string, end = false) => (d ? new Date(`${d}T${end ? '23:59:59' : '00:00:00'}`).toISOString() : '');
  const q = { issue, agent, from: iso(from), to: iso(to, true) };
  const items = Object.values(state.workItems).filter((w) => w.key).sort((a, b) => (a.key ?? '').localeCompare(b.key ?? ''));
  return (
    <div className="page col reports-page" style={{ gap: 14 }}>
      <div className="page-heading"><div><h1>Brief & Reports</h1><p>Built only from this project’s recorded events. Nothing is summarized by a model, and a missing result is shown as missing, never as success.</p></div></div>
      <div className="row wrap" role="tablist" aria-label="Report type">
        {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={`chip tab-chip${tab === t.id ? ' on' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>
      <fieldset className="report-filters">
        <legend className="small faint">Filters</legend>
        <label>Issue<select value={issue} onChange={(e) => setIssue(e.target.value)}><option value="">All issues</option>{items.map((w) => <option key={w.id} value={w.key!}>{w.key} {w.title.slice(0, 40)}</option>)}</select></label>
        <label>Agent<select value={agent} onChange={(e) => setAgent(e.target.value)}><option value="">All agents</option>{Object.values(state.agents).map((a) => <option key={a.id} value={a.id}>{a.config.name}</option>)}</select></label>
        {tab !== 'brief' && <><label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label></>}
      </fieldset>
      {tab === 'brief' && <BriefView q={q} />}
      {tab === 'timeline' && <TimelineView q={q} />}
      {tab === 'morning' && <MorningView q={q} />}
      {tab === 'standup' && <StandupView q={q} />}
    </div>
  );
}

function Refs({ refs }: { refs: EvidenceRef[] }) {
  if (!refs.length) return <span className="faint small">no linked event</span>;
  return <span className="evidence-refs">{refs.slice(0, 6).map((r) => <span key={r.seq} className="mono small ev-chip" title={`${r.type} at ${r.ts}${r.command ? ` · ${r.command}` : ''}`}>#{r.seq}{r.sha ? ` ${sha(r.sha)}` : ''}</span>)}</span>;
}

function BriefView({ q }: { q: Record<string, string> }) {
  const { data: b, error } = useReport<Brief>('/api/reports/brief', { issue: q.issue, agent: q.agent }, true);
  if (error) return <ErrorLine error={error} />;
  if (!b) return <div className="empty">Loading brief…</div>;
  return (
    <div className="col" style={{ gap: 14 }}>
      <section className="card"><div className="card-b col" style={{ gap: 8 }}>
        <h2>Now</h2>
        {b.now.filter((n) => n.issue).length === 0 && <span className="small muted">No agent has work in Now.</span>}
        {b.now.filter((n) => n.issue).map((n) => <div key={n.agentId} className="row wrap"><b>{n.agent}</b><Badge>{n.status}</Badge><span className="grow">{n.issue} {n.title}</span>{n.run && <Link to={`/runs/${n.run.id}`} className="small">{n.run.state}{n.run.lastMeaningful ? `: ${n.run.lastMeaningful.slice(0, 60)}` : ''}</Link>}</div>)}
        <h2>Next</h2>
        {b.next.length === 0 && <span className="small muted">Nothing queued.</span>}
        {b.next.map((n) => n.items.map((i, k) => <div key={`${n.agentId}${k}`} className="row wrap"><b>{n.agent}</b><span>{i.issue} {i.title}</span></div>))}
      </div></section>
      <section className="card"><div className="card-b col" style={{ gap: 8 }}>
        <div className="row"><h2>Pending decisions and alerts</h2><span className="spacer" /><Link to="/decisions" className="small">Open Decisions</Link></div>
        {b.pending.length === 0 && <span className="small muted">Nothing is waiting.</span>}
        {b.pending.map((p) => <div key={p.kind + p.id} className="row wrap small"><Badge tone={p.urgency === 'critical' ? 'crit' : p.urgency === 'high' ? 'warn' : 'info'}>{p.kind}</Badge><span className="grow">{p.title}</span><span className="faint">{p.ageMinutes} min{p.issue ? ` · ${p.issue}` : ''}</span></div>)}
      </div></section>
      <section className="col" style={{ gap: 8 }}>
        <h2>Handoff cards</h2>
        {b.handoffs.length === 0 && <div className="empty card card-b">No handoff has been recorded for this scope.</div>}
        {b.handoffs.map((h) => (
          <article key={h.runId} className="card handoff-card"><div className="card-b col" style={{ gap: 6 }}>
            <div className="row wrap small" style={{ gap: 6 }}><b>{h.agent}</b>{h.issue && <span className="mono">{h.issue}</span>}<Badge tone={h.blocked ? 'warn' : 'info'}>{h.blocked ? 'blocked' : 'handoff'}</Badge><span className="spacer" /><span className="faint">{ago(h.at)} ago · event #{h.seq}</span></div>
            <div>{h.done}</div>
            {h.commit && <div className="small">Commit <span className="mono">{sha(h.commit.sha)}</span>{h.commit.branch ? ` on ${h.commit.branch}` : ''} · {h.commit.verified ? 'verified by One Connect' : 'not verified'}</div>}
            {h.evidence.map((e, i) => <div key={i} className="small"><span className="mono">{e.command}</span> → {e.result} <Badge tone={e.verified ? 'ok' : 'warn'}>{e.verified ? 'verified' : 'unverified'}</Badge></div>)}
            {h.blocked && <div className="small">Blocked: {h.blocked.what}{h.blocked.on ? ` (on ${h.blocked.on})` : ''}</div>}
            {h.next && <div className="small muted">Next: {h.next}</div>}
            <div className="small faint">Written by the agent ({h.source}); it is a claim until the evidence above is verified.</div>
          </div></article>
        ))}
      </section>
      <section className="card"><div className="card-b col" style={{ gap: 6 }}>
        <h2>Check and merge evidence</h2>
        {b.checks.length === 0 && b.merges.length === 0 && <span className="small muted">No check or merge evidence recorded.</span>}
        {b.merges.map((m) => <div key={m.mergeSha} className="small"><Badge tone="ok">merged locally</Badge> {m.issue} {m.sourceBranch} → {m.target} <span className="mono">{sha(m.mergeSha)}</span> · post-merge checks: {m.postChecks} <Refs refs={m.evidence} /></div>)}
        {b.checks.map((c) => <div key={c.evidence.seq} className="small"><Badge tone={(c.failed ?? 0) > 0 || (c.exitCode ?? 0) !== 0 ? 'crit' : c.verified ? 'ok' : 'warn'}>{c.verified ? 'run by One Connect' : 'agent-reported'}</Badge> {c.issue} {c.command ? <span className="mono">{c.command}</span> : c.summary} {c.passed != null ? `${c.passed} passed, ${c.failed ?? 0} failed` : c.exitCode != null ? `exit ${c.exitCode}` : ''} <Refs refs={[c.evidence]} /></div>)}
      </div></section>
      <section className="card"><div className="card-b col" style={{ gap: 6 }}>
        <h2>Release and infrastructure</h2>
        {b.releases.length === 0 && <span className="small muted">No release, deploy or infrastructure events have been recorded.</span>}
        {b.releases.map((r) => <div key={r.seq} className="small"><Badge tone={r.tone}>{r.type}</Badge> {r.summary} <span className="mono faint">#{r.seq}{r.sha ? ` ${sha(r.sha)}` : ''}</span></div>)}
      </div></section>
      {b.notes.map((n) => <div key={n} className="banner small tone-info">{n}</div>)}
    </div>
  );
}

function TimelineView({ q }: { q: Record<string, string> }) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const key = JSON.stringify(q);
  const fetchPage = useCallback((before: number | null, replace: boolean) => api<{ entries: TimelineEntry[]; hasMore: boolean }>(`/api/reports/timeline${qs({ ...q, limit: '60', before: before ? String(before) : '' })}`)
    .then((r) => { setEntries((cur) => (replace ? r.entries : [...cur, ...r.entries])); setMore(r.hasMore); setError(null); setLoaded(true); }).catch((e: Error) => setError(e.message)), [q]);
  useEffect(() => { void fetchPage(null, true); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col" style={{ gap: 8 }}>
      <ErrorLine error={error} />
      {loaded && entries.length === 0 && <div className="empty card card-b">No recorded events match these filters.</div>}
      <ol className="timeline">
        {entries.map((e) => (
          <li key={e.seq} className={`tl tone-${e.tone}`}>
            <div className="row wrap small" style={{ gap: 6 }}><Badge tone={e.tone}>{e.label}</Badge>{e.issue && <span className="mono">{e.issue}</span>}<span className="spacer" /><span className="faint mono">#{e.seq} · {new Date(e.ts).toLocaleString()}</span></div>
            <div>{e.summary}{e.sha && <> <span className="mono">{sha(e.sha)}</span></>}</div>
            <div className="small faint">by {e.actor}{e.runId ? <> · <Link to={`/runs/${e.runId}`}>run</Link></> : null}</div>
          </li>
        ))}
      </ol>
      {more && <button className="btn" onClick={() => void fetchPage(entries.at(-1)!.seq, false)}>Load older events</button>}
    </div>
  );
}

function ClaimList({ claims, empty }: { claims: Claim[]; empty: string }) {
  if (!claims.length) return <div className="small muted">{empty}</div>;
  return <ul className="claims">{claims.map((c) => <li key={c.id}><div>{c.text}</div><div className="row wrap small" style={{ gap: 6 }}><Badge tone={BASIS[c.basis].tone}>{BASIS[c.basis].label}</Badge><Refs refs={c.evidence} /></div></li>)}</ul>;
}

function MorningView({ q }: { q: Record<string, string> }) {
  const { data: r, error } = useReport<MorningReport>('/api/reports/morning', q, true);
  if (error) return <ErrorLine error={error} />;
  if (!r) return <div className="empty">Loading report…</div>;
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="small muted">{new Date(r.window.from).toLocaleString()} to {new Date(r.window.to).toLocaleString()} · {r.eventCount} recorded events</div>
      {r.sections.map((s) => <section key={s.id} className="card"><div className="card-b col" style={{ gap: 8 }}><h2>{s.title}</h2><ClaimList claims={s.claims} empty={s.empty} /></div></section>)}
      {r.caveats.map((c) => <div key={c} className="banner small tone-info">{c}</div>)}
    </div>
  );
}

function StandupView({ q }: { q: Record<string, string> }) {
  const { data, error } = useReport<{ markdown: string }>('/api/reports/standup', q, true);
  const href = `/api/reports/standup${qs({ ...q, format: 'md' })}`;
  if (error) return <ErrorLine error={error} />;
  if (!data) return <div className="empty">Loading standup…</div>;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row wrap"><Copy text={data.markdown} label="Copy Markdown" /><a className="btn" href={href} download="standup.md">Download .md</a><span className="small faint">Each line ends with the event numbers and SHAs that back it.</span></div>
      <pre className="standup-md">{data.markdown}</pre>
    </div>
  );
}
