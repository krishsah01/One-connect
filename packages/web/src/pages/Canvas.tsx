// SPDX-License-Identifier: Apache-2.0
// Project canvas: each workflow is a frame of nodes (issues and agent steps) wired by dependency.
// Drafts are edited in place; Finalize and run locks a workflow until it is terminated, which
// reopens its unfinished steps with a pickup point. Finalized workflows can be hidden and come
// back only when they need the owner. The daemon remains the authority for every rule shown here.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useNodesState, useReactFlow,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { CanvasFrame, CanvasLayout, CanvasShowWhen, CanvasSketch, CanvasSketchTask, ControlState, Workflow, WorkflowIssue, WorkflowTaskKind, WorkflowTaskStatus } from '@acc/core';
import { DEFAULT_SHOW_WHEN, emptyCanvas, frameVisible, isWorkflowLocked, sketchDefinition, sketchFromWorkflow, topoOrder, validateWorkflow, workflowAttention, workflowProgress } from '@acc/core';
import { Badge, ErrorLine, useAction } from '../components/common';
import { api, ApiError, post } from '../lib/api';
import type { Tone } from '../lib/format';
import { NewIssueDialog } from '../components/NewIssueDialog';
import { Icon } from '../shell/icons';
import '../shell/canvas.css';

const STEP_LABEL: Record<WorkflowTaskKind, string> = { code: 'Build', review: 'Review', coordination: 'Plan' };
const STEP_HINT: Record<WorkflowTaskKind, string> = { code: 'Writes code on its own branch', review: 'Independent read-only review of a build step', coordination: 'Architect: plans and coordinates, never writes code' };
const STATUS_TONE: Record<Workflow['status'], Tone> = { draft: 'idle', running: 'ok', paused: 'warn', blocked: 'warn', failed: 'crit', completed: 'accent', canceled: 'idle' };
const TASK_TONE: Record<WorkflowTaskStatus, Tone> = { pending: 'idle', queued: 'info', running: 'ok', verifying: 'info', done: 'accent', changes_requested: 'warn', blocked: 'warn', failed: 'crit', canceled: 'idle' };
const NODE_W = 196;
const NODE_H = 92;
const COL = 240;
const ROW = 118;
const PAD = 24;
const HEAD = 52;

// ---- persistence -------------------------------------------------------------------------------

function useCanvasLayout() {
  const [layout, setLayout] = useState<CanvasLayout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rev = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<CanvasLayout | null>(null);
  const load = useCallback(async () => {
    try { const r = await api<{ layout: CanvasLayout; rev: number }>('/api/canvas'); rev.current = r.rev; setLayout(r.layout); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setLayout(l => l ?? emptyCanvas()); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const flush = useCallback(async () => {
    const next = pending.current; pending.current = null; if (!next) return;
    try { const r = await api<{ rev: number }>('/api/canvas', { method: 'PUT', body: { layout: next, rev: rev.current } }); rev.current = r.rev; setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); if (e instanceof ApiError && e.status === 409) void load(); }
  }, [load]);
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); void flush(); } }, [flush]);
  const update = useCallback((fn: (l: CanvasLayout) => CanvasLayout) => {
    setLayout(cur => {
      const next = fn(cur ?? emptyCanvas());
      pending.current = next;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { timer.current = null; void flush(); }, 500);
      return next;
    });
  }, [flush]);
  /** Adopt a layout the daemon already saved (terminate returns one). */
  const adopt = useCallback((l: CanvasLayout, r: number) => { rev.current = r; pending.current = null; setLayout(l); }, []);
  return { layout, update, adopt, error };
}

// ---- frame model ---------------------------------------------------------------------------------

interface FrameModel {
  id: string;
  name: string;
  editable: boolean;
  workflow: Workflow | null;
  sketch: CanvasSketch | null;
  tasks: CanvasSketchTask[];
  issues: string[];
  issuesFound: WorkflowIssue[];
  frame: CanvasFrame | undefined;
  attention: ReturnType<typeof workflowAttention> | null;
  visible: boolean;
}

function frameModels(state: ControlState, layout: CanvasLayout): FrameModel[] {
  const out: FrameModel[] = [];
  const workflows = Object.values(state.workflows ?? {}).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const editingIds = new Set(Object.values(layout.sketches).map(s => s.workflowId).filter(Boolean));
  for (const w of workflows) {
    const sketch = layout.sketches[w.id] ?? (editingIds.has(w.id) ? Object.values(layout.sketches).find(s => s.workflowId === w.id) ?? null : null);
    if (sketch && w.status === 'draft') continue; // drawn from the sketch below
    const attention = workflowAttention(w, state);
    const frame = layout.frames[w.id];
    const tasks = w.definition.tasks.map(t => ({ ...t, dependsOn: t.dependsOn.filter(d => d !== t.reviewOf), pickup: null }));
    out.push({ id: w.id, name: w.definition.name, editable: !isWorkflowLocked(w), workflow: w, sketch: null, tasks, issues: issueIds(tasks, []), issuesFound: [], frame, attention, visible: frameVisible(frame, attention) });
  }
  for (const s of Object.values(layout.sketches)) {
    const w = s.workflowId ? state.workflows?.[s.workflowId] ?? null : null;
    if (w && w.status !== 'draft') continue; // finalized elsewhere; the stale sketch is ignored
    const found = validateWorkflow(sketchDefinition(s), state, { workflowId: s.workflowId, projectChecks: state.project?.checks });
    out.push({ id: s.id, name: s.name || 'Untitled workflow', editable: true, workflow: w, sketch: s, tasks: s.tasks, issues: issueIds(s.tasks, s.issues), issuesFound: found, frame: layout.frames[s.id], attention: null, visible: true });
  }
  return out;
}

