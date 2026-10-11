// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Project canvas, ComfyUI-style. Each workflow is a frame holding a typed node graph: agents,
// issues, steps, Designer artifacts, skills, connectors, One Ask answers, summaries and notes.
// Typed, colored ports only connect to matching types. Double-click the canvas (or drop a link on
// empty space) to search for a node; drag from the library; right-click for actions. Workflows
// connect to each other directly or through a decision (yours, or JEV's within limits you set).
// Drafts are edited in place; Run locks a workflow until it is terminated.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Background, BackgroundVariant, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useNodesState, useReactFlow,
  type Connection, type Edge, type FinalConnectionState, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {
  CanvasFrame, CanvasGate, CanvasGraph, CanvasLayout, CanvasShowWhen, CanvasSketch, ControlState, GraphNode, GraphNodeType, PortSpec, PortType, Workflow, WorkflowLink, WorkflowTaskStatus,
} from '@acc/core';
import {
  canvasLinkId, compileSketch, DEFAULT_JEV_EVIDENCE_BYTES, DEFAULT_SHOW_WHEN, deriveGraph, EFFORTS, isManualRelay, linkBodyFor, linkMatches, emptyCanvas, frameVisible, isWorkflowLocked, mockGate, NODE_SPECS, NODE_TYPES, nodeData, normalizeGraph, portSpec,
  sketchFromWorkflow, stepTaskId, validateWorkflow, workflowAttention, workflowProgress,
} from '@acc/core';
import { Badge, ErrorLine, useAction } from '../components/common';
import { NewIssueDialog } from '../components/NewIssueDialog';
import { api, ApiError, post } from '../lib/api';
import { hue, initials, type Tone } from '../lib/format';
import { emptyHistory, record, redoStep, undoStep, type History } from '../lib/history';
import { useTheme } from '../lib/theme';
import { Icon } from '../shell/icons';
import { OneAskDock, type AskResult } from '../shell/OneAskDock';
import '../shell/canvas.css';

// ---- constants ------------------------------------------------------------------------------------

const PORT_COLOR: Record<PortType | 'workflow', string> = { agent: '#8b7cf6', issue: '#64748b', flow: '#94a3b8', design: '#ec4899', skill: '#10b981', tools: '#f59e0b', context: '#06b6d4', consult: '#a78bfa', workflow: 'var(--accent)' };
const STEP_LABEL: Record<string, string> = { code: 'Build', review: 'Review', coordination: 'Plan' };
const STEP_HINT: Record<string, string> = { code: 'Writes code on its own branch', review: 'Independent read-only review of a build step', coordination: 'Architect: plans and coordinates, never writes code' };
const STATUS_TONE: Record<Workflow['status'], Tone> = { draft: 'idle', running: 'ok', paused: 'warn', blocked: 'warn', failed: 'crit', completed: 'accent', canceled: 'idle' };
const TASK_TONE: Record<WorkflowTaskStatus, Tone> = { pending: 'idle', queued: 'info', running: 'ok', verifying: 'info', done: 'accent', changes_requested: 'warn', blocked: 'warn', failed: 'crit', canceled: 'idle' };
const COL = 250;
const PAD = 32;
const HEAD = 64;
/** Shape language: agents are round, inputs are pills, steps are cards, decisions are diamonds. */
const SHAPE: Record<GraphNodeType, 'agent' | 'pill' | 'card'> = { agent: 'agent', issue: 'pill', design: 'pill', skill: 'pill', connector: 'pill', ask: 'pill', summary: 'pill', note: 'pill', step: 'card' };
const nodeW = (t: GraphNodeType) => SHAPE[t] === 'agent' ? 130 : SHAPE[t] === 'pill' ? 190 : 220;
const nodeH = (t: GraphNodeType) => SHAPE[t] === 'agent' ? 118 : SHAPE[t] === 'pill' ? 38 : 112;
const STEP_COLOR: Record<string, string> = { coordination: '#8b7cf6', code: '#14b8a6', review: '#f59e0b' };
const PROGRESS: Record<WorkflowTaskStatus, number> = { pending: 0, queued: 12, running: 55, verifying: 82, done: 100, changes_requested: 70, blocked: 40, failed: 100, canceled: 0 };
const EDGE_BASE = { type: 'smoothstep' as const, pathOptions: { borderRadius: 14, offset: 18 } };
const pickColor = (kind: string) => kind.startsWith('gate') || kind === 'workflow' ? PORT_COLOR.workflow : PORT_COLOR[(NODE_SPECS[kind as GraphNodeType]?.outputs[0]?.type ?? 'flow') as PortType];

// ---- persistence -------------------------------------------------------------------------------------

function useCanvasLayout() {
  const [layout, setLayout] = useState<CanvasLayout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState({ undo: 0, redo: 0 });
  const rev = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<CanvasLayout | null>(null);
  // The layout lives in a ref as well so consecutive edits in one event compose and history is recorded exactly once.
  const current = useRef<CanvasLayout | null>(null);
  const history = useRef<History<CanvasLayout>>(emptyHistory());
  const show = useCallback((l: CanvasLayout) => { current.current = l; setLayout(l); }, []);
  const setHistory = useCallback((h: History<CanvasLayout>) => { history.current = h; setSteps({ undo: h.past.length, redo: h.future.length }); }, []);
  const load = useCallback(async () => {
    try { const r = await api<{ layout: CanvasLayout; rev: number }>('/api/canvas'); rev.current = r.rev; show(r.layout); setHistory(emptyHistory()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); if (!current.current) show(emptyCanvas()); }
  }, [show, setHistory]);
  useEffect(() => { void load(); }, [load]);
  const flush = useCallback(async () => {
    const next = pending.current; pending.current = null; if (!next) return;
    try { const r = await api<{ rev: number }>('/api/canvas', { method: 'PUT', body: { layout: next, rev: rev.current } }); rev.current = r.rev; setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); if (e instanceof ApiError && e.status === 409) void load(); }
  }, [load]);
  useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); void flush(); } }, [flush]);
  const commit = useCallback((next: CanvasLayout) => {
    show(next);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void flush(); }, 500);
  }, [show, flush]);
  /** `forget` drops undo history: use it when the edit follows a server-side change that undo must not cross. */
  const update = useCallback((fn: (l: CanvasLayout) => CanvasLayout, opts?: { forget?: boolean }) => {
    const cur = current.current ?? emptyCanvas();
    const next = fn(cur);
    if (next === cur) return;
    setHistory(opts?.forget ? emptyHistory() : record(history.current, cur, Date.now()));
    commit(next);
  }, [commit, setHistory]);
  const undo = useCallback(() => {
    const cur = current.current; const r = cur && undoStep(history.current, cur);
    if (!r) return;
    setHistory(r.history); commit(r.value);
  }, [commit, setHistory]);
  const redo = useCallback(() => {
    const cur = current.current; const r = cur && redoStep(history.current, cur);
    if (!r) return;
    setHistory(r.history); commit(r.value);
  }, [commit, setHistory]);
  const adopt = useCallback((l: CanvasLayout, r: number) => { rev.current = r; pending.current = null; show(l); setHistory(emptyHistory()); }, [show, setHistory]);
  return { layout, update, adopt, undo, redo, canUndo: steps.undo > 0, canRedo: steps.redo > 0, error };
}

// ---- engine links: canvas hand-offs and decisions become durable workflow links --------------------

interface LinkState { link: WorkflowLink | null; waiting: string | null; error: string | null }

/** JEV's configured host when JEV is on; decisions JEV advises on need it. */
function useJevHost(): string | null {
  const [host, setHost] = useState<string | null>(null);
  useEffect(() => { void api<{ enabled: boolean; host: string }>('/api/jev').then(s => setHost(s.enabled ? s.host : null)).catch(() => setHost(null)); }, []);
  return host;
}

/**
 * Keeps the engine's workflow links in step with the canvas. A chain or decision becomes active once
 * both ends are saved workflows and it is complete; edits sync while the link is still waiting; a
 * deleted chain or decision cancels its waiting link. Status comes back live through the event log.
 */
function useLinkSync(state: ControlState, layout: CanvasLayout | null): (kind: 'chain' | 'gate', id: string) => LinkState {
  const jevHost = useJevHost();
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const sending = useRef(new Set<string>());
  const saved = useCallback((id: string) => Boolean(state.workflows?.[id]), [state.workflows]);
  const items = useMemo(() => layout ? [
    ...Object.values(layout.chains).map(chain => ({ key: canvasLinkId('chain', chain.id), ...linkBodyFor({ kind: 'chain', chain }, saved, jevHost) })),
    ...Object.values(layout.gates).map(gate => ({ key: canvasLinkId('gate', gate.id), ...linkBodyFor({ kind: 'gate', gate }, saved, jevHost) })),
  ] : [], [layout, saved, jevHost]);
  const links = state.workflowLinks ?? {};
  useEffect(() => {
    if (!layout) return;
    const t = setTimeout(() => {
      for (const it of items) {
        if (!it.body || sending.current.has(it.key)) continue;
        const existing = links[it.key];
        if (existing && (existing.status !== 'waiting' || linkMatches(existing, it.body))) continue;
        sending.current.add(it.key);
        void post('/api/workflow-links', it.body)
          .then(() => setErrors(e => ({ ...e, [it.key]: null })))
          .catch(err => setErrors(e => ({ ...e, [it.key]: err instanceof Error ? err.message : String(err) })))
          .finally(() => sending.current.delete(it.key));
      }
      const live = new Set(items.map(i => i.key));
      for (const l of Object.values(links)) {
        if (!l.id.startsWith('canvas-') || live.has(l.id) || l.status !== 'waiting' || sending.current.has(l.id)) continue;
        sending.current.add(l.id);
        void post(`/api/workflow-links/${encodeURIComponent(l.id)}/cancel`).catch(() => {}).finally(() => sending.current.delete(l.id));
      }
    }, 700);
    return () => clearTimeout(t);
  }, [items, links, layout]);
  return (kind, id) => { const key = canvasLinkId(kind, id); const it = items.find(i => i.key === key); return { link: links[key] ?? null, waiting: it?.waiting ?? null, error: errors[key] ?? null }; };
}

const LINK_STATUS: Record<WorkflowLink['status'], string> = { waiting: 'armed', open: 'waiting on you', decided: 'decided', started: 'started', canceled: 'canceled' };
const linkLabel = (s: LinkState) => s.error ? 'not active: see inspector' : s.link ? LINK_STATUS[s.link.status] : s.waiting ? 'not active yet' : 'activating…';

// ---- frame model ---------------------------------------------------------------------------------------

interface FrameModel {
  id: string;
  name: string;
  editable: boolean;
  workflow: Workflow | null;
  sketch: CanvasSketch | null;
  graph: CanvasGraph;
  problems: { nodeId: string | null; message: string }[];
  frame: CanvasFrame | undefined;
  attention: ReturnType<typeof workflowAttention> | null;
  visible: boolean;
}

