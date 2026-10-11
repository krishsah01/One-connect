// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Read models for the Designer: which agents can design, what each ask-bar request is doing right
// now, and the one-word status the top bar shows. Everything derives from live state and the design
// record; nothing here talks to the daemon except startAgentJob, which prepares and dispatches a job.
import { designAgentEligibility, isActiveRun, type AgentState, type Approval, type ControlState, type DesignDocument, type DesignDocumentFinding, type DesignNode, type Run } from '@acc/core';
import { post } from '../../../lib/api';
import type { JobView, ProposalView, RecordView } from '../workspace/useDesignDocument';

export const VIEWPORTS = [{ width: 390, label: 'Phone' }, { width: 820, label: 'Tablet' }, { width: 1280, label: 'Desktop' }] as const;

/** Agents that can run a design request here: enabled, local, signed in, not coordinator-only and not metered without approval. */
export function designAgents(state: ControlState): AgentState[] {
  return Object.values(state.agents).filter(a => designAgentEligibility(a).ok);
}

export type JobPhase = 'prepared' | 'queued' | 'running' | 'needs-you' | 'proposed' | 'done' | 'failed' | 'canceled';
export interface JobThreadItem {
  job: JobView;
  run: Run | null;
  approvals: Approval[];
  proposals: ProposalView[];
  phase: JobPhase;
  label: string;
  detail: string;
  agentName: string;
}

const RUN_LABEL: Record<Run['state'], [JobPhase, string]> = {
  queued: ['queued', 'Queued'], starting: ['running', 'Starting'], running: ['running', 'Working'],
  'waiting-for-approval': ['needs-you', 'Needs you'], 'waiting-for-input': ['needs-you', 'Needs you'],
  stalled: ['failed', 'Stalled'], paused: ['queued', 'Paused'], failed: ['failed', 'Failed'], finished: ['done', 'Done'], orphaned: ['failed', 'Lost'],
};

/** One ask-bar request joined with its assignment, latest run, open questions and proposals. */
export function jobThread(record: RecordView, state: ControlState): JobThreadItem[] {
  return record.jobs.map(job => {
    const a = state.assignments[job.assignmentId];
    const run = Object.values(state.runs).filter(r => r.assignmentId === job.assignmentId).sort((x, y) => x.createdAt.localeCompare(y.createdAt)).at(-1) ?? null;
    const approvals = run ? Object.values(state.approvals).filter(ap => ap.runId === run.id && !ap.resolvedAt) : [];
    const proposals = record.proposals.filter(p => p.assignmentId === job.assignmentId);
    const agentName = (a && state.agents[a.agentId]?.config.name) || 'agent';
    let phase: JobPhase, label: string;
    if (!a || a.position === 'canceled') { phase = 'canceled'; label = 'Canceled'; }
    else if (approvals.length) { phase = 'needs-you'; label = 'Needs you'; }
    else if (run && isActiveRun(run)) { [phase, label] = RUN_LABEL[run.state]; }
    else if (proposals.some(p => p.status === 'pending')) { phase = 'proposed'; label = 'Proposed'; }
    else if (run) { [phase, label] = RUN_LABEL[run.state]; if (phase === 'done' && proposals.length) label = proposals.every(p => p.status === 'applied') ? 'Kept' : 'Done'; }
    else if (a.position === 'draft') { phase = 'prepared'; label = 'Ready to start'; }
    else if (a.position === 'next' || a.position === 'now') { phase = 'queued'; label = 'Queued'; }
    else { phase = 'done'; label = 'Done'; }
    const detail = phase === 'prepared' ? `Prepared for ${agentName}. Nothing has run yet.`
      : phase === 'queued' ? `${agentName} starts when it is free.`
      : phase === 'running' ? `${agentName} is working. Proposals appear on the canvas.`
      : phase === 'needs-you' ? `${agentName} has a question.`
      : phase === 'proposed' ? 'Review the proposal on the canvas: keep it or discard it.'
      : phase === 'failed' ? `${agentName} stopped before proposing a change.`
      : phase === 'canceled' ? 'This request was canceled.' : `${agentName} finished.`;
    return { job, run, approvals, proposals, phase, label, detail, agentName };
  }).sort((x, y) => x.job.createdAt.localeCompare(y.job.createdAt));
}

export type DesignStatus = 'Draft' | 'Agent working' | 'Needs you' | 'Needs attention' | 'Ready for review' | 'Approved';
/** The one word in the top bar. Agent activity and questions outrank findings; approval outranks all. */
export function designStatus(thread: JobThreadItem[], findings: DesignDocumentFinding[], approved: boolean, released: boolean): DesignStatus {
  if (approved) return 'Approved';
  if (thread.some(t => t.phase === 'needs-you')) return 'Needs you';
  if (thread.some(t => t.phase === 'running' || t.phase === 'queued')) return 'Agent working';
  if (findings.some(f => f.severity === 'error')) return 'Needs attention';
  if (released) return 'Ready for review';
  return 'Draft';
}

/** Prepare an agent request on a design and start it. Returns what happened in one sentence. */
export async function startAgentJob(documentId: string, input: { agentId: string; request: string; selection?: string[]; files?: string[]; kind?: 'edit' | 'generate' | 'reconstruct' | 'repair' }): Promise<{ assignmentId: string; started: boolean; message: string }> {
  const r = await post<{ assignment: { id: string }; preflight: { checks: { id: string; label: string; status: string; message: string }[] } | null }>(`/api/designer/documents/${documentId}/ai`, input);
  const failing = r.preflight?.checks.filter(c => c.status === 'fail') ?? [];
  if (failing.length) return { assignmentId: r.assignment.id, started: false, message: `Not started: ${failing.map(c => c.message || c.label).join(' ')}` };
  try {
    const d = await post<{ started: boolean; queued: boolean }>(`/api/assignments/${r.assignment.id}/dispatch`, { position: 'now' });
    return { assignmentId: r.assignment.id, started: d.started, message: d.started ? 'Started.' : 'Queued; it starts when the agent is free.' };
  } catch (e) {
    return { assignmentId: r.assignment.id, started: false, message: `Prepared but not started: ${(e as Error).message}` };
  }
}

/** Screen → parent map and the chain of layer names from a screen root down to one layer. */
export function layerPath(d: DesignDocument, id: string): { screen: DesignDocument['screens'][number] | null; chain: DesignNode[] } {
  const parent = new Map<string, string>();
  for (const n of Object.values(d.nodes)) for (const c of n.children) parent.set(c, n.id);
  const chain: DesignNode[] = [];
  let cur: string | undefined = id;
  while (cur && d.nodes[cur] && chain.length < 50) { chain.unshift(d.nodes[cur]); cur = parent.get(cur); }
  const root = chain[0]?.id;
  return { screen: d.screens.find(s => s.root === root) ?? null, chain };
}

export function screenOfNode(d: DesignDocument, id: string): string | undefined { return layerPath(d, id).screen?.id; }

/** A short name from the first clause of the prompt, cut at a word boundary. */
export const titleFromPrompt = (prompt: string) => {
  const line = prompt.trim().split('\n')[0].replace(/^(a|an|the)\s+/i, '').trim();
  let cut = line.split(/[.;:!?,(]| (?:where|which|that|so|for|with|to) /i)[0].trim();
  if (cut.length > 48) { cut = cut.slice(0, 48); cut = cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut; }
  return cut ? cut[0].toUpperCase() + cut.slice(1) : 'Untitled design';
};
