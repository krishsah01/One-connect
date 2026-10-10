// SPDX-License-Identifier: Apache-2.0
// One run's full, live transcript on its own screen. Reading only: no composer, nothing to send.
import { Link, useParams } from 'react-router';
import type { ControlState } from '@acc/core';
import { isActiveRun } from '@acc/core';
import { Badge, Light } from '../components/common';
import { Transcript } from '../components/Transcript';
import { RUN_TONE, ago } from '../lib/format';
import { can, useRemoteSession } from '../lib/remote';
import { useLiveText, useRunEvents } from '../lib/store';

export function RunView({ state }: { state: ControlState }) {
  const { id = '' } = useParams();
  const run = state.runs[id];
  const events = useRunEvents(run ? id : null);
  const liveText = useLiveText(run ? id : null);
  const { session } = useRemoteSession();
  if (!run) return <div className="page empty">Unknown run.</div>;
  if (!can(session, 'transcript')) return <div className="page empty">This phone was not granted run transcripts.</div>;
  const agent = state.agents[run.agentId];
  const item = state.workItems[run.workItemId];
  return (
    <div className="page col run-view" style={{ gap: 10 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <Link className="btn sm" to="/phone">Back</Link>
        <Light tone={RUN_TONE[run.state]} pulse={run.state === 'running'} />
        <b className="grow ellipsis">{agent?.config.name ?? run.agentId}</b>
        <Badge tone={RUN_TONE[run.state]}>{run.state}</Badge>
      </div>
      <div className="small muted">{item?.key} {item?.title}{run.resolvedModel ? ` · ${run.resolvedModel}` : ''}{run.startedAt ? ` · started ${ago(run.startedAt)} ago` : ''}</div>
      <section className="card" style={{ overflow: 'hidden' }}>
        <Transcript events={events} live={liveText} runId={run.id} active={isActiveRun(run)} />
      </section>
      {run.handoff && <div className="card card-b col small"><b>Handoff (agent-reported)</b><span>{run.handoff.done}</span>{run.handoff.next && <span className="muted">Next: {run.handoff.next}</span>}</div>}
    </div>
  );
}
