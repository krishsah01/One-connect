// SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { ControlState, TeamMessage } from '@acc/core';
import { Avatar, Badge, ErrorLine, UsageMeter, useAction } from '../components/common';
import { post } from '../lib/api';

export function Team({ state }: { state: ControlState }) {
  const agents = Object.values(state.agents);
  const [filter,setFilter] = useState('');
  const [recipient,setRecipient] = useState(agents[0]?.id ?? '');
  const [subject,setSubject] = useState('');
  const [body,setBody] = useState('');
  const [issue,setIssue] = useState('');
  const [kind,setKind] = useState<TeamMessage['kind']>('note');
  const [reply,setReply] = useState<TeamMessage | null>(null);
  const [shown,setShown] = useState(30);
  const { busy,error,run } = useAction();
  const messages = useMemo(() => Object.values(state.teamMessages ?? {}).filter(m => !filter || m.recipients.includes(filter) || m.sender.type === 'agent' && m.sender.id === filter).sort((a,b) => b.seq-a.seq),[state.teamMessages,filter]);
  const name = (id: string) => state.agents[id]?.config.name ?? id;
  const positions = useMemo(()=>new Map(Object.values(state.agents).slice(0,12).map((a,i) => [a.id,{ x:110+(i%4)*190,y:70+Math.floor(i/4)*100 }])),[state.agents]);
  const connections = useMemo(()=>[...new Set(Object.values(state.teamMessages ?? {}).filter(m => m.sender.type === 'agent').flatMap(m => m.recipients.map(id => [m.sender.id,id].sort().join(':'))))],[state.teamMessages]);
  const replyTo = (m: TeamMessage) => {
    setReply(m);setSubject(`Re: ${m.subject}`.slice(0,160));setIssue(m.workItemId ?? '');setKind('reply');
    setRecipient(m.sender.type === 'agent' ? m.sender.id : m.recipients[0] ?? '');
    document.getElementById('team-message-body')?.focus();
  };
  return <div className="page connected-page">
    <div className="page-heading"><div><h1>Team workspace</h1><p>One shared view of who is working, what changed and what needs an answer.</p></div><Link className="btn" to="/setup">Manage agents</Link></div>
    <div className="team-layout">
      <div className="col" style={{gap:20}}>
        <section className="team-map" aria-label="Agent communication map">
          <div className="row"><h2>Connected agents</h2><span className="spacer"/><span className="small muted">Lines show recorded conversations</span></div>
          <svg viewBox={`0 0 800 ${Math.max(155,Math.ceil(Math.min(agents.length,12)/4)*100+45)}`} role="img" aria-label={`${agents.length} agents; ${connections.length} conversation links`}>
            {connections.map(pair => { const [a,b]=pair.split(':');const p=positions.get(a),q=positions.get(b);return p && q ? <path key={pair} d={`M${p.x},${p.y} C${p.x},${p.y+45} ${q.x},${q.y+45} ${q.x},${q.y}`} className="team-wire"/> : null; })}
            {agents.slice(0,12).map(a => { const p=positions.get(a.id)!;return <a href={`/agents/${encodeURIComponent(a.id)}`} key={a.id} aria-label={`Open ${a.config.name} console`}><g transform={`translate(${p.x},${p.y})`}><circle r="23" className={`map-agent status-${a.status}`}/><text textAnchor="middle" y="5" className="map-initial">{a.config.name.slice(0,2)}</text><text textAnchor="middle" y="43" className="map-name">{a.config.name.slice(0,22)}</text><text textAnchor="middle" y="59" className="map-status">{a.status}</text></g></a>; })}
          </svg>
          {!messages.length && <p className="small muted">Agents share task ownership immediately. Conversations appear here when a peer needs context or help.</p>}
          {agents.length>12 && <p className="small muted">Showing 12 agents in the map. All agents remain available in the inbox and status list.</p>}
        </section>
        <section className="conversation-section">
          <div className="row wrap"><h2>Conversations</h2><span className="spacer"/><select aria-label="Filter conversations by agent" value={filter} onChange={e => {setFilter(e.target.value);setShown(30);}}><option value="">Every agent</option>{agents.map(a => <option key={a.id} value={a.id}>{a.config.name}</option>)}</select><span className="small faint">{messages.length} messages</span></div>
          {!messages.length && <div className="empty conversation-empty">No conversations yet. Send a project note, or let an agent ask a peer through its team tools.</div>}
          <div className="conversations">{messages.slice(0,shown).map(m => <article className={`team-message kind-${m.kind}`} key={m.id}>
            <div className="row wrap"><Avatar id={m.sender.id} name={m.sender.type === 'agent' ? name(m.sender.id) : 'You'}/><b>{m.sender.type === 'agent' ? name(m.sender.id) : 'You'}</b><span className="small muted">to {m.recipients.map(name).join(', ')}</span><span className="spacer"/><Badge>{m.kind}</Badge><time className="small faint">{new Date(m.createdAt).toLocaleString()}</time></div>
            <h3>{m.subject}</h3><p className="message-body">{m.body}</p>
            <div className="row wrap small"><span className="muted">{m.workItemId ? state.workItems[m.workItemId]?.key ?? 'Issue pending' : 'Project note'}</span>{m.replyTo && <span className="faint">Reply in thread</span>}<span className="spacer"/>{m.recipients.map(id => <span key={id} className={m.acknowledgedBy[id] ? 'text-ok' : 'faint'}>{name(id)}: {m.acknowledgedBy[id] ? 'acknowledged' : Object.keys(m.notifiedRuns).some(r => state.runs[r]?.agentId === id) ? 'reminder queued; unread' : 'in inbox'}</span>)}<button className="btn sm" onClick={() => replyTo(m)}>Reply</button></div>
          </article>)}</div>
          {messages.length>shown && <button className="btn" onClick={() => setShown(shown+30)}>Show older messages</button>}
        </section>
      </div>
      <aside className="team-detail col">
        <form className="message-composer col" onSubmit={e => {e.preventDefault();void run(async () => {await post('/api/team/messages',{recipients:recipient==='all' ? agents.map(a => a.id) : [recipient],subject,body,kind,workItemId:issue || null,replyTo:reply?.id ?? null});setBody('');setSubject('');setReply(null);});}}>
          <h2>{reply ? 'Reply to conversation' : 'Send a team message'}</h2><p className="small muted">Internal to this project. Agents read their inbox through One Connect.</p>
          <fieldset className="composer-fields col" disabled={busy}>
          {reply && <div className="row small"><span className="ellipsis grow">{reply.subject}</span><button type="button" className="btn sm" onClick={() => {setReply(null);setKind('note');}}>Cancel reply</button></div>}
          <label>To<select value={recipient} onChange={e => setRecipient(e.target.value)}><option value="all" disabled={agents.length>64}>Everyone</option>{agents.map(a => <option key={a.id} value={a.id}>{a.config.name}</option>)}</select></label>
          <label>Issue<select value={issue} onChange={e => setIssue(e.target.value)}><option value="">Project note</option>{Object.values(state.workItems).map(w => <option key={w.id} value={w.id}>{w.key ?? 'Pending'}: {w.title}</option>)}</select></label>
          <label>Type<select value={kind} onChange={e => setKind(e.target.value as TeamMessage['kind'])}>{['note','question','reply','blocker','handoff'].map(k => <option value={k} key={k}>{k}</option>)}</select></label>
          <label>Subject<input required maxLength={160} value={subject} onChange={e => setSubject(e.target.value)}/></label>
          <label>Message<textarea id="team-message-body" required rows={5} maxLength={6000} value={body} onChange={e => setBody(e.target.value)} placeholder="A decision, useful context or a question for a peer…"/></label>
          </fieldset><button className="btn primary" disabled={busy || !agents.length || !body.trim() || !subject.trim()}>Send message</button><ErrorLine error={error}/>
        </form>
        <section className="team-status-list col"><h2>Subscription capacity</h2><p className="small muted">Parallel agents on one subscription share its limits.</p>{agents.map(a => <div className="capacity-agent col" key={a.id}><div className="row"><Avatar id={a.id} name={a.config.name}/><Link to={`/agents/${a.id}`}>{a.config.name}</Link><span className="spacer"/><Badge>{a.status}</Badge></div><UsageMeter usage={a.usage}/></div>)}</section>
        <div className="context-note"><h2>Compact shared context</h2><p>Each run gets current ownership and its inbox. Peers pull details when needed, keeping transcripts out of the shared prompt.</p><Link to="/analytics">View recorded usage</Link></div>
      </aside>
    </div>
  </div>;
}
