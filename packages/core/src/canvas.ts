// SPDX-License-Identifier: Apache-2.0
// Project canvas: a ComfyUI-style typed node graph per workflow (agents, issues, steps, designs,
// skills, connectors, One Ask context, summaries, notes), frames that can be hidden, gates and
// chains that link whole workflows, and unsaved sketches. Pure; the daemon stores it, the browser
// renders it. A sketch compiles to an ordinary workflow definition; the engine stays the authority.
import type { ControlState } from './entities.ts';
import { EFFORTS, type Effort } from './config.ts';
import { normalizeWorkflow, type Workflow, type WorkflowDefinition, type WorkflowMode, type WorkflowTaskDef, type WorkflowTaskKind } from './workflows.ts';

// ---- node and port catalog ------------------------------------------------------------------------

export const PORT_TYPES = ['agent', 'issue', 'flow', 'design', 'skill', 'tools', 'context', 'consult'] as const;
export type PortType = (typeof PORT_TYPES)[number];
export interface PortSpec { id: string; type: PortType; label: string; multi?: boolean }

export const NODE_TYPES = ['agent', 'issue', 'step', 'design', 'skill', 'connector', 'ask', 'summary', 'note'] as const;
export type GraphNodeType = (typeof NODE_TYPES)[number];
export type NodeCategory = 'Agents' | 'Steps' | 'Inputs' | 'Library' | 'Notes';
export interface NodeSpec { type: GraphNodeType; label: string; category: NodeCategory; hint: string; inputs: PortSpec[]; outputs: PortSpec[] }

/** What each node accepts and produces. Edges must join an output to an input of the same type. */
export const NODE_SPECS: Record<GraphNodeType, NodeSpec> = {
  agent: {
    type: 'agent', label: 'Agent', category: 'Agents', hint: 'Which agent runs the steps it connects to, with its model and effort',
    inputs: [{ id: 'skills', type: 'skill', label: 'Skills', multi: true }, { id: 'tools', type: 'tools', label: 'Connectors', multi: true }, { id: 'consult', type: 'consult', label: 'Talks with', multi: true }],
    outputs: [{ id: 'agent', type: 'agent', label: 'Runs' }, { id: 'consult', type: 'consult', label: 'Talks with' }],
  },
  issue: { type: 'issue', label: 'Issue', category: 'Inputs', hint: 'The tracker issue a step works on', inputs: [], outputs: [{ id: 'issue', type: 'issue', label: 'Issue' }] },
  step: {
    type: 'step', label: 'Step', category: 'Steps', hint: 'Plan, build or review, run by the connected agent',
    inputs: [
      { id: 'agent', type: 'agent', label: 'Agent' }, { id: 'issue', type: 'issue', label: 'Issue' }, { id: 'after', type: 'flow', label: 'After', multi: true },
      { id: 'design', type: 'design', label: 'Design' }, { id: 'skills', type: 'skill', label: 'Skills', multi: true }, { id: 'tools', type: 'tools', label: 'Connectors', multi: true },
      { id: 'context', type: 'context', label: 'Context', multi: true },
    ],
    outputs: [{ id: 'done', type: 'flow', label: 'Done' }],
  },
  design: { type: 'design', label: 'Designer artifact', category: 'Inputs', hint: 'An approved mock revision from Designer for the step to follow', inputs: [], outputs: [{ id: 'design', type: 'design', label: 'Design' }] },
  skill: { type: 'skill', label: 'Skill', category: 'Library', hint: 'A skill from your library, GitHub or the Anthropic catalog', inputs: [], outputs: [{ id: 'skill', type: 'skill', label: 'Skill' }] },
  connector: { type: 'connector', label: 'Connector', category: 'Library', hint: 'Tools from a connector (MCP server); still approved per use', inputs: [], outputs: [{ id: 'tools', type: 'tools', label: 'Connector' }] },
  ask: { type: 'ask', label: 'One Ask', category: 'Inputs', hint: 'A question to your project knowledge; its answer becomes context', inputs: [], outputs: [{ id: 'context', type: 'context', label: 'Answer' }] },
  summary: { type: 'summary', label: 'Summary', category: 'Inputs', hint: 'Plain-language summary of One Ask results by the local model', inputs: [{ id: 'context', type: 'context', label: 'From', multi: true }], outputs: [{ id: 'context', type: 'context', label: 'Summary' }] },
  note: { type: 'note', label: 'Note', category: 'Notes', hint: 'A comment on the canvas; never sent to agents', inputs: [], outputs: [] },
};