function issueIds(tasks: CanvasSketchTask[], extra: string[]): string[] {
  return [...new Set([...tasks.filter(t => t.kind !== 'review' && t.workItemId).map(t => t.workItemId), ...extra])];
}

/** Auto layout: issues in the first column, steps by dependency depth after it. Saved positions win. */
function autoPositions(m: FrameModel): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  m.issues.forEach((id, i) => pos.set(`i:${id}`, { x: PAD, y: HEAD + i * ROW }));
  const depth = new Map<string, number>();
  const byId = new Map(m.tasks.map(t => [t.id, t]));
  const visit = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const t = byId.get(id);
    const parents = [...(t?.dependsOn ?? []), ...(t?.reviewOf ? [t.reviewOf] : [])].filter(p => byId.has(p));
    const d = parents.length ? 1 + Math.max(...parents.map(p => visit(p, seen))) : 0;
    depth.set(id, d);
    return d;
  };
  const rows = new Map<number, number>();
  const offset = m.issues.length ? 1 : 0;
  for (const id of topoOrder({ name: '', mode: 'collaborative', tasks: m.tasks.map(t => ({ ...t, requiredChecks: null, reviewOf: t.reviewOf })) })) {
    const d = visit(id);
    const r = rows.get(d) ?? 0;
    rows.set(d, r + 1);
    pos.set(`t:${id}`, { x: PAD + (d + offset) * COL, y: HEAD + r * ROW });
  }
  return pos;
}

// ---- graph building ------------------------------------------------------------------------------

type FrameData = { model: FrameModel; width: number; height: number };
type IssueData = { frameId: string; workItemId: string; editable: boolean };
type TaskData = { frameId: string; task: CanvasSketchTask; editable: boolean; problems: number };

function buildGraph(state: ControlState, layout: CanvasLayout, models: FrameModel[]) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let nextY = 0;
  for (const m of models) {
    if (!m.visible) continue;
    const auto = autoPositions(m);
    const place = (key: string) => layout.nodes[`${m.id}/${key}`] ?? auto.get(key) ?? { x: PAD, y: HEAD };
    const children: Node[] = [];
    for (const id of m.issues) children.push({ id: `${m.id}/i:${id}`, type: 'issue', parentId: `f:${m.id}`, position: place(`i:${id}`), data: { frameId: m.id, workItemId: id, editable: m.editable } satisfies IssueData, connectable: m.editable });
    for (const t of m.tasks) {
      const problems = m.issuesFound.filter(i => i.taskId === t.id).length;
      children.push({ id: `${m.id}/t:${t.id}`, type: 'task', parentId: `f:${m.id}`, position: place(`t:${t.id}`), data: { frameId: m.id, task: t, editable: m.editable, problems } satisfies TaskData, connectable: m.editable });
      const styleFor = (live: boolean) => ({ stroke: live ? 'var(--accent)' : 'var(--border-strong)', strokeWidth: 1.6 });
      const running = m.workflow?.tasks[t.id]?.status === 'running';
      if (t.kind !== 'review' && t.workItemId && m.issues.includes(t.workItemId)) edges.push({ id: `${m.id}/e:i:${t.workItemId}>${t.id}`, source: `${m.id}/i:${t.workItemId}`, target: `${m.id}/t:${t.id}`, style: styleFor(running), animated: running, deletable: m.editable, data: { frameId: m.id, kind: 'issue' } });
      for (const d of t.dependsOn) edges.push({ id: `${m.id}/e:t:${d}>${t.id}`, source: `${m.id}/t:${d}`, target: `${m.id}/t:${t.id}`, style: styleFor(running), animated: running, deletable: m.editable, data: { frameId: m.id, kind: 'dep' } });
      if (t.reviewOf) edges.push({ id: `${m.id}/e:r:${t.reviewOf}>${t.id}`, source: `${m.id}/t:${t.reviewOf}`, target: `${m.id}/t:${t.id}`, style: { ...styleFor(running), strokeDasharray: '5 4' }, label: 'reviews', deletable: m.editable, data: { frameId: m.id, kind: 'review' } });
    }
    const width = Math.max(600, ...children.map(c => c.position.x + NODE_W + PAD));
    const height = Math.max(200, ...children.map(c => c.position.y + NODE_H + PAD));
    const fp = m.frame ? { x: m.frame.x, y: m.frame.y } : { x: 0, y: nextY };
    nextY = Math.max(nextY, fp.y + height + 60);
    nodes.push({ id: `f:${m.id}`, type: 'frame', position: fp, data: { model: m, width, height } satisfies FrameData, style: { width, height }, dragHandle: '.cv-frame-drag', selectable: true, connectable: false, zIndex: -1 });
    nodes.push(...children);
  }
  return { nodes, edges, nextY };
}

// ---- sketch editing helpers ----------------------------------------------------------------------

const now = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function withSketch(layout: CanvasLayout, state: ControlState, frameId: string, fn: (s: CanvasSketch) => CanvasSketch): CanvasLayout {
  let s = layout.sketches[frameId] ?? Object.values(layout.sketches).find(x => x.workflowId === frameId);
  if (!s) {
    const w = state.workflows?.[frameId];
    if (!w || w.status !== 'draft') return layout; // locked: nothing changes
    s = sketchFromWorkflow(w, now());
  }
  const next = fn(s);
  return { ...layout, sketches: { ...layout.sketches, [next.id]: { ...next, updatedAt: now() } } };
}