function frameModels(state: ControlState, layout: CanvasLayout): FrameModel[] {
  const out: FrameModel[] = [];
  const sketches = Object.values(layout.sketches);
  for (const w of Object.values(state.workflows ?? {}).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (w.status === 'draft' && sketches.some(s => s.id === w.id || s.workflowId === w.id)) continue; // drawn from its sketch
    const attention = workflowAttention(w, state);
    const frame = layout.frames[w.id];
    out.push({ id: w.id, name: w.definition.name, editable: !isWorkflowLocked(w), workflow: w, sketch: null, graph: deriveGraph(w.definition.tasks), problems: [], frame, attention, visible: frameVisible(frame, attention) });
  }
  for (const s of sketches) {
    const w = s.workflowId ? state.workflows?.[s.workflowId] ?? null : null;
    if (w && w.status !== 'draft') continue;
    const compiled = compileSketch(s);
    const stepOf = new Map(s.graph.nodes.filter(n => n.type === 'step').map(n => [stepTaskId(n), n.id]));
    const engine = compiled.problems.length ? [] : validateWorkflow(compiled.definition, state, { workflowId: s.workflowId, projectChecks: state.project?.checks }).map(i => ({ nodeId: i.taskId ? stepOf.get(i.taskId) ?? null : null, message: i.message }));
    out.push({ id: s.id, name: s.name || 'Untitled workflow', editable: true, workflow: w, sketch: s, graph: s.graph, problems: [...compiled.problems, ...engine], frame: layout.frames[s.id], attention: null, visible: true });
  }
  return out;
}

/** Auto layout: agents and inputs in the first column, steps by dependency depth after it. */
function autoPositions(g: CanvasGraph): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const depth = new Map<string, number>();
  const visit = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const parents = g.edges.filter(e => e.to === id && e.toPort === 'after').map(e => e.from);
    const d = parents.length ? 1 + Math.max(...parents.map(p => visit(p, seen))) : 0;
    depth.set(id, d);
    return d;
  };
  const cols = new Map<number, number>();
  const place = (n: GraphNode, col: number) => { const y = cols.get(col) ?? HEAD; pos.set(n.id, { x: PAD + col * COL, y }); cols.set(col, y + nodeH(n.type) + (SHAPE[n.type] === 'pill' ? 14 : 30)); };
  for (const n of g.nodes.filter(n => n.type === 'agent')) place(n, 0);
  for (const n of g.nodes.filter(n => n.type !== 'agent' && n.type !== 'step')) place(n, 0);
  for (const n of g.nodes.filter(n => n.type === 'step')) place(n, 1 + visit(n.id));
  return pos;
}

// ---- graph building --------------------------------------------------------------------------------------

type FrameData = { model: FrameModel; width: number; height: number };
type GData = { frameId: string; node: GraphNode; editable: boolean; problems: number; connected: string[] };
type GateData = { gate: CanvasGate; status?: string };

function portOf(nodes: Node[], nodeId: string, handle: string | null | undefined): PortType | 'workflow' | null {
  if (!handle) return null;
  const n = nodes.find(x => x.id === nodeId);
  if (!n) return null;
  if (n.type === 'frame' || n.type === 'gate') return 'workflow';
  const [side, id] = handle.split(':');
  const gn = (n.data as GData).node;
  return portSpec(gn.type, side === 'in' ? 'in' : 'out', id)?.type ?? null;
}

function buildGraph(layout: CanvasLayout, models: FrameModel[]) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let nextY = 0;
  const bounds = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const m of models) {
    if (!m.visible) continue;
    const auto = autoPositions(m.graph);
    const children: Node[] = m.graph.nodes.map(n => ({
      id: `${m.id}/${n.id}`, type: 'g', parentId: `f:${m.id}`,
      position: layout.nodes[`${m.id}/${n.id}`] ?? auto.get(n.id) ?? { x: PAD, y: HEAD },
      data: { frameId: m.id, node: n, editable: m.editable, problems: m.problems.filter(p => p.nodeId === n.id).length, connected: [...m.graph.edges.filter(e => e.to === n.id).map(e => `in:${e.toPort}`), ...m.graph.edges.filter(e => e.from === n.id).map(e => `out:${e.fromPort}`)] } satisfies GData,
      connectable: m.editable, deletable: m.editable,
    }));
    const runningSteps = new Set(m.workflow ? Object.entries(m.workflow.tasks).filter(([, t]) => t.status === 'running').map(([k]) => `t:${k}`) : []);
    for (const e of m.graph.edges) {
      const type = portSpec(m.graph.nodes.find(n => n.id === e.from)!.type, 'out', e.fromPort)!.type;
      edges.push({ ...EDGE_BASE, id: `${m.id}/${e.id}`, source: `${m.id}/${e.from}`, sourceHandle: `out:${e.fromPort}`, target: `${m.id}/${e.to}`, targetHandle: `in:${e.toPort}`, style: { stroke: PORT_COLOR[type], strokeWidth: type === 'agent' ? 2.5 : 2, opacity: 0.85 }, animated: runningSteps.has(e.to), deletable: m.editable, data: { frameId: m.id, edge: e } });
    }
    const width = Math.max(640, ...children.map(c => c.position.x + nodeW((c.data as GData).node.type) + PAD));
    const height = Math.max(240, ...children.map(c => c.position.y + nodeH((c.data as GData).node.type) + PAD));
    const fp = m.frame ? { x: m.frame.x, y: m.frame.y } : { x: 0, y: nextY };
    nextY = Math.max(nextY, fp.y + height + 80);
    bounds.set(m.id, { ...fp, w: width, h: height });
    nodes.push({ id: `f:${m.id}`, type: 'frame', position: fp, data: { model: m, width, height } satisfies FrameData, style: { width, height }, dragHandle: '.cv-frame-drag' });
    nodes.push(...children);
  }
  const shown = new Set(models.filter(m => m.visible).map(m => m.id));
  const dash = { stroke: 'var(--accent)', strokeWidth: 3, strokeDasharray: '8 6' };
  for (const g of Object.values(layout.gates)) {
    nodes.push({ id: `gate:${g.id}`, type: 'gate', position: { x: g.x, y: g.y }, data: { gate: g } satisfies GateData });
    if (shown.has(g.from)) edges.push({ ...EDGE_BASE, id: `gl:${g.id}`, source: `f:${g.from}`, sourceHandle: 'out:finished', target: `gate:${g.id}`, targetHandle: 'in:from', style: dash, data: { gate: g.id, kind: 'gate-in' } });
    g.options.forEach((o, i) => { if (o.to && shown.has(o.to)) edges.push({ ...EDGE_BASE, id: `go:${g.id}:${i}`, source: `gate:${g.id}`, sourceHandle: `out:opt:${i}`, target: `f:${o.to}`, targetHandle: 'in:start', label: o.label, style: dash, data: { gate: g.id, kind: 'gate-out', index: i } }); });
  }
  for (const c of Object.values(layout.chains)) {
    if (shown.has(c.from) && shown.has(c.to)) edges.push({ ...EDGE_BASE, id: `ch:${c.id}`, source: `f:${c.from}`, sourceHandle: 'out:finished', target: `f:${c.to}`, targetHandle: 'in:start', label: 'then', style: dash, data: { chain: c.id, kind: 'chain' } });
  }
  return { nodes, edges, nextY, bounds };
}

// ---- editing helpers ----------------------------------------------------------------------------------

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
  return { ...layout, sketches: { ...layout.sketches, [next.id]: { ...next, graph: normalizeGraph(next.graph), updatedAt: now() } } };
}

const PREFIX: Record<GraphNodeType, string> = { agent: 'a', issue: 'i', step: 't', design: 'd', skill: 's', connector: 'c', ask: 'q', summary: 'x', note: 'n' };
function nextNodeId(g: CanvasGraph, type: GraphNodeType): string {
  for (let n = 1; ; n++) { const id = `${PREFIX[type]}:${type}-${n}`; if (!g.nodes.some(x => x.id === id)) return id; }
}

function nextTaskId(g: CanvasGraph, kind: string): string {
  const base = kind === 'code' ? 'build' : kind === 'review' ? 'review' : 'plan';
  const used = new Set(g.nodes.filter(n => n.type === 'step').map(stepTaskId));
  for (let n = 1; ; n++) { const id = `${base}-${n}`; if (!used.has(id)) return id; }
}

function newGraphNode(g: CanvasGraph, type: GraphNodeType, data: Record<string, unknown> = {}): GraphNode {
  const id = nextNodeId(g, type);
  const base: Record<string, unknown> = type === 'step' ? { kind: 'code', ...data } : { ...data };
  if (type === 'step' && !base.taskId) base.taskId = nextTaskId(g, String(base.kind));
  return { id, type, data: nodeData(type, base) };
}

/** First port on `type` that accepts (or produces) `port`. */
function compatiblePort(type: GraphNodeType, side: 'in' | 'out', port: PortType): PortSpec | undefined {
  return (side === 'in' ? NODE_SPECS[type].inputs : NODE_SPECS[type].outputs).find(p => p.type === port);
}

// ---- context ---------------------------------------------------------------------------------------------

interface FrameActions {
  save(m: FrameModel, start: boolean): void;
  discard(m: FrameModel): void;
  act(m: FrameModel, action: 'pause' | 'resume'): void;
  terminate(m: FrameModel): void;
  setHidden(m: FrameModel, hidden: boolean, showWhen?: CanvasShowWhen): void;
  rename(m: FrameModel, name: string): void;
  select(id: string | null): void;
  busy: boolean;
}
interface CanvasCtx { state: ControlState; actions: FrameActions }
const CanvasContext = createContext<CanvasCtx | null>(null);
const useCanvasCtx = () => useContext(CanvasContext)!;

// ---- node renderers -------------------------------------------------------------------------------------

/** A socket on a node edge. Its label shows on hover, while connecting, or when the node is selected. */
function Socket({ p, side, editable, top, edge = side === 'in' ? 'left' : 'right', quiet = false }: { p: PortSpec; side: 'in' | 'out'; editable: boolean; top?: number | string; edge?: 'left' | 'right' | 'top' | 'bottom'; quiet?: boolean }) {
  const position = { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom }[edge];
  const style = edge === 'left' || edge === 'right' ? { top, ['--sock' as string]: PORT_COLOR[p.type] } : { left: top, ['--sock' as string]: PORT_COLOR[p.type] };
  return (
    <Handle type={side === 'in' ? 'target' : 'source'} position={position} id={`${side}:${p.id}`} isConnectable={editable} className={`cv-sock e-${edge}${quiet ? ' quiet' : ''}`} style={style}
      aria-label={`${side === 'in' ? 'Input' : 'Output'}: ${p.label}`} title={`${p.label} · ${p.type}`}>
      <span className="cv-sock-label">{p.label}</span>
    </Handle>
  );
}

function nodeTitle(state: ControlState, n: GraphNode): string {
  const d = n.data;
  switch (n.type) {
    case 'agent': return d.agentId ? state.agents[String(d.agentId)]?.config.name ?? String(d.agentId) : 'Choose an agent';
    case 'issue': { const w = state.workItems[String(d.workItemId)]; return w ? `${w.key ?? 'Issue'} · ${w.title}` : 'Choose an issue'; }
    case 'step': return String(d.title || '') || `${STEP_LABEL[String(d.kind)]} ${String(d.taskId ?? '')}`;
    case 'design': { const a = state.mocks?.[String(d.artifactId)]; return a ? `${a.title} · rev ${String(d.rev)}` : 'Choose an approved mock'; }
    case 'skill': return state.skills?.[String(d.skillId)]?.name ?? (String(d.label || d.skillId || '') || 'Choose a skill');
    case 'connector': return state.connectors?.[String(d.connectorId)]?.name ?? (String(d.label || d.connectorId || '') || 'Choose a connector');
    case 'ask': return String(d.question || '') || 'Ask a question';
    case 'summary': return d.text ? String(d.text).split('\n')[0] : 'Summarize connected answers';
    case 'note': return String(d.text || '') || 'Note';
  }
}