export function portSpec(type: GraphNodeType, side: 'in' | 'out', id: string): PortSpec | undefined {
  return (side === 'in' ? NODE_SPECS[type].inputs : NODE_SPECS[type].outputs).find((p) => p.id === id);
}

// ---- layout model -------------------------------------------------------------------------------------

export interface CanvasPoint { x: number; y: number }
/** When a hidden workflow comes back on the canvas. */
export interface CanvasShowWhen { input: boolean; failure: boolean; finished: boolean }
export interface CanvasFrame { x: number; y: number; hidden: boolean; showWhen: CanvasShowWhen }
export interface GraphNode { id: string; type: GraphNodeType; data: Record<string, string | number | boolean | null | string[]> }
export interface GraphEdge { id: string; from: string; fromPort: string; to: string; toPort: string }
export interface CanvasGraph { nodes: GraphNode[]; edges: GraphEdge[] }

/** An editable workflow that may not be valid yet. Saving compiles it into a draft workflow. */
export interface CanvasSketch {
  id: string;
  name: string;
  mode: WorkflowMode;
  /** The draft workflow this sketch edits, or null for a new one. */
  workflowId: string | null;
  version: number | null;
  /** The workflow this sketch continues after a terminate. */
  continues: string | null;
  graph: CanvasGraph;
  updatedAt: string;
}

/** A decision between workflows: when `from` finishes, one option starts the next workflow. */
export interface CanvasGate {
  id: string; x: number; y: number;
  from: string;
  kind: 'human' | 'jev';
  question: string;
  options: { label: string; to: string }[];
  /** JEV may pick an option on its own (owner opt-in per gate); otherwise it only recommends. */
  autoDecide: boolean;
  /** When the owner confirmed JEV may decide this gate (host and evidence limits shown first). */
  confirmedAt: string | null;
}
/** A direct link: when `from` finishes, `to` starts. */
export interface CanvasChain { id: string; from: string; to: string }

export interface CanvasLayout {
  version: 2;
  frames: Record<string, CanvasFrame>;
  /** `${frameId}/${nodeId}` → position inside the frame. */
  nodes: Record<string, CanvasPoint>;
  sketches: Record<string, CanvasSketch>;
  gates: Record<string, CanvasGate>;
  chains: Record<string, CanvasChain>;
}

export const CANVAS_LIMITS = { bytes: 512 * 1024, frames: 200, nodes: 4000, sketches: 100, graphNodes: 160, graphEdges: 400, gates: 100, chains: 200, options: 8, text: 200, context: 4000, pickup: 2000 } as const;
export const DEFAULT_SHOW_WHEN: CanvasShowWhen = { input: true, failure: true, finished: false };
export const emptyCanvas = (): CanvasLayout => ({ version: 2, frames: {}, nodes: {}, sketches: {}, gates: {}, chains: {} });

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,95}$/;
const NODE_KEY = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9:._-]{0,95}$/;
const TASK_ID = /^[a-z][a-z0-9-]{0,31}$/;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.max(-1e6, Math.min(1e6, Math.round(n))) : 0; };
const str = (v: unknown, max: number = CANVAS_LIMITS.text) => String(v ?? '').slice(0, max);
const optStr = (v: unknown, max: number = CANVAS_LIMITS.text) => (v == null || v === '' ? null : str(v, max));
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const strList = (v: unknown, max: number, len = 96) => (Array.isArray(v) ? [...new Set(v.map((x) => str(x, len)).filter(Boolean))].slice(0, max) : []);
const KINDS: readonly WorkflowTaskKind[] = ['code', 'review', 'coordination'];

function showWhen(v: unknown): CanvasShowWhen {
  const o = (v ?? {}) as Partial<CanvasShowWhen>;
  return { input: bool(o.input, DEFAULT_SHOW_WHEN.input), failure: bool(o.failure, DEFAULT_SHOW_WHEN.failure), finished: bool(o.finished, DEFAULT_SHOW_WHEN.finished) };
}