function nextTaskId(s: CanvasSketch, kind: WorkflowTaskKind): string {
  const base = kind === 'code' ? 'build' : kind === 'review' ? 'review' : 'plan';
  for (let n = 1; ; n++) { const id = `${base}-${n}`; if (!s.tasks.some(t => t.id === id)) return id; }
}

function removeTask(s: CanvasSketch, id: string): CanvasSketch {
  return { ...s, tasks: s.tasks.filter(t => t.id !== id).map(t => ({ ...t, dependsOn: t.dependsOn.filter(d => d !== id), reviewOf: t.reviewOf === id ? null : t.reviewOf })) };
}

// ---- node renderers -------------------------------------------------------------------------------

interface CanvasCtx { state: ControlState; actions: FrameActions }
interface FrameActions {
  save(m: FrameModel, start: boolean): void;
  discard(m: FrameModel): void;
  act(m: FrameModel, action: 'pause' | 'resume'): void;
  terminate(m: FrameModel): void;
  setHidden(m: FrameModel, hidden: boolean, showWhen?: CanvasShowWhen): void;
  rename(m: FrameModel, name: string): void;
  select(nodeId: string | null): void;
  busy: boolean;
}
const CanvasContext = createContext<CanvasCtx | null>(null);
const useCanvasCtx = () => useContext(CanvasContext)!;

function FrameNode({ data, selected }: NodeProps<Node<FrameData>>) {
  const { model: m, width, height } = data;
  const ctx = useCanvasCtx();
  const w = m.workflow;
  const p = w ? workflowProgress(w) : null;
  const status = m.sketch ? (m.sketch.workflowId ? 'draft · editing' : 'sketch') : w?.status ?? 'draft';
  const problems = m.issuesFound.length;
  const locked = !m.editable;
  const shownForAttention = m.frame?.hidden && m.visible;
  return (
    <div className={`cv-frame${selected ? ' selected' : ''}${locked ? ' locked' : ''}`} style={{ width, height }} aria-label={`Workflow ${m.name}`}>
      <div className="cv-frame-h">
        <span className="cv-frame-drag" title="Drag to move this workflow" aria-hidden="true">⠿</span>
        {m.editable ? <input className="cv-frame-name nodrag" aria-label="Workflow name" value={m.sketch?.name ?? m.name} placeholder="Name this workflow" onChange={e => ctx.actions.rename(m, e.target.value)} /> : <b className="cv-frame-name">{locked && <Icon name="lock" size={13} />} {m.name}</b>}
        <Badge tone={w && !m.sketch ? STATUS_TONE[w.status] : 'idle'}>{status}</Badge>
        {p && !m.editable && <span className="small faint mono">{p.done}/{p.total}</span>}
        {m.attention && m.attention.input > 0 && <Link className="cv-attn nodrag" to="/inbox">{m.attention.input} waiting on you</Link>}
        {shownForAttention && <span className="small faint">shown because it needs you</span>}
        <span className="spacer" />
        {m.editable && <>
          {m.tasks.length === 0 ? <span className="small faint">Add a step to start</span> : <>
            <span className={`small ${problems ? 'crit-text' : 'faint'}`} title={m.issuesFound.map(i => i.message).join('\n')}>{problems ? `${problems} to fix` : 'Ready'}</span>
            {m.sketch && <button type="button" className="btn sm nodrag" disabled={ctx.actions.busy || problems > 0} onClick={() => ctx.actions.save(m, false)}>Save draft</button>}
            <button type="button" className="btn sm primary nodrag" disabled={ctx.actions.busy || problems > 0} onClick={() => ctx.actions.save(m, true)}><Icon name="play" size={12} />Finalize and run</button>
          </>}
          {m.sketch && <button type="button" className="btn sm ghost nodrag" disabled={ctx.actions.busy} onClick={() => ctx.actions.discard(m)}>Discard</button>}
        </>}
        {w && !m.editable && <>
          {(w.status === 'running' || w.status === 'blocked' || w.status === 'failed') && <button type="button" className="btn sm nodrag" disabled={ctx.actions.busy} onClick={() => ctx.actions.act(m, 'pause')}><Icon name="pause" size={12} />Pause</button>}
          {w.status === 'paused' && <button type="button" className="btn sm nodrag" disabled={ctx.actions.busy} onClick={() => ctx.actions.act(m, 'resume')}><Icon name="play" size={12} />Resume</button>}
          {w.status !== 'completed' && w.status !== 'canceled' && <button type="button" className="btn sm danger nodrag" disabled={ctx.actions.busy} onClick={() => ctx.actions.terminate(m)}>Terminate</button>}
          <button type="button" className="btn sm ghost nodrag" onClick={() => ctx.actions.select(`f:${m.id}`)} title="Choose when this workflow shows on the canvas"><Icon name="eyeOff" size={12} />{m.frame?.hidden ? 'Hidden' : 'Hide'}</button>
        </>}
      </div>
      {m.editable && !m.tasks.length && !m.issues.length && <div className="cv-frame-empty small muted">Press <b>+ Add node</b> (or double-click the canvas) to add an issue and agent steps, then connect them.</div>}
    </div>
  );
}