const PILL_LABEL: Partial<Record<GraphNodeType, string>> = { issue: 'Issue', design: 'Design', skill: 'Skill', connector: 'Connector', ask: 'One Ask', summary: 'Summary', note: 'Note' };

function GNode({ data, selected }: NodeProps<Node<GData>>) {
  const { state } = useCanvasCtx();
  const n = data.node;
  const spec = NODE_SPECS[n.type];
  const title = nodeTitle(state, n);
  const cls = `${selected ? ' selected' : ''}${data.problems ? ' problem' : ''}`;
  if (SHAPE[n.type] === 'agent') {
    const a = state.agents[String(n.data.agentId)];
    const name = a?.config.name ?? '';
    const running = a?.status === 'running';
    const consultIn = spec.inputs.find(p => p.id === 'consult')!;
    const consultOut = spec.outputs.find(p => p.id === 'consult')!;
    return (
      <div className={`cv-agent${cls}`} style={{ width: nodeW('agent') }}>
        <Socket p={consultIn} side="in" editable={data.editable} edge="top" top="50%" quiet={!data.connected.includes('in:consult')} />
        {spec.inputs.filter(p => p.id !== 'consult').map((p, i) => <Socket key={p.id} p={p} side="in" editable={data.editable} top={30 + i * 18} quiet={!data.connected.includes(`in:${p.id}`)} />)}
        <div className={`cv-avatar${running ? ' live' : ''}`} style={{ ['--h' as string]: String(hue(String(n.data.agentId || 'agent'))) }} aria-hidden="true">{name ? initials(name) : '?'}</div>
        <b className="cv-agent-name ellipsis" title={title}>{title}</b>
        <span className="cv-agent-meta">{[n.data.model, n.data.effort].filter(Boolean).join(' · ') || (a ? a.status : 'not set')}</span>
        <Socket p={spec.outputs.find(p => p.id === 'agent')!} side="out" editable={data.editable} top={40} />
        <Socket p={consultOut} side="out" editable={data.editable} edge="bottom" top="50%" quiet={!data.connected.includes('out:consult')} />
        {data.problems > 0 && <span className="cv-flag" title={`${data.problems} to fix`}>!</span>}
      </div>
    );
  }
  if (SHAPE[n.type] === 'pill') {
    return (
      <div className={`cv-pill t-${n.type}${cls}`} style={{ width: nodeW(n.type), ['--tint' as string]: PORT_COLOR[spec.outputs[0]?.type ?? 'flow'] }}>
        {spec.inputs.map(p => <Socket key={p.id} p={p} side="in" editable={data.editable} top="50%" />)}
        <span className="cv-pill-kind">{PILL_LABEL[n.type]}</span>
        <span className="cv-pill-title ellipsis" title={title}>{title}</span>
        {spec.outputs.map(p => <Socket key={p.id} p={p} side="out" editable={data.editable} top="50%" />)}
        {data.problems > 0 && <span className="cv-flag" title={`${data.problems} to fix`}>!</span>}
      </div>
    );
  }
  const w = state.workflows?.[data.frameId];
  const st = w && w.status !== 'draft' ? w.tasks[String(n.data.taskId)] : null;
  const kind = String(n.data.kind);
  const pct = st ? PROGRESS[st.status] : 0;
  return (
    <div className={`cv-card${cls}${st?.status === 'running' ? ' live' : ''}`} style={{ width: nodeW('step'), ['--spine' as string]: STEP_COLOR[kind] }}>
      {spec.inputs.map((p, i) => <Socket key={p.id} p={p} side="in" editable={data.editable} top={16 + i * 13} quiet={!['agent', 'issue', 'after'].includes(p.id) && !data.connected.includes(`in:${p.id}`)} />)}
      <div className="cv-card-kind"><span>{STEP_LABEL[kind]}</span>{st ? <Badge tone={TASK_TONE[st.status]}>{st.status.replace('_', ' ')}</Badge> : <span className="faint">{String(n.data.taskId ?? '')}</span>}</div>
      <div className="cv-card-title ellipsis2" title={title}>{title}</div>
      {n.data.pickup ? <div className="cv-card-note">Pickup point attached</div> : null}
      {data.problems > 0 && <div className="cv-card-note crit-text">{data.problems} to fix</div>}
      <div className="cv-progress" role="progressbar" aria-label="Step progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><span style={{ width: `${pct}%`, background: st?.status === 'failed' ? 'var(--crit)' : 'var(--spine)' }} /></div>
      {spec.outputs.map(p => <Socket key={p.id} p={p} side="out" editable={data.editable} top="50%" />)}
    </div>
  );
}

function FrameNode({ data, selected }: NodeProps<Node<FrameData>>) {
  const { model: m, width, height } = data;
  const ctx = useCanvasCtx();
  const w = m.workflow;
  const p = w ? workflowProgress(w) : null;
  const status = m.sketch ? (m.sketch.workflowId ? 'draft · editing' : 'sketch') : w?.status ?? 'draft';
  const steps = m.graph.nodes.filter(n => n.type === 'step').length;
  const problems = m.problems.length;
  return (
    <div className={`cv-frame${selected ? ' selected' : ''}${m.editable ? '' : ' locked'}`} style={{ width, height }} aria-label={`Workflow ${m.name}`}>
      <Handle type="target" position={Position.Left} id="in:start" className="cv-rail e-left" aria-label="Starts after another workflow" title="Start: connect a finished workflow or a decision" />
      <Handle type="source" position={Position.Right} id="out:finished" className="cv-rail e-right" aria-label="When this workflow finishes" title="Finished: connect to the next workflow or a decision" />
      <div className="cv-frame-h">
        <span className="cv-frame-drag" title="Drag to move this workflow" aria-hidden="true">⠿</span>
        {m.editable ? <input className="cv-frame-name nodrag" aria-label="Workflow name" value={m.sketch?.name ?? m.name} placeholder="Name this workflow" onChange={e => ctx.actions.rename(m, e.target.value)} /> : <b className="cv-frame-name"><Icon name="lock" size={13} /> {m.name}</b>}
        <Badge tone={w && !m.sketch ? STATUS_TONE[w.status] : 'idle'}>{status}</Badge>
        {p && !m.editable && <span className="small faint mono">{p.done}/{p.total}</span>}
        {m.attention && m.attention.input > 0 && <Link className="cv-attn nodrag" to="/inbox">{m.attention.input} waiting on you</Link>}
        {m.frame?.hidden && m.visible && <span className="small faint">shown because it needs you</span>}
        <span className="spacer" />
        {m.editable && (steps === 0 ? <span className="small faint">Add a step</span> : <>
          <span className={`small ${problems ? 'crit-text' : 'faint'}`} title={m.problems.map(x => x.message).join('\n')}>{problems ? `${problems} to fix` : 'Ready'}</span>
          {m.sketch && <button type="button" className="btn sm nodrag" disabled={ctx.actions.busy || problems > 0} onClick={() => ctx.actions.save(m, false)}>Save draft</button>}
          <button type="button" className="btn sm primary nodrag" disabled={ctx.actions.busy || problems > 0} onClick={() => ctx.actions.save(m, true)}><Icon name="play" size={12} />Run</button>
        </>)}
        {m.editable && m.sketch && <button type="button" className="btn sm ghost nodrag" disabled={ctx.actions.busy} onClick={() => ctx.actions.discard(m)}>Discard</button>}
        {w && !m.editable && <>
          {(w.status === 'running' || w.status === 'blocked' || w.status === 'failed') && <button type="button" className="btn sm nodrag" disabled={ctx.actions.busy} onClick={() => ctx.actions.act(m, 'pause')}><Icon name="pause" size={12} />Pause</button>}
          {w.status === 'paused' && <button type="button" className="btn sm nodrag" disabled={ctx.actions.busy} onClick={() => ctx.actions.act(m, 'resume')}><Icon name="play" size={12} />Resume</button>}
          {w.status !== 'completed' && w.status !== 'canceled' && <button type="button" className="btn sm danger nodrag" disabled={ctx.actions.busy} onClick={() => ctx.actions.terminate(m)}>Terminate</button>}
          <button type="button" className="btn sm ghost nodrag" onClick={() => ctx.actions.select(`f:${m.id}`)}><Icon name="eyeOff" size={12} />{m.frame?.hidden ? 'Hidden' : 'Hide'}</button>
        </>}
      </div>
      {m.editable && !m.graph.nodes.length && <div className="cv-frame-empty small muted">Double-click inside this frame to add an Agent, then steps, an issue and anything else.</div>}
    </div>
  );
}