/** Only the fields each node type defines survive, each bounded. */
export function nodeData(type: GraphNodeType, v: unknown): GraphNode['data'] {
  const d = (v ?? {}) as Record<string, unknown>;
  switch (type) {
    case 'agent': return { agentId: str(d.agentId, 96), model: optStr(d.model, 96), effort: (EFFORTS as readonly string[]).includes(String(d.effort)) ? String(d.effort) : null };
    case 'issue': return { workItemId: str(d.workItemId, 96) };
    case 'step': {
      const kind = KINDS.includes(d.kind as WorkflowTaskKind) ? String(d.kind) : 'code';
      return { taskId: TASK_ID.test(String(d.taskId ?? '')) ? String(d.taskId) : '', kind, title: str(d.title), allowedPaths: strList(d.allowedPaths, 32, CANVAS_LIMITS.text), pickup: optStr(d.pickup, CANVAS_LIMITS.pickup) };
    }
    case 'design': return { artifactId: str(d.artifactId, 96), rev: Number.isInteger(d.rev) && Number(d.rev) > 0 ? Number(d.rev) : 0, label: str(d.label) };
    case 'skill': return { skillId: str(d.skillId, 96), label: str(d.label) };
    case 'connector': return { connectorId: str(d.connectorId, 96), label: str(d.label) };
    case 'ask': return { question: str(d.question, 1200), answer: optStr(d.answer, CANVAS_LIMITS.context), sources: strList(d.sources, 20, 300) };
    case 'summary': return { text: optStr(d.text, CANVAS_LIMITS.context), model: optStr(d.model, 96) };
    case 'note': return { text: str(d.text, 2000) };
  }
}