function IssueNode({ data, selected }: NodeProps<Node<IssueData>>) {
  const item = useCanvasCtx().state.workItems[data.workItemId];
  return (
    <div className={`cv-node cv-issue${selected ? ' selected' : ''}`}>
      <div className="cv-node-h">Issue {item?.key ?? ''}</div>
      <div className="cv-node-b">{item ? <><div className="ellipsis2">{item.title}</div><span className="small faint">{item.state}</span></> : <span className="crit-text small">Issue not found</span>}</div>
      <Handle type="source" position={Position.Right} id="out" isConnectable={data.editable} aria-label="Connect this issue to a step" />
    </div>
  );
}

function TaskNode({ data, selected }: NodeProps<Node<TaskData>>) {
  const { state } = useCanvasCtx();
  const t = data.task;
  const agent = state.agents[t.agentId];
  const w = state.workflows?.[data.frameId];
  const st = w && w.status !== 'draft' ? w.tasks[t.id] : null;
  return (
    <div className={`cv-node cv-task kind-${t.kind}${selected ? ' selected' : ''}${data.problems ? ' problem' : ''}`}>
      <Handle type="target" position={Position.Left} id="in" isConnectable={data.editable} aria-label="Connect an input to this step" />
      <div className="cv-node-h"><span>{STEP_LABEL[t.kind]}</span><span className="grow ellipsis">{agent ? ` · ${agent.config.name}` : ' · choose an agent'}</span>{st && <Badge tone={TASK_TONE[st.status]}>{st.status.replace('_', ' ')}</Badge>}</div>
      <div className="cv-node-b">
        <div className="ellipsis2">{t.title || <span className="faint">{t.id}</span>}</div>
        {t.pickup && <span className="small cv-pickup">Has a pickup point</span>}
        {data.problems > 0 && <span className="small crit-text">{data.problems} to fix</span>}
      </div>
      <Handle type="source" position={Position.Right} id="out" isConnectable={data.editable} aria-label="Connect this step to a later step" />
    </div>
  );
}

const NODE_TYPES = { frame: FrameNode, issue: IssueNode, task: TaskNode };

// ---- canvas -------------------------------------------------------------------------------------

export function Canvas({ state }: { state: ControlState }) {
  return <ReactFlowProvider><CanvasInner state={state} /></ReactFlowProvider>;
}