function GateNode({ data, selected }: NodeProps<Node<GateData>>) {
  const g = data.gate;
  return (
    <div className={`cv-gate${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Left} id="in:from" className="cv-sock e-left" style={{ top: '50%', ['--sock' as string]: 'var(--accent)' }} aria-label="Workflow that leads to this decision" />
      <div className="cv-diamond" aria-hidden="true" />
      <div className="cv-gate-body">
        <b>{g.kind === 'jev' ? 'JEV' : 'You'}</b>
        <span>{g.kind === 'jev' ? (g.autoDecide ? 'decides' : 'recommends') : 'decide'}</span>
      </div>
      <div className="cv-gate-q ellipsis2">{g.question || 'What decides the next workflow?'}</div>
      {data.status && <span className="cv-link-status">{data.status}</span>}
      <div className="cv-gate-options">
        {g.options.map((o, i) => <div key={i} className="cv-gate-opt"><span className="ellipsis">{o.label}</span><Handle type="source" position={Position.Right} id={`out:opt:${i}`} className="cv-sock e-right" style={{ ['--sock' as string]: 'var(--accent)' }} aria-label={`Option ${o.label}`} /></div>)}
        {g.options.length === 0 && <span className="small faint">Add options in the inspector</span>}
      </div>
    </div>
  );
}

const NODE_COMPONENTS = { frame: FrameNode, g: GNode, gate: GateNode };

// ---- node search (double-click, link drop, + button) -----------------------------------------------------

type PickKind = GraphNodeType | 'workflow' | 'gate-jev' | 'gate-human';
interface PickItem { kind: PickKind; label: string; hint: string; category: string; data?: Record<string, unknown> }
interface SearchState { screen: { x: number; y: number }; flow: { x: number; y: number }; from?: { nodeId: string; handle: string; side: 'source' | 'target'; type: PortType | 'workflow' } }

function pickItems(filter?: SearchState['from']): PickItem[] {
  const items: PickItem[] = [];
  for (const t of NODE_TYPES) {
    const s = NODE_SPECS[t];
    if (t === 'step') for (const k of ['coordination', 'code', 'review']) items.push({ kind: 'step', label: `${STEP_LABEL[k]} step`, hint: STEP_HINT[k], category: 'Steps', data: { kind: k } });
    else items.push({ kind: t, label: s.label, hint: s.hint, category: s.category });
  }
  items.push({ kind: 'workflow', label: 'New workflow', hint: 'A new frame that starts with an Agent node', category: 'Workflow' });
  items.push({ kind: 'gate-jev', label: 'Decision · JEV', hint: 'JEV recommends (or, if you allow it, picks) which workflow runs next', category: 'Workflow' });
  items.push({ kind: 'gate-human', label: 'Decision · you', hint: 'You pick which workflow runs next', category: 'Workflow' });
  if (!filter) return items;
  if (filter.type === 'workflow') return items.filter(i => i.kind === 'workflow' || (filter.side === 'source' && filter.nodeId.startsWith('f:') && (i.kind === 'gate-jev' || i.kind === 'gate-human')));
  const side = filter.side === 'source' ? 'in' : 'out';
  return items.filter(i => i.kind !== 'workflow' && !i.kind.startsWith('gate') && compatiblePort(i.kind as GraphNodeType, side, filter.type as PortType));
}

function NodeSearch({ at, onPick, onClose }: { at: SearchState; onPick: (i: PickItem) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  // Focus after the double-click or drop finishes, or the canvas takes focus back.
  useEffect(() => { const t = setTimeout(() => input.current?.focus(), 0); return () => clearTimeout(t); }, []);
  const needle = q.trim().toLowerCase();
  const items = pickItems(at.from).filter(i => !needle || `${i.label} ${i.hint} ${i.category}`.toLowerCase().includes(needle));
  const left = Math.max(8, Math.min(at.screen.x, window.innerWidth - 360));
  const top = Math.max(8, Math.min(at.screen.y, window.innerHeight - 440));
  return (
    <div className="cv-search" role="dialog" aria-label="Add a node" style={{ left, top }} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <input ref={input} role="combobox" aria-expanded="true" aria-controls="cv-search-list" aria-activedescendant={items[active] ? `cvs-${active}` : undefined} aria-label="Search nodes" placeholder={at.from ? `Nodes that connect to ${at.from.type}` : 'Search nodes'} value={q}
        onChange={e => { setQ(e.target.value); setActive(0); }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(items.length - 1, i + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
          else if (e.key === 'Enter' && items[active]) { e.preventDefault(); onPick(items[active]); }
        }} />
      <ul id="cv-search-list" role="listbox" aria-label="Nodes">
        {items.map((i, k) => <li key={`${i.kind}-${i.label}`} id={`cvs-${k}`} role="option" aria-selected={k === active} className={k === active ? 'on' : ''} onMouseEnter={() => setActive(k)} onMouseDown={e => { e.preventDefault(); onPick(i); }}>
          <span className="cv-dot" style={{ background: pickColor(i.kind) }} />
          <span className="grow"><b>{i.label}</b><span className="small faint"> {i.category}</span><br /><span className="small muted">{i.hint}</span></span>
        </li>)}
        {items.length === 0 && <li className="small faint">No node matches.</li>}
      </ul>
    </div>
  );
}

// ---- library sidebar --------------------------------------------------------------------------------------

function Library({ onPick, onClose }: { onPick: (i: PickItem) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const items = pickItems().filter(i => `${i.label} ${i.hint} ${i.category}`.toLowerCase().includes(q.trim().toLowerCase()));
  const cats = [...new Set(items.map(i => i.category))];
  return (
    <aside className="cv-library" aria-label="Node library">
      <div className="row"><Icon name="library" size={15} /><b className="grow">Node library</b><button type="button" className="shell-icon-btn" aria-label="Close node library" onClick={onClose}><Icon name="close" size={14} /></button></div>
      <input aria-label="Search the node library" placeholder="Search" value={q} onChange={e => setQ(e.target.value)} />
      <p className="small faint">Drag onto the canvas, or click to add to the selected workflow.</p>
      {cats.map(c => <div key={c} className="cv-lib-group" role="group" aria-label={c}><span className="small muted">{c}</span>
        {items.filter(i => i.category === c).map(i => <button key={`${i.kind}-${i.label}`} type="button" draggable onDragStart={e => { e.dataTransfer.setData('application/x-one-connect-node', JSON.stringify({ kind: i.kind, data: i.data ?? {} })); e.dataTransfer.effectAllowed = 'copy'; }} onClick={() => onPick(i)} title={i.hint}>
          <span className="cv-dot" style={{ background: pickColor(i.kind) }} />{i.label}
        </button>)}
      </div>)}
    </aside>
  );
}

// ---- canvas --------------------------------------------------------------------------------------------------

export function Canvas({ state }: { state: ControlState }) {
  return <ReactFlowProvider><CanvasInner state={state} /></ReactFlowProvider>;
}

interface Menu { x: number; y: number; flow: { x: number; y: number }; target: 'pane' | 'node'; nodeId?: string }

function CanvasInner({ state }: { state: ControlState }) {
  const navigate = useNavigate();
  const { mode } = useTheme();
  const { layout, update, adopt, undo, redo, canUndo, canRedo, error: saveError } = useCanvasLayout();
  const { busy, error, run } = useAction();
  const flow = useReactFlow();
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState<SearchState | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [library, setLibrary] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const clipboard = useRef<{ nodes: GraphNode[]; edges: CanvasGraph['edges'] } | null>(null);
  const models = useMemo(() => layout ? frameModels(state, layout) : [], [state, layout]);
  const graph = useMemo(() => layout ? buildGraph(layout, models) : { nodes: [], edges: [], nextY: 0, bounds: new Map<string, { x: number; y: number; w: number; h: number }>() }, [layout, models]);
  const linkState = useLinkSync(state, layout);
  const shownEdges = useMemo(() => graph.edges.map(e => {
    const d = e.data as { kind?: string; chain?: string } | undefined;
    return d?.kind === 'chain' ? { ...e, label: `then · ${linkLabel(linkState('chain', d.chain!))}` } : e;
  }), [graph.edges, linkState]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  useEffect(() => {
    setNodes(prev => {
      const byId = new Map(prev.map(n => [n.id, n]));
      return graph.nodes.map(n => {
        const withStatus = n.type === 'gate' ? { ...n, data: { ...(n.data as GateData), status: linkLabel(linkState('gate', (n.data as GateData).gate.id)) } } : n;
        const p = byId.get(n.id);
        return p ? { ...withStatus, position: p.dragging ? p.position : n.position, measured: p.measured, selected: p.selected } : withStatus;
      });
    });
    // linkState changes identity every render; the link map and layout drive it through graph.nodes and state.
  }, [graph.nodes, setNodes, state.workflowLinks]); // eslint-disable-line react-hooks/exhaustive-deps

  const frameOf = (nodeId: string) => models.find(m => nodeId === `f:${m.id}` || nodeId.startsWith(`${m.id}/`));
  const editFrame = useCallback((frameId: string, fn: (s: CanvasSketch) => CanvasSketch) => update(l => withSketch(l, state, frameId, fn)), [update, state]);
  const select = (id: string | null) => { setSelected(id); setNodes(ns => ns.map(n => ({ ...n, selected: n.id === id }))); };
  /** Which editable frame a canvas point falls in. */
  const frameAt = (p: { x: number; y: number }) => models.find(m => { const b = graph.bounds.get(m.id); return m.editable && b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h; });

  const newSketch = (at: { x: number; y: number }, withAgent = true) => {
    const id = newId('sketch');
    const g: CanvasGraph = { nodes: [], edges: [] };
    if (withAgent) g.nodes.push(newGraphNode(g, 'agent'));
    const sketch: CanvasSketch = { id, name: '', mode: 'collaborative', workflowId: null, version: null, continues: null, graph: g, updatedAt: now() };
    return { id, layout: (l: CanvasLayout): CanvasLayout => ({ ...l, sketches: { ...l.sketches, [id]: sketch }, frames: { ...l.frames, [id]: { x: Math.round(at.x), y: Math.round(at.y), hidden: false, showWhen: DEFAULT_SHOW_WHEN } } }) };
  };

  /** Add what the owner picked at a canvas point, connecting it to the dragged port if any. */
  const place = (item: PickItem, at: { x: number; y: number }, from?: SearchState['from']) => {
    setSearch(null); setMenu(null);
    if (item.kind === 'workflow') {
      const s = newSketch(at);
      update(l => {
        let next = s.layout(l);
        if (from?.type === 'workflow' && from.side === 'source') {
          if (from.nodeId.startsWith('f:')) { const id = newId('chain'); next = { ...next, chains: { ...next.chains, [id]: { id, from: from.nodeId.slice(2), to: s.id } } }; }
          else if (from.nodeId.startsWith('gate:')) { const gid = from.nodeId.slice(5); const idx = Number(from.handle.split(':')[2]); const g = next.gates[gid]; if (g) next = { ...next, gates: { ...next.gates, [gid]: { ...g, options: g.options.map((o, i) => i === idx ? { ...o, to: s.id } : o) } } }; }
        }
        return next;
      });
      select(`f:${s.id}`);
      return;
    }
    if (item.kind === 'gate-jev' || item.kind === 'gate-human') {
      const id = newId('gate');
      const fromFrame = from?.type === 'workflow' && from.side === 'source' && from.nodeId.startsWith('f:') ? from.nodeId.slice(2) : selected?.startsWith('f:') ? selected.slice(2) : '';
      update(l => ({ ...l, gates: { ...l.gates, [id]: { id, x: Math.round(at.x), y: Math.round(at.y), from: fromFrame, kind: item.kind === 'gate-jev' ? 'jev' : 'human', question: '', options: [{ label: 'Option 1', to: '' }, { label: 'Option 2', to: '' }], autoDecide: false, confirmedAt: null, maxEvidenceBytes: DEFAULT_JEV_EVIDENCE_BYTES } } }));
      select(`gate:${id}`);
      return;
    }
    const type = item.kind as GraphNodeType;
    const sourceFrame = from && from.type !== 'workflow' ? frameOf(from.nodeId) : undefined;
    const target = sourceFrame?.editable ? sourceFrame : frameAt(at) ?? (selected ? frameOf(selected) : undefined);
    const frameId = target?.editable ? target.id : null;
    const b = frameId ? graph.bounds.get(frameId) : undefined;
    const rel = b ? { x: Math.max(8, Math.round(at.x - b.x)), y: Math.max(HEAD, Math.round(at.y - b.y)) } : null;
    let sketchId = frameId;
    let created: ((l: CanvasLayout) => CanvasLayout) | null = null;
    if (!sketchId) { const s = newSketch(at, type !== 'agent'); sketchId = s.id; created = s.layout; }
    update(l => {
      let addedId = '';
      const next = withSketch(created ? created(l) : l, state, sketchId!, s => {
        const node = newGraphNode(s.graph, type, item.data ?? {});
        addedId = node.id;
        const edges = [...s.graph.edges];
        if (from && from.type !== 'workflow' && sourceFrame?.id === sketchId) {
          const other = from.nodeId.slice(sketchId!.length + 1);
          const port = compatiblePort(type, from.side === 'source' ? 'in' : 'out', from.type);
          const otherPort = from.handle.split(':')[1];
          if (port) edges.push(from.side === 'source' ? { id: '', from: other, fromPort: otherPort, to: node.id, toPort: port.id } : { id: '', from: node.id, fromPort: port.id, to: other, toPort: otherPort });
        } else if (created && type === 'step') {
          const agent = s.graph.nodes.find(n => n.type === 'agent');
          if (agent) edges.push({ id: '', from: agent.id, fromPort: 'agent', to: node.id, toPort: 'agent' });
        }
        return { ...s, graph: { nodes: [...s.graph.nodes, node], edges } };
      });
      return rel && addedId ? { ...next, nodes: { ...next.nodes, [`${sketchId}/${addedId}`]: rel } } : next;
    });
  };

  const actions: FrameActions = {
    busy,
    select,
    rename: (m, name) => editFrame(m.id, s => ({ ...s, name: name.slice(0, 120) })),
    discard: m => {
      if (!m.sketch) return;
      if (!window.confirm(m.sketch.workflowId ? 'Discard your unsaved changes to this draft?' : `Discard "${m.name}"? It was never saved.`)) return;
      update(l => { const sketches = { ...l.sketches }; delete sketches[m.sketch!.id]; return { ...l, sketches }; });
    },
    save: (m, start) => void run(async () => {
      if (start && !window.confirm(`Run "${m.name}"? Each step goes through pre-flight and its agent's queue. A running workflow can't be edited until you terminate it.`)) return;
      let id = m.workflow?.id ?? null;
      if (m.sketch) {
        const compiled = compileSketch(m.sketch);
        const r = await post<{ workflow: Workflow }>('/api/workflows', { id: m.sketch.workflowId, definition: compiled.definition, expectedVersion: m.sketch.version });
        id = r.workflow.id;
        const sid = m.sketch.id;
        const wid = id;
        update(l => {
          const sketches = { ...l.sketches }; delete sketches[sid];
          if (sid === wid) return { ...l, sketches };
          const re = (x: string) => (x === sid ? wid : x);
          const frames = { ...l.frames }; if (frames[sid]) { frames[wid] = frames[sid]; delete frames[sid]; }
          const pos: CanvasLayout['nodes'] = {};
          for (const [k, v] of Object.entries(l.nodes)) pos[k.startsWith(`${sid}/`) ? `${wid}/${k.slice(sid.length + 1)}` : k] = v;
          const gates = Object.fromEntries(Object.entries(l.gates).map(([k, g]) => [k, { ...g, from: re(g.from), options: g.options.map(o => ({ ...o, to: re(o.to) })) }]));
          const chains = Object.fromEntries(Object.entries(l.chains).map(([k, c]) => [k, { ...c, from: re(c.from), to: re(c.to) }]));
          return { ...l, sketches, frames, nodes: pos, gates, chains };
        }, { forget: true });
      }
      if (start && id) await post(`/api/workflows/${encodeURIComponent(id)}/start`);
    }),
    act: (m, a) => void run(() => post(`/api/workflows/${encodeURIComponent(m.workflow!.id)}/${a}`)),
    terminate: m => {
      if (!window.confirm(`Terminate "${m.name}"?\n\nRunning agents are asked for a pickup point (where the engine supports it), then stopped. Sessions, transcripts, branches and evidence are kept. Finished steps stay locked; unfinished steps reopen below as an editable draft carrying each pickup point.`)) return;
      void run(async () => {
        const r = await post<{ layout: CanvasLayout; rev: number; sketchId: string }>(`/api/canvas/workflows/${encodeURIComponent(m.workflow!.id)}/terminate`);
        adopt(r.layout, r.rev);
        select(`f:${r.sketchId}`);
      });
    },
    setHidden: (m, hidden, showWhen) => update(l => {
      const at = nodes.find(n => n.id === `f:${m.id}`)?.position;
      return { ...l, frames: { ...l.frames, [m.id]: { x: l.frames[m.id]?.x ?? at?.x ?? 0, y: l.frames[m.id]?.y ?? at?.y ?? 0, hidden, showWhen: showWhen ?? l.frames[m.id]?.showWhen ?? DEFAULT_SHOW_WHEN } } };
    }),
  };

  const isValidConnection = (c: Connection | Edge) => {
    const a = portOf(nodes, c.source, c.sourceHandle); const b = portOf(nodes, c.target, c.targetHandle);
    if (!a || a !== b || c.source === c.target) return false;
    if (a === 'workflow') return !(c.source.startsWith('gate:') && c.target.startsWith('gate:'));
    const fa = frameOf(c.source); const fb = frameOf(c.target);
    return Boolean(fa && fb && fa.id === fb.id && fa.editable);
  };

  const onConnect = (c: Connection) => {
    if (!c.source || !c.target || !isValidConnection(c)) return;
    if (portOf(nodes, c.source, c.sourceHandle) === 'workflow') {
      const srcFrame = c.source.startsWith('f:') ? c.source.slice(2) : null;
      const dstFrame = c.target.startsWith('f:') ? c.target.slice(2) : null;
      update(l => {
        if (srcFrame && dstFrame) { if (Object.values(l.chains).some(x => x.from === srcFrame && x.to === dstFrame)) return l; const id = newId('chain'); return { ...l, chains: { ...l.chains, [id]: { id, from: srcFrame, to: dstFrame } } }; }
        if (srcFrame && c.target.startsWith('gate:')) { const g = l.gates[c.target.slice(5)]; return g ? { ...l, gates: { ...l.gates, [g.id]: { ...g, from: srcFrame } } } : l; }
        if (c.source.startsWith('gate:') && dstFrame) { const g = l.gates[c.source.slice(5)]; const idx = Number(String(c.sourceHandle).split(':')[2]); return g ? { ...l, gates: { ...l.gates, [g.id]: { ...g, options: g.options.map((o, i) => i === idx ? { ...o, to: dstFrame } : o) } } } : l; }
        return l;
      });
      return;
    }
    const m = frameOf(c.source)!;
    editFrame(m.id, s => ({ ...s, graph: { ...s.graph, edges: [...s.graph.edges, { id: '', from: c.source.slice(m.id.length + 1), fromPort: String(c.sourceHandle).slice(4), to: c.target.slice(m.id.length + 1), toPort: String(c.targetHandle).slice(3) }] } }));
  };

  const onConnectEnd = (e: MouseEvent | TouchEvent, st: FinalConnectionState) => {
    if (st.isValid || !st.fromNode || !st.fromHandle?.id) return;
    const t = e.target as HTMLElement;
    if (t.closest('.cv-node') || !(t.classList.contains('react-flow__pane') || t.closest('.cv-frame'))) return;
    const type = portOf(nodes, st.fromNode.id, st.fromHandle.id);
    if (!type || (type !== 'workflow' && !frameOf(st.fromNode.id)?.editable)) return;
    const pt = 'changedTouches' in e ? e.changedTouches[0] : e;
    setSearch({ screen: { x: pt.clientX, y: pt.clientY }, flow: flow.screenToFlowPosition({ x: pt.clientX, y: pt.clientY }), from: { nodeId: st.fromNode.id, handle: st.fromHandle.id, side: st.fromHandle.type, type } });
  };

  const onEdgesDelete = (deleted: Edge[]) => {
    for (const e of deleted) {
      const d = e.data as { frameId?: string; edge?: { id: string }; kind?: string; chain?: string; gate?: string; index?: number } | undefined;
      if (d?.kind === 'chain') update(l => { const chains = { ...l.chains }; delete chains[d.chain!]; return { ...l, chains }; });
      else if (d?.kind === 'gate-in') update(l => l.gates[d.gate!] ? { ...l, gates: { ...l.gates, [d.gate!]: { ...l.gates[d.gate!], from: '' } } } : l);
      else if (d?.kind === 'gate-out') update(l => l.gates[d.gate!] ? { ...l, gates: { ...l.gates, [d.gate!]: { ...l.gates[d.gate!], options: l.gates[d.gate!].options.map((o, i) => i === d.index ? { ...o, to: '' } : o) } } } : l);
      else if (d?.frameId && d.edge && frameOf(e.source)?.editable) editFrame(d.frameId, s => ({ ...s, graph: { ...s.graph, edges: s.graph.edges.filter(x => x.id !== d.edge!.id) } }));
    }
  };

  const onNodesDelete = (deleted: Node[]) => {
    for (const n of deleted) {
      if (n.type === 'gate') { const id = n.id.slice(5); update(l => { const gates = { ...l.gates }; delete gates[id]; return { ...l, gates }; }); continue; }
      if (n.type === 'frame') continue; // frames are discarded or terminated explicitly
      const m = frameOf(n.id);
      if (!m?.editable) continue;
      const gid = n.id.slice(m.id.length + 1);
      editFrame(m.id, s => ({ ...s, graph: { nodes: s.graph.nodes.filter(x => x.id !== gid), edges: s.graph.edges.filter(x => x.from !== gid && x.to !== gid) } }));
    }
    select(null);
  };

  const onNodeDragStop = (_: unknown, _n: Node, dragged: Node[]) => {
    update(l => {
      const frames = { ...l.frames }; const pos = { ...l.nodes }; const gates = { ...l.gates };
      for (const n of dragged) {
        const p = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
        if (n.type === 'frame') { const id = n.id.slice(2); frames[id] = { ...(frames[id] ?? { hidden: false, showWhen: DEFAULT_SHOW_WHEN }), ...p }; }
        else if (n.type === 'gate') { const id = n.id.slice(5); if (gates[id]) gates[id] = { ...gates[id], ...p }; }
        else pos[n.id] = p;
      }
      return { ...l, frames, nodes: pos, gates };
    });
  };

  // Copy and paste graph nodes (with the edges between them) inside editable workflows.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === 'z' || key === 'y') {
        e.preventDefault();
        if (key === 'y' || e.shiftKey) redo(); else undo();
      } else if (key === 'c') {
        const sel = nodes.filter(n => n.selected && n.type === 'g');
        const m = sel[0] ? frameOf(sel[0].id) : undefined;
        if (!m) return;
        const ids = new Set(sel.filter(n => frameOf(n.id)?.id === m.id).map(n => n.id.slice(m.id.length + 1)));
        clipboard.current = { nodes: m.graph.nodes.filter(n => ids.has(n.id)), edges: m.graph.edges.filter(x => ids.has(x.from) && ids.has(x.to)) };
      } else if (key === 'v' && clipboard.current) {
        const m = selected ? frameOf(selected) : undefined;
        if (!m?.editable) return;
        e.preventDefault();
        const clip = clipboard.current;
        editFrame(m.id, s => {
          const map = new Map<string, string>();
          const g: CanvasGraph = { nodes: [...s.graph.nodes], edges: [...s.graph.edges] };
          for (const n of clip.nodes) { const copy = newGraphNode(g, n.type, n.type === 'step' ? { ...n.data, taskId: '' } : n.data); map.set(n.id, copy.id); g.nodes.push(copy); }
          for (const x of clip.edges) g.edges.push({ id: '', from: map.get(x.from)!, fromPort: x.fromPort, to: map.get(x.to)!, toPort: x.toPort });
          return { ...s, graph: g };
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const addAsk = (r: AskResult) => {
    const target = selected ? frameOf(selected) : undefined;
    const at = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    let sketchId = target?.editable ? target.id : null;
    let created: ((l: CanvasLayout) => CanvasLayout) | null = null;
    if (!sketchId) { const s = newSketch(at); sketchId = s.id; created = s.layout; }
    update(l => withSketch(created ? created(l) : l, state, sketchId!, s => ({ ...s, graph: { ...s.graph, nodes: [...s.graph.nodes, newGraphNode(s.graph, 'ask', { question: r.question, answer: r.answer, sources: r.sources })] } })));
  };

  const onDrop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData('application/x-one-connect-node');
    if (!raw) return;
    e.preventDefault();
    const { kind, data } = JSON.parse(raw) as { kind: PickKind; data: Record<string, unknown> };
    const item = pickItems().find(i => i.kind === kind && JSON.stringify(i.data ?? {}) === JSON.stringify(data)) ?? pickItems().find(i => i.kind === kind);
    if (item) place(item, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  const hidden = models.filter(m => !m.visible);
  const selModel = selected ? frameOf(selected) : undefined;
  const selGate = selected?.startsWith('gate:') ? layout?.gates[selected.slice(5)] : undefined;
  const empty = layout && models.length === 0 && Object.keys(layout.gates).length === 0;
  const newWorkflowItem = pickItems().find(i => i.kind === 'workflow')!;
  const openSearchAtCenter = () => { const x = window.innerWidth / 2 - 170; const y = window.innerHeight / 3; setSearch({ screen: { x, y }, flow: flow.screenToFlowPosition({ x: x + 170, y: y + 60 }) }); };

  return (
    <div className={`cv${connecting ? ' connecting' : ''}`} onDragOver={e => { if (e.dataTransfer.types.includes('application/x-one-connect-node')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={onDrop}>
      <div className="cv-toolbar" role="toolbar" aria-label="Canvas">
        <button type="button" className="btn sm" aria-pressed={library} onClick={() => setLibrary(v => !v)}><Icon name="library" size={14} />Library</button>
        <button type="button" className="btn sm" disabled={!canUndo} onClick={undo} title="Undo (⌘Z)" aria-label="Undo"><Icon name="undo" size={14} /></button>
        <button type="button" className="btn sm" disabled={!canRedo} onClick={redo} title="Redo (⇧⌘Z)" aria-label="Redo"><Icon name="redo" size={14} /></button>
        <button type="button" className="btn sm primary" onClick={openSearchAtCenter}><Icon name="plus" size={14} />Add node</button>
        <button type="button" className="btn sm" onClick={() => flow.fitView({ padding: 0.15, maxZoom: 1, duration: 250 })}><Icon name="fit" size={14} />Fit</button>
        {hidden.length > 0 && <button type="button" className="btn sm" aria-expanded={trayOpen} onClick={() => setTrayOpen(v => !v)}><Icon name="eyeOff" size={14} />Hidden {hidden.length}</button>}
        {(saveError || error) && <span className="small crit-text" role="alert">{saveError ?? error}</span>}
      </div>
      {library && <Library onClose={() => setLibrary(false)} onPick={i => { const b = selModel ? graph.bounds.get(selModel.id) : undefined; place(i, b ? { x: b.x + COL * 2, y: b.y + HEAD } : flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })); }} />}
      {trayOpen && hidden.length > 0 && <div className="cv-tray" role="region" aria-label="Hidden workflows">
        {hidden.map(m => <div key={m.id} className="cv-tray-row"><Icon name="lock" size={13} /><span className="grow ellipsis">{m.name}</span>{m.workflow && <Badge tone={STATUS_TONE[m.workflow.status]}>{m.workflow.status}</Badge>}<button type="button" className="btn sm" onClick={() => actions.setHidden(m, false)}>Show</button></div>)}
        <p className="small faint">Hidden workflows come back on their own when they reach a condition you chose.</p>
      </div>}
      {!empty && hidden.length > 0 && hidden.length === models.length && <p className="cv-quiet muted">Every workflow is hidden. Each one comes back here when it reaches a condition you chose.</p>}
      {empty && <div className="cv-empty"><h1>Start a workflow</h1><p className="muted">Double-click anywhere to search for a node. A workflow starts with an Agent; connect steps, an issue, designs, skills and One Ask answers to it, then run it.</p><button type="button" className="btn primary" onClick={() => place(newWorkflowItem, { x: 0, y: 0 })}>New workflow</button></div>}
      <CanvasContext.Provider value={{ state, actions }}>
        <ReactFlow
          nodes={nodes}
          edges={shownEdges}
          nodeTypes={NODE_COMPONENTS}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onConnectStart={() => setConnecting(true)}
          onConnectEnd={(e, st) => { setConnecting(false); onConnectEnd(e, st); }}
          isValidConnection={isValidConnection}
          onEdgesDelete={onEdgesDelete}
          onNodesDelete={onNodesDelete}
          onNodeDragStop={onNodeDragStop}
          onSelectionChange={({ nodes: sel }) => setSelected(sel[0]?.id ?? null)}
          onPaneClick={() => { select(null); setMenu(null); setSearch(null); }}
          onDoubleClick={e => {
            const t = e.target as HTMLElement;
            if (t.closest('input, textarea, select, button, .cv-node')) return;
            if (t.classList.contains('react-flow__pane') || t.closest('.cv-frame')) setSearch({ screen: { x: e.clientX, y: e.clientY }, flow: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
          }}
          onPaneContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, flow: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), target: 'pane' }); }}
          onNodeContextMenu={(e, n) => { e.preventDefault(); select(n.id); setMenu({ x: e.clientX, y: e.clientY, flow: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), target: 'node', nodeId: n.id }); }}
          zoomOnDoubleClick={false}
          colorMode={mode}
          deleteKeyCode={['Backspace', 'Delete']}
          minZoom={0.2}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          aria-label="Workflow canvas"
        >
          <Background variant={BackgroundVariant.Cross} gap={28} size={5} />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap pannable zoomable ariaLabel="Canvas overview" position="bottom-right" />
        </ReactFlow>
      </CanvasContext.Provider>
      {search && <NodeSearch at={search} onClose={() => setSearch(null)} onPick={i => place(i, search.flow, search.from)} />}
      {menu && <ContextMenu menu={menu} model={menu.nodeId ? frameOf(menu.nodeId) : undefined} actions={actions} onClose={() => setMenu(null)}
        onAdd={() => { setSearch({ screen: { x: menu.x, y: menu.y }, flow: menu.flow }); setMenu(null); }}
        onNewWorkflow={() => place(newWorkflowItem, menu.flow)}
        onDecision={() => place(pickItems().find(i => i.kind === 'gate-human')!, menu.flow)}
        onFit={() => { flow.fitView({ padding: 0.15, maxZoom: 1, duration: 250 }); setMenu(null); }}
        onDuplicate={() => { const id = menu.nodeId!; const m = frameOf(id); const n = m?.graph.nodes.find(x => `${m.id}/${x.id}` === id); if (m?.editable && n) editFrame(m.id, s => ({ ...s, graph: { ...s.graph, nodes: [...s.graph.nodes, newGraphNode(s.graph, n.type, n.type === 'step' ? { ...n.data, taskId: '' } : n.data)] } })); setMenu(null); }}
        onDelete={() => { const n = nodes.find(x => x.id === menu.nodeId); if (n) onNodesDelete([n]); setMenu(null); }} />}
      <OneAskDock onAdd={addAsk} />
      {selected && (selModel || selGate) && <Inspector state={state} model={selModel} gate={selGate} gateLink={selGate ? linkState('gate', selGate.id) : undefined} chainLinks={selModel ? Object.values(layout?.chains ?? {}).filter(c => c.from === selModel.id || c.to === selModel.id).map(c => ({ chain: c, state: linkState('chain', c.id), other: models.find(m => m.id === (c.from === selModel.id ? c.to : c.from))?.name ?? 'a workflow' })) : []} nodeId={selected} models={models} editFrame={editFrame} update={update} actions={actions} onDesign={() => navigate('/designer')} onClose={() => select(null)} />}
    </div>
  );
}

function ContextMenu({ menu, model, actions, onClose, onAdd, onNewWorkflow, onDecision, onFit, onDuplicate, onDelete }: { menu: Menu; model?: FrameModel; actions: FrameActions; onClose: () => void; onAdd: () => void; onNewWorkflow: () => void; onDecision: () => void; onFit: () => void; onDuplicate: () => void; onDelete: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const t = setTimeout(() => ref.current?.querySelector('button')?.focus(), 0); return () => clearTimeout(t); }, []);
  const isFrame = menu.nodeId?.startsWith('f:');
  const isGate = menu.nodeId?.startsWith('gate:');
  const items: { label: string; run: () => void; danger?: boolean }[] = menu.target === 'pane'
    ? [{ label: 'Add node…', run: onAdd }, { label: 'New workflow here', run: onNewWorkflow }, { label: 'Add a decision here', run: onDecision }, { label: 'Fit view', run: onFit }]
    : isGate ? [{ label: 'Delete decision', run: onDelete, danger: true }]
    : isFrame && model ? [
      ...(model.editable && model.graph.nodes.some(n => n.type === 'step') ? [{ label: 'Run workflow', run: () => { actions.save(model, true); onClose(); } }] : []),
      ...(model.editable && model.sketch ? [{ label: 'Save draft', run: () => { actions.save(model, false); onClose(); } }, { label: 'Discard', run: () => { actions.discard(model); onClose(); }, danger: true }] : []),
      ...(!model.editable && model.workflow && !['completed', 'canceled'].includes(model.workflow.status) ? [{ label: 'Terminate…', run: () => { actions.terminate(model); onClose(); }, danger: true }] : []),
      ...(!model.editable ? [{ label: 'Visibility…', run: () => { actions.select(`f:${model.id}`); onClose(); } }] : []),
    ]
    : model?.editable ? [{ label: 'Duplicate', run: onDuplicate }, { label: 'Delete', run: onDelete, danger: true }] : [{ label: 'Finalized: terminate the workflow to change it', run: onClose }];
  return (
    <div ref={ref} className="cv-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 220) }}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const bs = [...(ref.current?.querySelectorAll('button') ?? [])]; const i = bs.indexOf(document.activeElement as HTMLButtonElement); bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length]?.focus(); }
      }}>
      {items.map(i => <button key={i.label} type="button" role="menuitem" className={i.danger ? 'danger' : ''} onClick={i.run}>{i.label}</button>)}
    </div>
  );
}

// ---- inspector ------------------------------------------------------------------------------------------------

interface InspectorProps {
  state: ControlState; model?: FrameModel; gate?: CanvasGate; nodeId: string; models: FrameModel[];
  gateLink?: LinkState; chainLinks: { chain: { id: string; from: string; to: string }; state: LinkState; other: string }[];
  editFrame: (frameId: string, fn: (s: CanvasSketch) => CanvasSketch) => void;
  update: (fn: (l: CanvasLayout) => CanvasLayout) => void;
  actions: FrameActions; onDesign: () => void; onClose: () => void;
}

function Inspector({ state, model: m, gate, gateLink, chainLinks, nodeId, models, editFrame, update, actions, onDesign, onClose }: InspectorProps) {
  const { busy, error, run } = useAction();
  const gn = m && !nodeId.startsWith('f:') ? m.graph.nodes.find(n => `${m.id}/${n.id}` === nodeId) : undefined;
  const editable = Boolean(m?.editable);
  const patch = (data: Record<string, unknown>) => { if (m && gn) editFrame(m.id, s => ({ ...s, graph: { ...s.graph, nodes: s.graph.nodes.map(n => n.id === gn.id ? { ...n, data: nodeData(n.type, { ...n.data, ...data }) } : n) } })); };
  const problems = m && !gate ? (gn ? m.problems.filter(p => p.nodeId === gn.id) : m.problems.filter(p => !p.nodeId)) : [];
  const title = gate ? 'Decision' : gn ? (gn.type === 'step' ? `${STEP_LABEL[String(gn.data.kind)]} step` : NODE_SPECS[gn.type].label) : m?.name ?? '';
  return (
    <aside className="cv-inspector" aria-label="Inspector">
      <div className="row"><b className="grow">{title}</b><button type="button" className="btn sm ghost" onClick={onClose} aria-label="Close inspector"><Icon name="close" size={14} /></button></div>
      {m && !editable && !gate && <p className="small faint"><Icon name="lock" size={12} /> Finalized. Terminate the workflow to change it.</p>}
      {gate && <GateEditor gate={gate} link={gateLink} models={models} update={update} />}
      {gn && m && <NodeEditor state={state} model={m} node={gn} editable={editable} patch={patch} onDesign={onDesign} busy={busy} run={run} />}
      {m && !gn && !gate && <FrameEditor model={m} editFrame={editFrame} actions={actions} />}
      {m && !gn && !gate && chainLinks.length > 0 && <div className="cv-visibility"><span className="small muted">Hand-offs</span>{chainLinks.map(c => <LinkLine key={c.chain.id} label={c.chain.from === m.id ? `Then starts ${c.other}` : `Starts after ${c.other}`} s={c.state} />)}</div>}
      {problems.length > 0 && <ul className="cv-problems">{problems.map((p, i) => <li key={i} className="small crit-text">{p.message}</li>)}</ul>}
      <ErrorLine error={error} />
    </aside>
  );
}

function FrameEditor({ model: m, editFrame, actions }: { model: FrameModel; editFrame: InspectorProps['editFrame']; actions: FrameActions }) {
  return <div className="col" style={{ gap: 8 }}>
    {m.editable && <label className="col"><span className="small muted">Order</span><select value={m.sketch?.mode ?? m.workflow?.definition.mode ?? 'collaborative'} onChange={e => editFrame(m.id, s => ({ ...s, mode: e.target.value === 'independent' ? 'independent' : 'collaborative' }))}><option value="collaborative">Follow the connections (dependency order)</option><option value="independent">Run every step in parallel</option></select></label>}
    {m.sketch?.continues && <span className="small faint">Continues a terminated workflow. Finished steps stay on the original.</span>}
    {m.workflow && !m.editable && <span className="small">{m.workflow.statusReason ?? `Workflow is ${m.workflow.status}.`}</span>}
    <span className="small faint">{m.graph.nodes.filter(n => n.type === 'step').length} steps · {m.graph.nodes.length} nodes</span>
    {m.workflow && !m.editable && <Visibility model={m} actions={actions} />}
    {m.workflow && m.workflow.status !== 'draft' && <div className="col" style={{ gap: 4 }}>{Object.entries(m.workflow.tasks).map(([id, t]) => <span key={id} className="small row"><Badge tone={TASK_TONE[t.status]}>{t.status.replace('_', ' ')}</Badge><span className="mono">{id}</span>{t.reason && <span className="faint ellipsis">{t.reason}</span>}</span>)}</div>}
    <span className="small faint">Connect this workflow's Finished rail to another workflow's Start rail, or to a Decision, to hand off. Hand-offs turn on once both workflows are saved.</span>
  </div>;
}

function NodeEditor({ state, model: m, node: n, editable, patch, onDesign, busy, run }: { state: ControlState; model: FrameModel; node: GraphNode; editable: boolean; patch: (d: Record<string, unknown>) => void; onDesign: () => void; busy: boolean; run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const [creatingIssue, setCreatingIssue] = useState(false);
  const d = n.data;
  const dis = !editable;
  const w = m.workflow && m.workflow.status !== 'draft' ? m.workflow : null;
  switch (n.type) {
    case 'agent': {
      const a = state.agents[String(d.agentId)];
      return <div className="col" style={{ gap: 8 }}>
        <label className="col"><span className="small muted">Agent</span><select disabled={dis} value={String(d.agentId ?? '')} onChange={e => patch({ agentId: e.target.value })}><option value="">Choose an agent…</option>{Object.values(state.agents).map(x => <option key={x.id} value={x.id} disabled={x.config.enabled === false}>{x.config.name}{x.config.mode === 'coordinator-only' ? ' (plans only)' : ''}{isManualRelay(x.config) ? ' (relay)' : ''}</option>)}</select></label>
        <label className="col"><span className="small muted">Model (empty = the agent's configured model)</span><input disabled={dis} value={String(d.model ?? '')} placeholder={a?.config.model ?? 'default'} onChange={e => patch({ model: e.target.value })} /></label>
        <label className="col"><span className="small muted">Effort</span><select disabled={dis} value={String(d.effort ?? '')} onChange={e => patch({ effort: e.target.value || null })}><option value="">Default</option>{EFFORTS.map(x => <option key={x} value={x}>{x}</option>)}</select></label>
        <span className="small faint">Runs → a step's Agent input. Talks with → another Agent lets them consult each other in this workflow. Skills and connectors plugged in here apply to every step this agent runs.</span>
        {a && <Link className="small" to={`/agents/${encodeURIComponent(a.id)}`}>Open {a.config.name}'s console</Link>}
      </div>;
    }
    case 'issue': {
      const items = Object.values(state.workItems).filter(x => x.state !== 'verified' && x.state !== 'canceled');
      return <div className="col" style={{ gap: 8 }}>
        <label className="col"><span className="small muted">Issue</span><select disabled={dis} value={String(d.workItemId ?? '')} onChange={e => patch({ workItemId: e.target.value })}><option value="">Choose an issue…</option>{items.map(i => <option key={i.id} value={i.id}>{i.key ?? 'pending'} · {i.title}</option>)}</select></label>
        {editable && <button type="button" className="btn sm" onClick={() => setCreatingIssue(true)}>Create an issue…</button>}
        {d.workItemId ? <Link className="small" to={`/board?item=${encodeURIComponent(String(d.workItemId))}`}>Open in the issue list</Link> : null}
        {creatingIssue && <NewIssueDialog trackerTarget="the project tracker" onClose={() => setCreatingIssue(false)} onCreated={item => patch({ workItemId: item.id })} />}
      </div>;
    }
    case 'step': {
      const st = w ? w.tasks[String(d.taskId)] : null;
      const runs = st?.assignmentId ? Object.values(state.runs).filter(r => r.assignmentId === st.assignmentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
      return <div className="col" style={{ gap: 8 }}>
        <label className="col"><span className="small muted">Title</span><input disabled={dis} value={String(d.title ?? '')} placeholder="What this step delivers" onChange={e => patch({ title: e.target.value })} /></label>
        <label className="col"><span className="small muted">Step</span><select disabled={dis} value={String(d.kind)} onChange={e => patch({ kind: e.target.value })}>{['coordination', 'code', 'review'].map(k => <option key={k} value={k}>{STEP_LABEL[k]}: {STEP_HINT[k]}</option>)}</select></label>
        <label className="col"><span className="small muted">Step id</span><input disabled={dis} value={String(d.taskId ?? '')} onChange={e => patch({ taskId: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} /></label>
        {d.kind !== 'review' && <label className="col"><span className="small muted">Allowed paths (empty = whole repo)</span><input disabled={dis} value={((d.allowedPaths as string[]) ?? []).join(', ')} placeholder="src/api/**, docs/api.md" onChange={e => patch({ allowedPaths: e.target.value.split(/[,\n]/).map(p => p.trim()).filter(Boolean) })} /></label>}
        <span className="small faint">Inputs: Agent (required), Issue, After (earlier steps; a Review's first Build is what it checks), Design, Skills, Connectors, Context.</span>
        {d.pickup ? <div className="cv-pickup-box"><b className="small">Pickup point from the previous attempt</b><pre>{String(d.pickup)}</pre></div> : null}
        {st && <div className="row small wrap"><Badge tone={TASK_TONE[st.status]}>{st.status.replace('_', ' ')}</Badge>{st.completedSha && <span className="mono faint">@ {st.completedSha.slice(0, 10)}</span>}{st.reason && <span className="muted">{st.reason}</span>}</div>}
        {runs.length > 0 && <div className="col" style={{ gap: 4 }}><span className="small muted">Runs</span>{runs.slice(0, 5).map(r => <Link key={r.id} className="small" to={`/runs/${encodeURIComponent(r.id)}`}>{r.state} · {new Date(r.createdAt).toLocaleString()}</Link>)}</div>}
        {w && st && ['failed', 'blocked', 'changes_requested'].includes(st.status) && !['canceled', 'completed'].includes(w.status) && <button type="button" className="btn sm" disabled={busy} onClick={() => void run(() => post(`/api/workflows/${encodeURIComponent(w.id)}/tasks/${encodeURIComponent(String(d.taskId))}/retry`))}>Retry step</button>}
      </div>;
    }
    case 'design': {
      const current = state.design?.hash ?? null;
      const options = Object.values(state.mocks ?? {}).flatMap(a => a.revisions.filter(r => mockGate(r, current).state === 'approved').map(r => ({ a, r })));
      return <div className="col" style={{ gap: 8 }}>
        <label className="col"><span className="small muted">Approved mock revision</span><select disabled={dis} value={d.artifactId ? `${String(d.artifactId)}#${String(d.rev)}` : ''} onChange={e => { const [artifactId, rev] = e.target.value.split('#'); patch({ artifactId, rev: Number(rev) }); }}>
          <option value="">Choose an approved revision…</option>{options.map(({ a, r }) => <option key={`${a.id}#${r.rev}`} value={`${a.id}#${r.rev}`}>{a.title} · rev {r.rev}</option>)}</select></label>
        {options.length === 0 && <span className="small faint">No approved mocks yet. Design one, review it, then pick it here.</span>}
        <button type="button" className="btn sm" onClick={onDesign}>Open Designer</button>
      </div>;
    }
    case 'skill':
      return <div className="col" style={{ gap: 8 }}>
        <label className="col"><span className="small muted">Skill</span><select disabled={dis} value={String(d.skillId ?? '')} onChange={e => patch({ skillId: e.target.value, label: state.skills?.[e.target.value]?.name ?? '' })}><option value="">Choose a skill…</option>{Object.values(state.skills ?? {}).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <MarketplaceImport kind="skill" onImported={(id, label) => patch({ skillId: id, label })} disabled={dis} />
        <Link className="small" to="/skills">Manage the skill library</Link>
      </div>;
    case 'connector':
      return <div className="col" style={{ gap: 8 }}>
        <label className="col"><span className="small muted">Connector</span><select disabled={dis} value={String(d.connectorId ?? '')} onChange={e => patch({ connectorId: e.target.value, label: state.connectors?.[e.target.value]?.name ?? '' })}><option value="">Choose a connector…</option>{Object.values(state.connectors ?? {}).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <MarketplaceImport kind="connector" onImported={(id, label) => patch({ connectorId: id, label })} disabled={dis} />
        <span className="small faint">Every tool call still goes through its normal approval.</span>
        <Link className="small" to="/connectors">Manage connectors</Link>
      </div>;
    case 'ask': return <AskEditor node={n} editable={editable} patch={patch} />;
    case 'summary': return <SummaryEditor model={m} node={n} editable={editable} patch={patch} />;
    case 'note': return <label className="col"><span className="small muted">Note (never sent to agents)</span><textarea disabled={dis} rows={5} value={String(d.text ?? '')} onChange={e => patch({ text: e.target.value })} /></label>;
  }
}

function AskEditor({ node: n, editable, patch }: { node: GraphNode; editable: boolean; patch: (d: Record<string, unknown>) => void }) {
  const { busy, error, run } = useAction();
  const ask = () => run(async () => {
    const r = await post<{ claims: { text: string }[]; citations: { path: string; line: number; excerpt: string }[] }>('/api/context/answer/search', { query: String(n.data.question ?? '') });
    const answer = r.claims.length ? r.claims.map(c => c.text).join('\n') : r.citations.slice(0, 4).map(c => `${c.path}:${c.line} ${c.excerpt}`).join('\n');
    patch({ answer, sources: r.citations.slice(0, 20).map(c => `${c.path}:${c.line}`) });
  });
  return <div className="col" style={{ gap: 8 }}>
    <label className="col"><span className="small muted">Question to your project knowledge</span><textarea disabled={!editable} rows={3} value={String(n.data.question ?? '')} onChange={e => patch({ question: e.target.value, answer: null, sources: [] })} /></label>
    {editable && <button type="button" className="btn sm" disabled={busy || !String(n.data.question ?? '').trim()} onClick={() => void ask()}>{busy ? 'Asking…' : 'Ask One Ask'}</button>}
    {n.data.answer ? <div className="cv-pickup-box"><b className="small">Answer (sent as context to connected steps)</b><pre>{String(n.data.answer)}</pre></div> : null}
    {((n.data.sources as string[]) ?? []).length > 0 && <details><summary className="small">Sources</summary><ul className="small">{(n.data.sources as string[]).map(s => <li key={s}><code>{s}</code></li>)}</ul></details>}
    <span className="small faint">Connect Answer → a Summary node for plain language, or straight to a step's Context.</span>
    <ErrorLine error={error} />
  </div>;
}

function SummaryEditor({ model: m, node: n, editable, patch }: { model: FrameModel; node: GraphNode; editable: boolean; patch: (d: Record<string, unknown>) => void }) {
  const { busy, error, run } = useAction();
  const inputs = m.graph.edges.filter(e => e.to === n.id && e.toPort === 'context').map(e => m.graph.nodes.find(x => x.id === e.from)).filter((x): x is GraphNode => Boolean(x));
  const text = inputs.map(x => x.type === 'ask' ? `Question: ${String(x.data.question ?? '')}\nAnswer: ${String(x.data.answer ?? '')}` : String(x.data.text ?? '')).join('\n\n');
  const summarize = () => run(async () => {
    const r = await post<{ summary: string; model: string }>('/api/local-models/summarize', { text });
    patch({ text: r.summary, model: r.model });
  });
  return <div className="col" style={{ gap: 8 }}>
    <span className="small muted">Plain-language summary by the bundled local model{n.data.model ? ` (${String(n.data.model)})` : ''}. Runs only on this Mac.</span>
    {editable && <button type="button" className="btn sm" disabled={busy || !text.trim()} onClick={() => void summarize()}>{busy ? 'Summarizing…' : inputs.length ? 'Summarize connected answers' : 'Connect a One Ask answer first'}</button>}
    <label className="col"><span className="small muted">Summary (editable; sent as context)</span><textarea disabled={!editable} rows={6} value={String(n.data.text ?? '')} onChange={e => patch({ text: e.target.value })} /></label>
    <ErrorLine error={error} />
  </div>;
}

/** Import from GitHub, the Anthropic skills catalog or the MCP Registry. Previews are pinned; imports land as drafts. */
function MarketplaceImport({ kind, onImported, disabled }: { kind: 'skill' | 'connector'; onImported: (id: string, label: string) => void; disabled: boolean }) {
  type SkillRow = { name: string; description: string; path: string; draft: unknown; problems: string[] };
  type Preview = { url: string; repo: string; commit: string; license: string | null; skills: SkillRow[] };
  type Server = { name: string; version: string; description: string };
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [skills, setSkills] = useState<Preview | null>(null);
  const [servers, setServers] = useState<Server[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const look = () => run(async () => {
    setNote(null); setSkills(null); setServers(null);
    try {
      if (kind === 'skill') setSkills(url.trim() ? await post<Preview>('/api/marketplace/github/preview', { url: url.trim() }) : await api<Preview>('/api/marketplace/anthropic-skills'));
      else setServers((await api<{ servers: Server[] }>(`/api/marketplace/mcp?q=${encodeURIComponent(url.trim())}`)).servers);
    } catch (e) { if (e instanceof ApiError && e.status === 404) setNote('Marketplace import is not in this build.'); else throw e; }
  });
  const addSkill = (row: SkillRow) => run(async () => {
    const r = await post<{ skills: { skill: { id: string; name: string } }[]; note: string }>('/api/marketplace/github/import', { url: skills!.url, commit: skills!.commit, paths: [row.path] });
    const s = r.skills[0]?.skill; if (s) onImported(s.id, s.name);
    setNote(`${r.note} Publish it in Settings → Skills; steps only run with published skills.`);
  });
  const addServer = (row: Server) => run(async () => {
    const r = await post<{ connection: { id: string; name: string } | undefined; setupRequired: boolean; note: string }>('/api/marketplace/mcp/draft', { name: row.name, version: row.version });
    if (r.connection) onImported(r.connection.id, r.connection.name);
    setNote(`${r.note} Approve it in Settings → Connectors before a step can use it.`);
  });
  if (disabled) return null;
  if (!open) return <button type="button" className="btn sm" onClick={() => setOpen(true)}>{kind === 'skill' ? 'Import from GitHub or the Anthropic catalog…' : 'Find in the MCP Registry…'}</button>;
  return <div className="cv-market col" style={{ gap: 6 }}>
    <input aria-label={kind === 'skill' ? 'GitHub repository URL' : 'Search the MCP Registry'} placeholder={kind === 'skill' ? 'https://github.com/owner/repo (empty = Anthropic catalog)' : 'Search, e.g. github, postgres'} value={url} onChange={e => setUrl(e.target.value)} />
    <div className="row" style={{ gap: 6 }}><button type="button" className="btn sm" disabled={busy} onClick={() => void look()}>{busy ? 'Looking…' : kind === 'skill' ? 'Preview' : 'Search'}</button><button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>Close</button></div>
    {skills && <>
      <span className="small faint">{skills.repo} @ {skills.commit.slice(0, 12)} · {skills.license ?? 'no license found'} · preview only, nothing runs</span>
      <ul className="cv-market-list">{skills.skills.slice(0, 30).map(sk => <li key={sk.path}><span className="grow"><b>{sk.name}</b> <span className="small muted">{sk.description.slice(0, 110)}</span>{sk.problems.length > 0 && <span className="small crit-text"> {sk.problems[0]}</span>}</span><button type="button" className="btn sm" disabled={busy || !sk.draft} title={sk.draft ? 'Import as a draft skill' : 'This skill needs files the portable format cannot hold'} onClick={() => void addSkill(sk)}>Import</button></li>)}
        {skills.skills.length === 0 && <li className="small faint">No SKILL.md files found there.</li>}</ul>
    </>}
    {servers && <ul className="cv-market-list">{servers.slice(0, 30).map(sv => <li key={`${sv.name}@${sv.version}`}><span className="grow"><b>{sv.name}</b> <span className="small faint">{sv.version}</span> <span className="small muted">{sv.description.slice(0, 110)}</span></span><button type="button" className="btn sm" disabled={busy} onClick={() => void addServer(sv)}>Add draft</button></li>)}
      {servers.length === 0 && <li className="small faint">Nothing found.</li>}</ul>}
    {note && <span className="small muted">{note}</span>}
    <ErrorLine error={error} />
  </div>;
}

function LinkLine({ label, s }: { label: string; s: LinkState }) {
  return <div className="col" style={{ gap: 2 }}>
    <span className="small"><b>{label}</b> · {linkLabel(s)}</span>
    {s.waiting && <span className="small faint">{s.waiting}</span>}
    {s.error && <span className="small crit-text">{s.error}</span>}
    {s.link?.reason && <span className="small muted">{s.link.reason}</span>}
  </div>;
}

function GateEditor({ gate: g, link, models, update }: { gate: CanvasGate; link?: LinkState; models: FrameModel[]; update: InspectorProps['update'] }) {
  const set = (p: Partial<CanvasGate>) => update(l => l.gates[g.id] ? { ...l, gates: { ...l.gates, [g.id]: { ...l.gates[g.id], ...p } } } : l);
  const jevHost = useJevHost();
  const locked = Boolean(link?.link && link.link.status !== 'waiting');
  const targets = models.filter(m => m.id !== g.from);
  const confirmPolicy = () => {
    if (!jevHost) return;
    if (!window.confirm(`Let JEV advise on this decision?\n\nWhen the workflow before it finishes, One Connect sends JEV a bounded, redacted summary of at most ${g.maxEvidenceBytes} bytes, only to ${jevHost}, and shows you JEV's recommendation. You still choose, unless you also let JEV decide.`)) return;
    set({ confirmedAt: new Date().toISOString() });
  };
  const allowDecide = (on: boolean) => {
    if (!on) { set({ autoDecide: false }); return; }
    if (!window.confirm('Let JEV pick the next workflow on its own for this decision?\n\nJEV only chooses among the options listed here (each just starts a saved workflow). It never answers merges, releases, publishing, connector or tool access, cost or anything irreversible: those always wait for you. If JEV is off, errors or answers anything else, you decide.')) return;
    set({ autoDecide: true });
  };
  return <div className="col" style={{ gap: 8 }}>
    {link && <LinkLine label="Status" s={link} />}
    {link?.link?.status === 'open' && <Link className="btn sm" to="/inbox">Answer in the Inbox</Link>}
    {link?.link?.decision && <span className="small">Chose “{link.link.decision.option}” ({link.link.decision.by === 'jev' ? 'JEV' : 'you'}, {new Date(link.link.decision.at).toLocaleString()})</span>}
    {locked && <span className="small faint"><Icon name="lock" size={12} /> This decision is in use. Delete it and add a new one to change it.</span>}
    <fieldset className="cv-visibility" disabled={locked}><legend className="small">Who decides</legend>
      <label><input type="radio" name={`who-${g.id}`} checked={g.kind === 'human'} onChange={() => set({ kind: 'human', autoDecide: false, confirmedAt: null })} /> You decide</label>
      <label><input type="radio" name={`who-${g.id}`} checked={g.kind === 'jev'} onChange={() => set({ kind: 'jev', autoDecide: false, confirmedAt: null })} /> JEV recommends{!jevHost ? ' (turn JEV on in Settings first)' : ''}</label>
      {g.kind === 'jev' && <>
        <label className="col"><span className="small muted">Evidence JEV may receive (bytes, 1–24000)</span><input type="number" min={1} max={24000} step={500} value={g.maxEvidenceBytes} onChange={e => set({ maxEvidenceBytes: Math.min(24000, Math.max(1, Math.round(Number(e.target.value) || 1))), confirmedAt: null, autoDecide: false })} /></label>
        {g.confirmedAt ? <span className="small faint">JEV policy confirmed {new Date(g.confirmedAt).toLocaleString()} for {jevHost ?? 'your JEV host'}.</span>
          : <button type="button" className="btn sm" disabled={!jevHost} onClick={confirmPolicy}>Confirm what JEV may receive…</button>}
        <label><input type="checkbox" checked={g.autoDecide} disabled={!g.confirmedAt} onChange={e => allowDecide(e.target.checked)} /> JEV may decide on its own (low-risk choices only)</label>
      </>}
    </fieldset>
    <label className="col"><span className="small muted">Question</span><textarea disabled={locked} rows={2} value={g.question} placeholder="Is the frontend good enough to start the backend?" onChange={e => set({ question: e.target.value })} /></label>
    <label className="col"><span className="small muted">After workflow</span><select disabled={locked} value={g.from} onChange={e => set({ from: e.target.value })}><option value="">Connect or choose…</option>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    <fieldset className="cv-visibility" disabled={locked}><legend className="small">Options (2–8, each starts a different workflow)</legend>
      {g.options.map((o, i) => <div key={i} className="row" style={{ gap: 6 }}>
        <input aria-label={`Option ${i + 1} label`} value={o.label} onChange={e => set({ options: g.options.map((x, j) => j === i ? { ...x, label: e.target.value } : x) })} />
        <select aria-label={`Option ${i + 1} starts`} value={o.to} onChange={e => set({ options: g.options.map((x, j) => j === i ? { ...x, to: e.target.value } : x) })}><option value="">Starts…</option>{targets.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
        <button type="button" className="btn sm ghost" aria-label={`Remove option ${i + 1}`} disabled={g.options.length <= 2} onClick={() => set({ options: g.options.filter((_, j) => j !== i) })}><Icon name="close" size={12} /></button>
      </div>)}
      {g.options.length < 8 && <button type="button" className="btn sm" onClick={() => set({ options: [...g.options, { label: `Option ${g.options.length + 1}`, to: '' }] })}>Add option</button>}
    </fieldset>
  </div>;
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