/** Keep valid nodes, and edges that join an existing output to an input of the same type. */
export function normalizeGraph(input: unknown): CanvasGraph {
  const raw = (input ?? {}) as { nodes?: unknown[]; edges?: unknown[] };
  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  for (const n of (Array.isArray(raw.nodes) ? raw.nodes : []).slice(0, CANVAS_LIMITS.graphNodes)) {
    const o = (n ?? {}) as Partial<GraphNode>;
    const id = String(o.id ?? '');
    if (!ID.test(id) || seen.has(id) || !NODE_TYPES.includes(o.type as GraphNodeType)) continue;
    seen.add(id);
    nodes.push({ id, type: o.type as GraphNodeType, data: nodeData(o.type as GraphNodeType, o.data) });
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: GraphEdge[] = [];
  const single = new Map<string, number>();
  for (const e of (Array.isArray(raw.edges) ? raw.edges : []).slice(0, CANVAS_LIMITS.graphEdges)) {
    const o = (e ?? {}) as Partial<GraphEdge>;
    const from = byId.get(String(o.from)); const to = byId.get(String(o.to));
    if (!from || !to || from.id === to.id) continue;
    const out = portSpec(from.type, 'out', String(o.fromPort)); const inp = portSpec(to.type, 'in', String(o.toPort));
    if (!out || !inp || out.type !== inp.type) continue;
    const edge = { id: `${from.id}.${out.id}>${to.id}.${inp.id}`, from: from.id, fromPort: out.id, to: to.id, toPort: inp.id };
    if (edges.some((x) => x.id === edge.id)) continue;
    if (!inp.multi) { // a single-value input keeps only its latest edge
      const key = `${to.id}.${inp.id}`;
      const prev = single.get(key);
      if (prev !== undefined) edges.splice(prev, 1, edge); else { single.set(key, edges.length); edges.push(edge); }
      continue;
    }
    edges.push(edge);
  }
  return { nodes, edges };
}

/** Bound and sanitize a stored or submitted layout. Version 1 sketches migrate to graphs. */
export function normalizeCanvas(input: unknown): CanvasLayout {
  const raw = (input ?? {}) as Partial<Record<keyof CanvasLayout, unknown>>;
  const out = emptyCanvas();
  for (const [id, f] of Object.entries((raw.frames ?? {}) as Record<string, Partial<CanvasFrame>>).slice(0, CANVAS_LIMITS.frames)) {
    if (!ID.test(id) || !f || typeof f !== 'object') continue;
    out.frames[id] = { x: num(f.x), y: num(f.y), hidden: bool(f.hidden, false), showWhen: showWhen(f.showWhen) };
  }
  for (const [key, p] of Object.entries((raw.nodes ?? {}) as Record<string, Partial<CanvasPoint>>).slice(0, CANVAS_LIMITS.nodes)) {
    if (!NODE_KEY.test(key) || !p || typeof p !== 'object') continue;
    out.nodes[key] = { x: num(p.x), y: num(p.y) };
  }
  for (const [id, s] of Object.entries((raw.sketches ?? {}) as Record<string, Record<string, unknown>>).slice(0, CANVAS_LIMITS.sketches)) {
    if (!ID.test(id) || !s || typeof s !== 'object') continue;
    const mode: WorkflowMode = s.mode === 'independent' ? 'independent' : 'collaborative';
    const graph = s.graph ? normalizeGraph(s.graph) : legacyGraph(s);
    out.sketches[id] = {
      id, name: str(s.name, 120), mode,
      workflowId: s.workflowId ? str(s.workflowId, 96) : null,
      version: typeof s.version === 'number' && Number.isInteger(s.version) ? s.version : null,
      continues: s.continues ? str(s.continues, 96) : null,
      graph, updatedAt: str(s.updatedAt, 40),
    };
  }
  for (const [id, g] of Object.entries((raw.gates ?? {}) as Record<string, Partial<CanvasGate>>).slice(0, CANVAS_LIMITS.gates)) {
    if (!ID.test(id) || !g || typeof g !== 'object' || !ID.test(String(g.from ?? ''))) continue;
    const options = (Array.isArray(g.options) ? g.options : []).slice(0, CANVAS_LIMITS.options)
      .map((o) => ({ label: str((o as { label?: unknown })?.label, 80), to: str((o as { to?: unknown })?.to, 96) }))
      .filter((o) => o.label && (o.to === '' || ID.test(o.to)));
    const autoDecide = g.kind === 'jev' && bool(g.autoDecide, false) && typeof g.confirmedAt === 'string' && g.confirmedAt.length > 0;
    out.gates[id] = { id, x: num(g.x), y: num(g.y), from: String(g.from), kind: g.kind === 'jev' ? 'jev' : 'human', question: str(g.question, 500), options, autoDecide, confirmedAt: autoDecide ? str(g.confirmedAt, 40) : null };
  }
  for (const [id, c] of Object.entries((raw.chains ?? {}) as Record<string, Partial<CanvasChain>>).slice(0, CANVAS_LIMITS.chains)) {
    if (!ID.test(id) || !c || !ID.test(String(c.from ?? '')) || !ID.test(String(c.to ?? '')) || c.from === c.to) continue;
    out.chains[id] = { id, from: String(c.from), to: String(c.to) };
  }
  return out;
}

/** Version 1 sketches stored tasks and issues; they become the same graph a workflow derives. */
function legacyGraph(s: Record<string, unknown>): CanvasGraph {
  const tasks = (Array.isArray(s.tasks) ? s.tasks : []) as Partial<WorkflowTaskDef & { pickup: string | null }>[];
  const issues = strList(s.issues, 64);
  return deriveGraph(tasks.map((t) => ({ id: str(t.id, 32), title: str(t.title), kind: KINDS.includes(t.kind as WorkflowTaskKind) ? (t.kind as WorkflowTaskKind) : 'code', agentId: str(t.agentId, 96), workItemId: str(t.workItemId, 96), dependsOn: strList(t.dependsOn, 64, 32), reviewOf: t.reviewOf ? str(t.reviewOf, 32) : null, allowedPaths: strList(t.allowedPaths, 32, CANVAS_LIMITS.text), requiredChecks: null, pickup: t.pickup ? str(t.pickup, CANVAS_LIMITS.pickup) : null })), issues);
}

// ---- graph ⇄ workflow --------------------------------------------------------------------------------

/** Step options the canvas attaches. The engine keeps the ones it supports and ignores the rest. */
export interface TaskExtras {
  model?: string | null;
  effort?: Effort | null;
  skills?: string[];
  connectors?: string[];
  design?: { artifactId: string; rev: number } | null;
  context?: string | null;
  pickup?: string | null;
  consults?: string[];
}
export type CompiledTask = WorkflowTaskDef & TaskExtras;
export interface CompiledWorkflow { definition: WorkflowDefinition & { tasks: CompiledTask[] }; problems: { nodeId: string | null; message: string }[] }

/** The workflow task id a step node compiles to. */
export const stepTaskId = (n: GraphNode) => (n.data.taskId ? String(n.data.taskId) : n.id.replace(/^t:/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, '').slice(0, 32) || 'step');

/** Compile a sketch graph into a workflow definition, with the problems that block saving it. */
export function compileSketch(s: Pick<CanvasSketch, 'name' | 'mode' | 'graph'>): CompiledWorkflow {
  const { nodes, edges } = s.graph;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const into = (id: string, port: string) => edges.filter((e) => e.to === id && e.toPort === port).map((e) => byId.get(e.from)!).filter(Boolean);
  const problems: CompiledWorkflow['problems'] = [];
  const steps = nodes.filter((n) => n.type === 'step');
  const ids = new Map(steps.map((n) => [n.id, stepTaskId(n)]));
  const dup = [...ids.values()].filter((v, i, a) => a.indexOf(v) !== i);
  for (const d of new Set(dup)) problems.push({ nodeId: null, message: `Two steps share the id "${d}". Rename one.` });
  const consultsOf = (agent: GraphNode) => [...new Set([
    ...edges.filter((e) => e.from === agent.id && e.fromPort === 'consult').map((e) => byId.get(e.to)),
    ...edges.filter((e) => e.to === agent.id && e.toPort === 'consult').map((e) => byId.get(e.from)),
  ].filter((n): n is GraphNode => n?.type === 'agent').map((n) => String(n.data.agentId)).filter((a) => a && a !== agent.data.agentId))];
  const libraryOf = (n: GraphNode, port: 'skills' | 'tools', field: 'skillId' | 'connectorId') => into(n.id, port).map((x) => String(x.data[field] ?? '')).filter(Boolean);
  const tasks: CompiledTask[] = steps.map((n) => {
    const agent = into(n.id, 'agent')[0];
    const issue = into(n.id, 'issue')[0];
    const kind = String(n.data.kind) as WorkflowTaskKind;
    const after = into(n.id, 'after').filter((x) => x.type === 'step');
    let reviewOf: string | null = null;
    const dependsOn: string[] = [];
    for (const a of after) {
      if (kind === 'review' && !reviewOf && a.data.kind === 'code') reviewOf = ids.get(a.id)!;
      else dependsOn.push(ids.get(a.id)!);
    }
    if (!agent) problems.push({ nodeId: n.id, message: 'Connect an Agent node to this step.' });
    else if (!agent.data.agentId) problems.push({ nodeId: agent.id, message: 'Choose which agent this Agent node uses.' });
    if (kind !== 'review' && !issue) problems.push({ nodeId: n.id, message: 'Connect an Issue to this step.' });
    if (kind === 'review' && !reviewOf) problems.push({ nodeId: n.id, message: 'Connect the Build step this review checks to its After input.' });
    const design = into(n.id, 'design')[0];
    const context = into(n.id, 'context').map((x) => String((x.type === 'ask' ? x.data.answer ?? x.data.question : x.data.text) ?? '')).filter(Boolean).join('\n\n').slice(0, CANVAS_LIMITS.context);
    const skills = [...new Set([...libraryOf(n, 'skills', 'skillId'), ...(agent ? libraryOf(agent, 'skills', 'skillId') : [])])];
    const connectors = [...new Set([...libraryOf(n, 'tools', 'connectorId'), ...(agent ? libraryOf(agent, 'tools', 'connectorId') : [])])];
    const extras: TaskExtras = {
      model: agent?.data.model ? String(agent.data.model) : null,
      effort: agent?.data.effort ? (String(agent.data.effort) as Effort) : null,
      skills, connectors,
      design: design && design.data.artifactId && Number(design.data.rev) > 0 ? { artifactId: String(design.data.artifactId), rev: Number(design.data.rev) } : null,
      context: context || null,
      pickup: n.data.pickup ? String(n.data.pickup) : null,
      consults: agent ? consultsOf(agent) : [],
    };
    return { id: ids.get(n.id)!, title: String(n.data.title ?? ''), workItemId: issue ? String(issue.data.workItemId) : '', agentId: agent ? String(agent.data.agentId) : '', kind, dependsOn, allowedPaths: (n.data.allowedPaths as string[]) ?? [], requiredChecks: null, reviewOf, ...extras };
  });
  const base = normalizeWorkflow({ name: s.name, mode: s.mode, tasks });
  const extrasById = new Map(tasks.map((t) => [t.id, t]));
  const definition = { ...base, tasks: base.tasks.map((t) => { const x = extrasById.get(t.id)!; return { ...t, model: x.model, effort: x.effort, skills: x.skills, connectors: x.connectors, design: x.design, context: x.context, pickup: x.pickup, consults: x.consults }; }) };
  if (!steps.length) problems.push({ nodeId: null, message: 'Add a step.' });
  return { definition, problems };
}

/** The graph a workflow definition draws as: agents, issues and steps with their wiring. */
export function deriveGraph(tasks: (WorkflowTaskDef & TaskExtras)[], extraIssues: string[] = []): CanvasGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const add = (n: GraphNode) => { if (!nodes.some((x) => x.id === n.id)) nodes.push({ ...n, data: nodeData(n.type, n.data) }); return n.id; };
  const link = (from: string, fromPort: string, to: string, toPort: string) => edges.push({ id: `${from}.${fromPort}>${to}.${toPort}`, from, fromPort, to, toPort });
  const agentKey = (t: WorkflowTaskDef & TaskExtras) => [t.agentId, t.model ?? '', t.effort ?? ''].join('|');
  const agentIds = new Map<string, string>();
  for (const t of tasks) {
    if (!t.agentId) continue;
    const key = agentKey(t);
    if (!agentIds.has(key)) {
      const base = `a:${t.agentId}`.slice(0, 90);
      const id = [...agentIds.values()].includes(base) ? `${base}:${agentIds.size}` : base;
      agentIds.set(key, id);
      add({ id, type: 'agent', data: { agentId: t.agentId, model: t.model ?? null, effort: t.effort ?? null } });
    }
  }
  for (const w of [...tasks.filter((t) => t.kind !== 'review' && t.workItemId).map((t) => t.workItemId), ...extraIssues]) add({ id: `i:${w}`.slice(0, 96), type: 'issue', data: { workItemId: w } });
  for (const t of tasks) {
    const step = add({ id: `t:${t.id}`, type: 'step', data: { taskId: t.id, kind: t.kind, title: t.title, allowedPaths: t.allowedPaths, pickup: t.pickup ?? null } });
    if (t.agentId) link(agentIds.get(agentKey(t))!, 'agent', step, 'agent');
    if (t.kind !== 'review' && t.workItemId) link(`i:${t.workItemId}`.slice(0, 96), 'issue', step, 'issue');
    for (const d of t.dependsOn.filter((d) => d !== t.reviewOf)) link(`t:${d}`, 'done', step, 'after');
    if (t.reviewOf) link(`t:${t.reviewOf}`, 'done', step, 'after');
    for (const s of t.skills ?? []) link(add({ id: `s:${s}`.slice(0, 96), type: 'skill', data: { skillId: s } }), 'skill', step, 'skills');
    for (const c of t.connectors ?? []) link(add({ id: `c:${c}`.slice(0, 96), type: 'connector', data: { connectorId: c } }), 'tools', step, 'tools');
    if (t.design) link(add({ id: `d:${t.design.artifactId}:${t.design.rev}`.slice(0, 96), type: 'design', data: { artifactId: t.design.artifactId, rev: t.design.rev } }), 'design', step, 'design');
    if (t.context) link(add({ id: `x:${t.id}`, type: 'summary', data: { text: t.context } }), 'context', step, 'context');
  }
  return normalizeGraph({ nodes, edges });
}