function CanvasInner({ state }: { state: ControlState }) {
  const navigate = useNavigate();
  const { layout, update, adopt, error: saveError } = useCanvasLayout();
  const { busy, error, run } = useAction();
  const flow = useReactFlow();
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState<null | { x: number; y: number }>(null);
  const [trayOpen, setTrayOpen] = useState(false);
  const models = useMemo(() => layout ? frameModels(state, layout) : [], [state, layout]);
  const graph = useMemo(() => layout ? buildGraph(state, layout, models) : { nodes: [], edges: [], nextY: 0 }, [state, layout, models]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  useEffect(() => {
    setNodes(prev => {
      const byId = new Map(prev.map(n => [n.id, n]));
      return graph.nodes.map(n => { const p = byId.get(n.id); return p ? { ...n, position: p.dragging ? p.position : n.position, measured: p.measured, selected: p.selected } : n; });
    });
  }, [graph.nodes, setNodes]);

  const frameOf = (nodeId: string) => models.find(m => nodeId === `f:${m.id}` || nodeId.startsWith(`${m.id}/`));
  const editFrame = (frameId: string, fn: (s: CanvasSketch) => CanvasSketch) => update(l => withSketch(l, state, frameId, fn));

  const select = (id: string | null) => { setSelected(id); setNodes(ns => ns.map(n => ({ ...n, selected: n.id === id }))); };
  const actions: FrameActions = {
    busy,
    select,
    rename: (m, name) => editFrame(m.id, s => ({ ...s, name: name.slice(0, 120) })),
    discard: m => { if (!m.sketch) return; if (!window.confirm(m.sketch.workflowId ? 'Discard your unsaved changes to this draft?' : `Discard "${m.name}"? It was never saved.`)) return; update(l => { const sketches = { ...l.sketches }; delete sketches[m.sketch!.id]; return { ...l, sketches }; }); },
    save: (m, start) => void run(async () => {
      if (start && !window.confirm(`Finalize and run "${m.name}"? Each step goes through pre-flight and the agent's queue. A running workflow can't be edited until you terminate it.`)) return;
      let id = m.workflow?.id ?? null;
      if (m.sketch) {
        const r = await post<{ workflow: Workflow }>('/api/workflows', { id: m.sketch.workflowId, definition: sketchDefinition(m.sketch), expectedVersion: m.sketch.version });
        id = r.workflow.id;
        const sketchId = m.sketch.id;
        update(l => {
          const sketches = { ...l.sketches }; delete sketches[sketchId];
          if (sketchId === id) return { ...l, sketches };
          const frames = { ...l.frames }; if (frames[sketchId]) { frames[id!] = frames[sketchId]; delete frames[sketchId]; }
          const nodesPos: CanvasLayout['nodes'] = {};
          for (const [k, v] of Object.entries(l.nodes)) nodesPos[k.startsWith(`${sketchId}/`) ? `${id}/${k.slice(sketchId.length + 1)}` : k] = v;
          return { ...l, sketches, frames, nodes: nodesPos };
        });
      }
      if (start && id) await post(`/api/workflows/${encodeURIComponent(id)}/start`);
    }),
    act: (m, a) => void run(() => post(`/api/workflows/${encodeURIComponent(m.workflow!.id)}/${a}`)),
    terminate: m => {
      if (!window.confirm(`Terminate "${m.name}"?\n\nRunning agents are stopped. Their sessions, transcripts, branches and evidence are kept. Finished steps stay locked; unfinished steps reopen below as an editable draft that carries each step's pickup point from its last handoff.`)) return;
      void run(async () => {
        const r = await post<{ layout: CanvasLayout; rev: number; sketchId: string }>(`/api/canvas/workflows/${encodeURIComponent(m.workflow!.id)}/terminate`);
        adopt(r.layout, r.rev);
        setSelected(`f:${r.sketchId}`);
      });
    },
    setHidden: (m, hidden, showWhen) => update(l => ({ ...l, frames: { ...l.frames, [m.id]: { x: l.frames[m.id]?.x ?? nodes.find(n => n.id === `f:${m.id}`)?.position.x ?? 0, y: l.frames[m.id]?.y ?? nodes.find(n => n.id === `f:${m.id}`)?.position.y ?? 0, hidden, showWhen: showWhen ?? l.frames[m.id]?.showWhen ?? DEFAULT_SHOW_WHEN } } })),
  };

  const onConnect = (c: Connection) => {
    if (!c.source || !c.target) return;
    const m = frameOf(c.source);
    if (!m || !m.editable || frameOf(c.target)?.id !== m.id) return;
    const src = c.source.slice(m.id.length + 1);
    const tgt = c.target.slice(m.id.length + 1);
    if (!tgt.startsWith('t:')) return;
    const targetId = tgt.slice(2);
    editFrame(m.id, s => ({ ...s, tasks: s.tasks.map(t => {
      if (t.id !== targetId) return t;
      if (src.startsWith('i:')) return t.kind === 'review' ? t : { ...t, workItemId: src.slice(2) };
      const from = s.tasks.find(x => x.id === src.slice(2));
      if (!from || from.id === t.id) return t;
      if (t.kind === 'review' && from.kind === 'code' && !t.reviewOf) return { ...t, reviewOf: from.id, workItemId: from.workItemId };
      return t.dependsOn.includes(from.id) ? t : { ...t, dependsOn: [...t.dependsOn, from.id] };
    }) }));
  };

  const onEdgesDelete = (deleted: Edge[]) => {
    for (const e of deleted) {
      const m = frameOf(e.source);
      if (!m?.editable) continue;
      const src = e.source.slice(m.id.length + 1);
      const targetId = e.target.slice(m.id.length + 3);
      editFrame(m.id, s => ({ ...s, tasks: s.tasks.map(t => t.id !== targetId ? t
        : src.startsWith('i:') ? { ...t, workItemId: '' }
        : t.reviewOf === src.slice(2) ? { ...t, reviewOf: null }
        : { ...t, dependsOn: t.dependsOn.filter(d => d !== src.slice(2)) }) }));
    }
  };

  const onNodesDelete = (deleted: Node[]) => {
    for (const n of deleted) {
      if (n.type === 'frame') continue; // frames are discarded or terminated explicitly
      const m = frameOf(n.id);
      if (!m?.editable) continue;
      const key = n.id.slice(m.id.length + 1);
      editFrame(m.id, s => key.startsWith('t:') ? removeTask(s, key.slice(2))
        : { ...s, issues: s.issues.filter(i => i !== key.slice(2)), tasks: s.tasks.map(t => t.workItemId === key.slice(2) && t.kind !== 'review' ? { ...t, workItemId: '' } : t) });
    }
    setSelected(null);
  };

  const onNodeDragStop = (_: unknown, _n: Node, dragged: Node[]) => {
    update(l => {
      const frames = { ...l.frames };
      const pos = { ...l.nodes };
      for (const n of dragged) {
        if (n.type === 'frame') { const id = n.id.slice(2); frames[id] = { ...(frames[id] ?? { hidden: false, showWhen: DEFAULT_SHOW_WHEN }), x: Math.round(n.position.x), y: Math.round(n.position.y) }; }
        else pos[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
      }
      return { ...l, frames, nodes: pos };
    });
  };

  /** Add a node at a canvas point: into the selected (or nearest) editable frame, else a new sketch. */
  const addNode = (kind: 'workflow' | 'issue' | WorkflowTaskKind, workItemId?: string) => {
    const point = adding ?? { x: 0, y: graph.nextY };
    const target = selected ? frameOf(selected) : undefined;
    const frameId = target?.editable ? target.id : null;
    if (kind === 'workflow' || !frameId) {
      const id = newId('sketch');
      const sketch: CanvasSketch = { id, name: '', mode: 'collaborative', workflowId: null, version: null, continues: null, tasks: [], issues: [], updatedAt: now() };
      if (kind === 'issue' && workItemId) sketch.issues = [workItemId];
      if (kind !== 'workflow' && kind !== 'issue') sketch.tasks = [{ id: nextTaskId(sketch, kind), title: '', kind, agentId: '', workItemId: '', dependsOn: [], reviewOf: null, allowedPaths: [], pickup: null }];
      update(l => ({ ...l, sketches: { ...l.sketches, [id]: sketch }, frames: { ...l.frames, [id]: { x: Math.round(point.x), y: Math.round(point.y), hidden: false, showWhen: DEFAULT_SHOW_WHEN } } }));
      setSelected(`f:${id}`);
    } else if (kind === 'issue' && workItemId) {
      editFrame(frameId, s => ({ ...s, issues: s.issues.includes(workItemId) ? s.issues : [...s.issues, workItemId] }));
    } else if (kind !== 'issue') {
      editFrame(frameId, s => {
        const id = nextTaskId(s, kind);
        const after = selected && selected.startsWith(`${frameId}/t:`) ? selected.slice(frameId.length + 3) : null;
        const from = after ? s.tasks.find(t => t.id === after) : undefined;
        const task: CanvasSketchTask = { id, title: '', kind, agentId: '', workItemId: from && kind !== 'review' ? from.workItemId : '', dependsOn: from && kind !== 'review' ? [from.id] : [], reviewOf: from && kind === 'review' && from.kind === 'code' ? from.id : null, allowedPaths: [], pickup: null };
        if (task.reviewOf) task.workItemId = from!.workItemId;
        return { ...s, tasks: [...s.tasks, task] };
      });
    }
    setAdding(null);
  };

  const hidden = models.filter(m => !m.visible);
  const selModel = selected ? frameOf(selected) : undefined;
  const empty = layout && models.length === 0;

  return (
    <div className="cv">
      <div className="cv-toolbar" role="toolbar" aria-label="Canvas">
        <button type="button" className="btn sm primary" onClick={() => setAdding(a => a ? null : { x: 0, y: graph.nextY })} aria-expanded={Boolean(adding)}><Icon name="plus" size={14} />Add node</button>
        <button type="button" className="btn sm" onClick={() => flow.fitView({ padding: 0.15, maxZoom: 1, duration: 250 })}><Icon name="fit" size={14} />Fit</button>
        {hidden.length > 0 && <button type="button" className="btn sm" aria-expanded={trayOpen} onClick={() => setTrayOpen(v => !v)}><Icon name="eyeOff" size={14} />Hidden {hidden.length}</button>}
        {(saveError || error) && <span className="small crit-text" role="alert">{saveError ?? error}</span>}
      </div>
      {trayOpen && hidden.length > 0 && <div className="cv-tray" role="region" aria-label="Hidden workflows">
        {hidden.map(m => <div key={m.id} className="cv-tray-row"><Icon name="lock" size={13} /><span className="grow ellipsis">{m.name}</span>{m.workflow && <Badge tone={STATUS_TONE[m.workflow.status]}>{m.workflow.status}</Badge>}<button type="button" className="btn sm" onClick={() => actions.setHidden(m, false)}>Show</button></div>)}
        <p className="small faint">Hidden workflows come back on their own when they reach a condition you chose.</p>
      </div>}
      {adding && <AddPalette state={state} target={selModel?.editable ? selModel : undefined} onPick={addNode} onDesign={() => { setAdding(null); navigate('/designer'); }} onClose={() => setAdding(null)} />}
      {!empty && hidden.length > 0 && hidden.length === models.length && <p className="cv-quiet muted">Every workflow is hidden. Each one comes back here when it reaches a condition you chose.</p>}
      {empty && <div className="cv-empty"><h1>Start a workflow</h1><p className="muted">Add an issue, connect it to agent steps (plan, build, review), then finalize it to run. Everything else lives in the top bar.</p><button type="button" className="btn primary" onClick={() => addNode('workflow')}>New workflow</button></div>}
      <CanvasContext.Provider value={{ state, actions }}>
      <ReactFlow
        nodes={nodes}
        edges={graph.edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        onNodesDelete={onNodesDelete}
        onNodeDragStop={onNodeDragStop}
        onSelectionChange={({ nodes: sel }) => setSelected(sel[0]?.id ?? null)}
        onPaneClick={() => setSelected(null)}
        onDoubleClick={e => { if ((e.target as HTMLElement).classList.contains('react-flow__pane')) setAdding(flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })); }}
        zoomOnDoubleClick={false}
        colorMode="system"
        deleteKeyCode={['Backspace', 'Delete']}
        minZoom={0.25}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        proOptions={{ hideAttribution: false }}
        aria-label="Workflow canvas"
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable ariaLabel="Canvas overview" />
      </ReactFlow>
      </CanvasContext.Provider>
      {selected && selModel && <Inspector state={state} model={selModel} nodeId={selected} editFrame={editFrame} actions={actions} onClose={() => select(null)} />}
    </div>
  );
}

// ---- add-node palette ----------------------------------------------------------------------------

function AddPalette({ state, target, onPick, onDesign, onClose }: { state: ControlState; target?: FrameModel; onPick: (kind: 'workflow' | 'issue' | WorkflowTaskKind, workItemId?: string) => void; onDesign: () => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const items = Object.values(state.workItems).filter(w => w.state !== 'verified' && w.state !== 'canceled' && `${w.key ?? ''} ${w.title}`.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  const steps: { kind: WorkflowTaskKind | 'workflow'; label: string; hint: string }[] = [
    { kind: 'coordination', label: 'Plan step', hint: STEP_HINT.coordination },
    { kind: 'code', label: 'Build step', hint: STEP_HINT.code },
    { kind: 'review', label: 'Review step', hint: STEP_HINT.review },
    { kind: 'workflow', label: 'New empty workflow', hint: 'A new frame to build in' },
  ];
  const match = (s: string) => s.toLowerCase().includes(q.toLowerCase());
  return (
    <div className="cv-palette" role="dialog" aria-label="Add a node" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <input ref={input} aria-label="Search nodes and issues" placeholder="Search steps or issues" value={q} onChange={e => setQ(e.target.value)} />
      <p className="small faint">{target ? `Adding to “${target.name}”` : 'Adds a new workflow. Select a draft workflow first to add into it.'}</p>
      <div className="cv-palette-group" role="group" aria-label="Agent steps">
        {steps.filter(s => match(`${s.label} ${s.hint}`)).map(s => <button key={s.kind} type="button" onClick={() => onPick(s.kind)}><b>{s.label}</b><span className="small faint">{s.hint}</span></button>)}
        {match('design screen mock designer') && <button type="button" onClick={onDesign}><b>Design a screen</b><span className="small faint">Opens Designer to brief a design job</span></button>}
      </div>
      <div className="cv-palette-group" role="group" aria-label="Issues">
        <span className="small muted">Issues</span>
        {items.map(w => <button key={w.id} type="button" onClick={() => onPick('issue', w.id)}><b>{w.key ?? 'pending'}</b><span className="small faint ellipsis">{w.title}</span></button>)}
        {items.length === 0 && <span className="small faint">No open issues match.</span>}
        <button type="button" onClick={() => setCreating(true)}><b>Create an issue…</b><span className="small faint">Adds it to the tracker and to this workflow</span></button>
        <Link className="small" to="/board">Open the issue list</Link>
        {creating && <NewIssueDialog trackerTarget="the project tracker" onClose={() => setCreating(false)} onCreated={item => onPick('issue', item.id)} />}
      </div>
    </div>
  );
}

// ---- inspector --------------------------------------------------------------------------------------

function Inspector({ state, model: m, nodeId, editFrame, actions, onClose }: { state: ControlState; model: FrameModel; nodeId: string; editFrame: (frameId: string, fn: (s: CanvasSketch) => CanvasSketch) => void; actions: FrameActions; onClose: () => void }) {
  const { busy, error, run } = useAction();
  const key = nodeId.startsWith('f:') ? null : nodeId.slice(m.id.length + 1);
  const task = key?.startsWith('t:') ? m.tasks.find(t => t.id === key.slice(2)) : undefined;
  const item = key?.startsWith('i:') ? state.workItems[key.slice(2)] : undefined;
  const patch = (p: Partial<CanvasSketchTask>) => task && editFrame(m.id, s => ({ ...s, tasks: s.tasks.map(t => t.id === task.id ? { ...t, ...p } : t) }));
  const items = Object.values(state.workItems).filter(w => w.state !== 'verified' && w.state !== 'canceled');
  const agents = Object.values(state.agents);
  const w = m.workflow && !m.editable ? m.workflow : null;
  const st = task && w ? w.tasks[task.id] : null;
  const runs = st?.assignmentId ? Object.values(state.runs).filter(r => r.assignmentId === st.assignmentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
  const problems = task ? m.issuesFound.filter(i => i.taskId === task.id) : m.issuesFound.filter(i => !i.taskId);
  return (
    <aside className="cv-inspector" aria-label="Inspector">
      <div className="row"><b className="grow">{task ? `${STEP_LABEL[task.kind]} step` : item ? `Issue ${item.key ?? ''}` : m.name}</b><button type="button" className="btn sm ghost" onClick={onClose} aria-label="Close inspector"><Icon name="close" size={14} /></button></div>
      {!m.editable && <p className="small faint"><Icon name="lock" size={12} /> Finalized. Terminate the workflow to change it.</p>}
      {task && m.editable && <div className="col" style={{ gap: 8 }}>
        <label className="col"><span className="small muted">Title</span><input value={task.title} onChange={e => patch({ title: e.target.value })} placeholder="What this step delivers" /></label>
        <label className="col"><span className="small muted">Step</span><select value={task.kind} onChange={e => patch({ kind: e.target.value as WorkflowTaskKind, reviewOf: null })}>{(['coordination', 'code', 'review'] as const).map(k => <option key={k} value={k}>{STEP_LABEL[k]}: {STEP_HINT[k]}</option>)}</select></label>
        <label className="col"><span className="small muted">Agent</span><select value={task.agentId} onChange={e => patch({ agentId: e.target.value })}><option value="">Choose an agent…</option>{agents.map(a => <option key={a.id} value={a.id} disabled={a.config.enabled === false}>{a.config.name}{a.config.mode === 'coordinator-only' ? ' (coordinator-only)' : ''}{a.config.enabled === false ? ' (disabled)' : ''}</option>)}</select></label>
        {task.kind === 'review'
          ? <label className="col"><span className="small muted">Reviews</span><select value={task.reviewOf ?? ''} onChange={e => patch({ reviewOf: e.target.value || null, workItemId: m.tasks.find(t => t.id === e.target.value)?.workItemId ?? task.workItemId })}><option value="">Choose a build step…</option>{m.tasks.filter(t => t.kind === 'code').map(t => <option key={t.id} value={t.id}>{t.title || t.id}</option>)}</select></label>
          : <label className="col"><span className="small muted">Issue</span><select value={task.workItemId} onChange={e => patch({ workItemId: e.target.value })}><option value="">Choose an issue…</option>{items.map(i => <option key={i.id} value={i.id}>{i.key ?? 'pending'} · {i.title}</option>)}</select></label>}
        {task.kind !== 'review' && <label className="col"><span className="small muted">Allowed paths (empty = whole repo)</span><input value={task.allowedPaths.join(', ')} onChange={e => patch({ allowedPaths: e.target.value.split(/[,\n]/).map(p => p.trim()).filter(Boolean) })} placeholder="src/api/**, docs/api.md" /></label>}
        <span className="small faint">Starts after: {task.dependsOn.length ? task.dependsOn.join(', ') : 'nothing (connect steps to order them)'}</span>
        {task.pickup && <div className="cv-pickup-box"><b className="small">Pickup point from the previous attempt</b><pre>{task.pickup}</pre></div>}
        <button type="button" className="btn sm danger" onClick={() => { editFrame(m.id, s => removeTask(s, task.id)); onClose(); }}>Remove step</button>
      </div>}
      {task && !m.editable && <div className="col" style={{ gap: 8 }}>
        <div><b>{task.title || task.id}</b> <span className="small faint">{STEP_HINT[task.kind]}</span></div>
        <div className="small">Agent: {state.agents[task.agentId] ? <Link to={`/agents/${encodeURIComponent(task.agentId)}`}>{state.agents[task.agentId].config.name}</Link> : task.agentId}</div>
        {st && <div className="row small wrap"><Badge tone={TASK_TONE[st.status]}>{st.status.replace('_', ' ')}</Badge>{st.completedSha && <span className="mono faint">@ {st.completedSha.slice(0, 10)}</span>}{st.attempts > 1 && <span className="faint">attempt {st.attempts}</span>}</div>}
        {st?.reason && <div className="small muted">{st.reason}</div>}
        {runs.length > 0 && <div className="col" style={{ gap: 4 }}><span className="small muted">Runs</span>{runs.slice(0, 5).map(r => <Link key={r.id} className="small" to={`/runs/${encodeURIComponent(r.id)}`}>{r.state} · {new Date(r.createdAt).toLocaleString()}</Link>)}</div>}
        <div className="row wrap" style={{ gap: 6 }}>
          <Link className="btn sm" to="/workspace">Terminal</Link>
          {item === undefined && task.workItemId && <Link className="btn sm" to={`/board?item=${encodeURIComponent(task.workItemId)}`}>Issue</Link>}
          {w && st && ['failed', 'blocked', 'changes_requested'].includes(st.status) && w.status !== 'canceled' && w.status !== 'completed' && <button type="button" className="btn sm" disabled={busy} onClick={() => void run(() => post(`/api/workflows/${encodeURIComponent(w.id)}/tasks/${encodeURIComponent(task.id)}/retry`))}>Retry step</button>}
        </div>
      </div>}
      {item && <div className="col" style={{ gap: 8 }}>
        <div><b>{item.title}</b></div>
        <span className="small faint">{item.state}{item.labels.length ? ` · ${item.labels.join(', ')}` : ''}</span>
        <Link className="btn sm" to={`/board?item=${encodeURIComponent(item.id)}`}>Open issue</Link>
        {m.editable && <button type="button" className="btn sm danger" onClick={() => { editFrame(m.id, s => ({ ...s, issues: s.issues.filter(i => i !== item.id), tasks: s.tasks.map(t => t.workItemId === item.id && t.kind !== 'review' ? { ...t, workItemId: '' } : t) })); onClose(); }}>Remove from workflow</button>}
      </div>}
      {!task && !item && <div className="col" style={{ gap: 8 }}>
        {m.editable && <label className="col"><span className="small muted">Order</span><select value={m.sketch?.mode ?? m.workflow?.definition.mode ?? 'collaborative'} onChange={e => editFrame(m.id, s => ({ ...s, mode: e.target.value === 'independent' ? 'independent' : 'collaborative' }))}><option value="collaborative">Follow the connections (dependency order)</option><option value="independent">Run every step in parallel</option></select></label>}
        {m.sketch?.continues && <span className="small faint">Continues a terminated workflow. Finished steps stay on the original.</span>}
        {m.workflow && !m.editable && <span className="small">{m.workflow.statusReason ?? `Workflow is ${m.workflow.status}.`}</span>}
        <span className="small faint">{m.tasks.length} step{m.tasks.length === 1 ? '' : 's'} · {m.issues.length} issue{m.issues.length === 1 ? '' : 's'}</span>
        {m.workflow && !m.editable && <Visibility model={m} actions={actions} />}
      </div>}
      {problems.length > 0 && <ul className="cv-problems">{problems.map((p, i) => <li key={i} className="small crit-text">{p.message}</li>)}</ul>}
      <ErrorLine error={error} />
    </aside>
  );
}

/** Hide a finalized workflow from the canvas and choose what brings it back. */
function Visibility({ model: m, actions }: { model: FrameModel; actions: FrameActions }) {
  const hidden = Boolean(m.frame?.hidden);
  const show: CanvasShowWhen = m.frame?.showWhen ?? DEFAULT_SHOW_WHEN;
  const set = (patch: Partial<CanvasShowWhen>) => actions.setHidden(m, hidden, { ...show, ...patch });
  return (
    <fieldset className="cv-visibility">
      <legend className="small">On the canvas</legend>
      <label><input type="checkbox" checked={hidden} onChange={e => actions.setHidden(m, e.target.checked, show)} /> Hide this workflow</label>
      <span className="small muted">{hidden ? 'It comes back on its own when:' : 'When hidden, bring it back when:'}</span>
      <label><input type="checkbox" checked={show.input} onChange={e => set({ input: e.target.checked })} /> it needs my input</label>
      <label><input type="checkbox" checked={show.failure} onChange={e => set({ failure: e.target.checked })} /> something fails or blocks</label>
      <label><input type="checkbox" checked={show.finished} onChange={e => set({ finished: e.target.checked })} /> it finishes</label>
      {hidden && m.visible && <span className="small cv-attn">Shown now because one of these is true.</span>}
    </fieldset>
  );
}