export function sketchFromWorkflow(w: Workflow, at: string): CanvasSketch {
  return { id: w.id, name: w.definition.name, mode: w.definition.mode, workflowId: w.id, version: w.version, continues: null, graph: deriveGraph(w.definition.tasks as CompiledTask[]), updatedAt: at };
}

/** A workflow can be edited only while it is a draft; the daemon enforces the same rule. */
export const isWorkflowLocked = (w: Pick<Workflow, 'status'>): boolean => w.status !== 'draft';

// ---- attention, visibility, pickup --------------------------------------------------------------------

export interface WorkflowAttention {
  /** Open questions, approvals and decisions raised by this workflow's runs or issues. */
  input: number;
  failure: boolean;
  finished: boolean;
}

export function workflowAttention(w: Workflow, s: Pick<ControlState, 'approvals' | 'decisions' | 'runs'>): WorkflowAttention {
  const assignments = new Set(Object.values(w.tasks).map((t) => t.assignmentId).filter((a): a is string => Boolean(a)));
  const items = new Set(w.definition.tasks.map((t) => t.workItemId));
  const runs = new Set(Object.values(s.runs).filter((r) => assignments.has(r.assignmentId)).map((r) => r.id));
  const approvals = Object.values(s.approvals).filter((a) => !a.resolvedAt && runs.has(a.runId)).length;
  const decisions = Object.values(s.decisions).filter((d) => !d.answeredAt && !d.consumedAt && d.workItemId && items.has(d.workItemId)).length;
  const taskTrouble = Object.values(w.tasks).some((t) => t.status === 'failed' || t.status === 'blocked' || t.status === 'changes_requested');
  return { input: approvals + decisions, failure: w.status === 'failed' || w.status === 'blocked' || taskTrouble, finished: w.status === 'completed' || w.status === 'canceled' };
}

/** Whether a frame is drawn. Hidden workflows come back only for the reasons their owner chose. */
export function frameVisible(frame: CanvasFrame | undefined, a: WorkflowAttention): boolean {
  if (!frame?.hidden) return true;
  return (frame.showWhen.input && a.input > 0) || (frame.showWhen.failure && a.failure) || (frame.showWhen.finished && a.finished);
}

/**
 * Where an unfinished task's previous attempt stopped, from what the daemon already recorded:
 * the latest run's handoff (next step, blocker, what was done) or its exit message.
 */
export function pickupPoint(w: Workflow, taskId: string, s: Pick<ControlState, 'runs'>): string | null {
  const assignmentId = w.tasks[taskId]?.assignmentId;
  if (!assignmentId) return null;
  const run = Object.values(s.runs).filter((r) => r.assignmentId === assignmentId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!run) return null;
  const h = run.handoff;
  const parts = h ? [h.done && `Done: ${h.done}`, h.next && `Next: ${h.next}`, h.blocked && `Blocked: ${h.blocked.what}${h.blocked.on ? ` (on ${h.blocked.on})` : ''}`, h.commit && `Last commit: ${h.commit.sha.slice(0, 12)}${h.commit.branch ? ` on ${h.commit.branch}` : ''}`] : [run.exit?.message && `Stopped: ${run.exit.message}`];
  const text = parts.filter(Boolean).join('\n');
  return text ? text.slice(0, CANVAS_LIMITS.pickup) : null;
}

/**
 * The draft that continues a terminated workflow: finished tasks are left out (their evidence
 * stays on the original), unfinished ones keep their wiring and carry a pickup point.
 * `pickups` (from the engine's terminate) win over what the event log already recorded.
 */
export function continuationSketch(w: Workflow, s: Pick<ControlState, 'runs'>, id: string, at: string, pickups: Record<string, string | null> = {}): CanvasSketch {
  const done = new Set(Object.entries(w.tasks).filter(([, t]) => t.status === 'done').map(([k]) => k));
  const tasks = (w.definition.tasks as CompiledTask[]).filter((t) => !done.has(t.id)).map((t) => ({
    ...t,
    dependsOn: t.dependsOn.filter((d) => !done.has(d) && d !== t.reviewOf),
    reviewOf: t.reviewOf && !done.has(t.reviewOf) ? t.reviewOf : null,
    pickup: pickups[t.id] ?? pickupPoint(w, t.id, s),
  }));
  return { id, name: `${w.definition.name} (continued)`.slice(0, 120), mode: w.definition.mode, workflowId: null, version: null, continues: w.id, graph: deriveGraph(tasks), updatedAt: at };
}
