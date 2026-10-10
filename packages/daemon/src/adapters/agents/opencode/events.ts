// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Pure mapping from OpenCode server-sent events to the bridge's line format. No I/O: the bridge
// feeds it events and acts on what it returns (permission / question requests, completion).
import type { BridgeLine } from './protocol.ts';

export interface OcEvent { id?: string; type: string; properties?: Record<string, unknown> }

export interface PermissionRequest { id: string; sessionID: string; raw: Record<string, unknown> }
export interface QuestionRequest { id: string; sessionID: string; questions: { question: string; header?: string; multiple?: boolean; options: string[] }[] }
export interface Finished { ok: boolean; error?: string; aborted?: boolean }

export interface Mapped {
  lines: BridgeLine[];
  permission?: PermissionRequest;
  question?: QuestionRequest;
  finished?: Finished;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : v === undefined || v === null ? d : String(v));
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s);

/** Keep tool input small and JSON-safe; commands and paths survive, bulky bodies are summarised. */
function smallInput(tool: string, input: unknown): unknown {
  const i = obj(input);
  if (tool === 'bash') return { command: str(i.command), description: str(i.description) || undefined };
  if (['edit', 'write', 'patch', 'multiedit'].includes(tool)) return { filePath: str(i.filePath ?? i.file_path ?? i.path) };
  try {
    const s = JSON.stringify(input ?? {});
    return s.length > 1500 ? { summary: clip(s, 1500) } : input;
  } catch {
    return {};
  }
}

/**
 * Incremental server-sent-events parser: tolerates frames split across arbitrary chunk boundaries,
 * CRLF line endings and multi-line `data:` fields; comments and unknown fields are ignored.
 */
export class SseParser {
  private buf = '';
  push(chunk: string): string[] {
    this.buf = (this.buf + chunk).replace(/\r\n/g, '\n'); // after joining, so a CRLF split across chunks still folds
    const out: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (data) out.push(data);
    }
    if (this.buf.length > 4 * 1024 * 1024) throw new Error('SSE frame exceeds 4 MiB'); // a frame this large is not a protocol frame
    return out;
  }
}

export class EventMapper {
  rootId: string | null = null;
  abortRequested = false;
  /** The provider/model the run asked for; a different served model is reported, never silently accepted. */
  expected: { providerID: string; modelID: string } | null = null;
  private mismatchReported = false;
  private sessions = new Map<string, { parentId: string | null; title: string; state: 'running' | 'done' }>();
  private roles = new Map<string, string>();
  private held = new Map<string, Obj[]>();
  private finalized = new Set<string>();
  /** Text/reasoning parts seen without an end time; flushed as complete messages when the turn ends. */
  private open = new Map<string, { type: string; text: string }>();
  private toolStatus = new Map<string, string>();
  private usageSeen = new Set<string>();
  private seenAsks = new Set<string>();
  private sawBusy = false;
  private rootError: { name: string; message: string } | null = null;
  private done = false;
  private eventIds = new Set<string>();
  private parts = new Map<string, Obj>();

  setRoot(id: string): void {
    this.rootId = id;
    this.sessions.set(id, { parentId: null, title: 'root', state: 'running' });
  }

  private known(id: unknown): boolean {
    return typeof id === 'string' && this.sessions.has(id);
  }

  handle(ev: OcEvent): Mapped {
    const out: Mapped = { lines: [] };
    if (this.done) return out;
    if (ev.id) {
      if (this.eventIds.has(ev.id)) return out;
      this.eventIds.add(ev.id);
    }
    const p = obj(ev.properties);
    switch (ev.type) {
      case 'session.created': {
        const info = obj(p.info);
        const id = str(info.id), parent = info.parentID === undefined || info.parentID === null ? null : str(info.parentID);
        if (id && parent && this.known(parent) && !this.sessions.has(id)) {
          this.sessions.set(id, { parentId: parent, title: str(info.title, 'child session'), state: 'running' });
          out.lines.push({ t: 'child', sessionId: id, parentSessionId: parent, title: str(info.title, 'child session'), state: 'running' });
        }
        break;
      }
      case 'session.updated': {
        const info = obj(p.info);
        const s = this.sessions.get(str(info.id));
        if (s && s.parentId && info.title && str(info.title) !== s.title) {
          s.title = str(info.title);
          out.lines.push({ t: 'child', sessionId: str(info.id), parentSessionId: s.parentId, title: s.title, state: s.state === 'done' ? 'completed' : 'running' });
        }
        break;
      }
      case 'session.status': {
        const sid = str(p.sessionID), status = obj(p.status);
        if (sid === this.rootId) {
          if (status.type === 'busy') this.sawBusy = true;
          if (status.type === 'idle' && this.sawBusy) this.finish(out, this.rootError ? { ok: false, error: this.rootError.message } : { ok: true });
          if (status.type === 'retry') out.lines.push({ t: 'retry', message: str(status.message, 'retrying'), attempt: num(status.attempt) });
        }
        break;
      }
      case 'session.idle': {
        const sid = str(p.sessionID);
        if (sid === this.rootId) {
          if (this.abortRequested) this.finish(out, { ok: false, error: 'aborted', aborted: true });
          else if (this.sawBusy) this.finish(out, this.rootError ? { ok: false, error: this.rootError.message } : { ok: true });
        } else if (this.known(sid)) this.endChild(out, sid, 'completed');
        break;
      }
      case 'session.error': {
        const sid = p.sessionID === undefined ? this.rootId : str(p.sessionID);
        const err = obj(p.error), data = obj(err.data);
        const name = str(err.name, 'Error'), message = str(data.message ?? err.message, name);
        if (sid === this.rootId) {
          if (this.abortRequested || name === 'MessageAbortedError') this.finish(out, { ok: false, error: 'aborted', aborted: true });
          else {
            out.lines.push({ t: 'error', name, message, status: typeof data.statusCode === 'number' ? data.statusCode : null });
            this.finish(out, { ok: false, error: message });
          }
        } else if (sid && this.known(sid)) this.endChild(out, sid, name === 'MessageAbortedError' ? 'aborted' : 'failed', message);
        break;
      }
      case 'message.updated': {
        const info = obj(p.info);
        const id = str(info.id);
        if (!this.known(info.sessionID)) break;
        if (id) {
          this.roles.set(id, str(info.role));
          const held = this.held.get(id);
          if (held) {
            this.held.delete(id);
            for (const part of held) this.part(out, part, str(info.role));
          }
        }
        const err = obj(info.error);
        if (info.role === 'assistant' && err.name && str(info.sessionID) === this.rootId && !this.rootError && err.name !== 'MessageAbortedError') {
          const data = obj(err.data);
          this.rootError = { name: str(err.name), message: str(data.message, str(err.name)) };
          out.lines.push({ t: 'error', name: this.rootError.name, message: this.rootError.message, status: typeof data.statusCode === 'number' ? data.statusCode : null });
        }
        if (info.role === 'assistant' && str(info.sessionID) === this.rootId) this.sawBusy = true;
        if (info.role === 'assistant' && this.expected && str(info.sessionID) === this.rootId && !this.mismatchReported && (info.modelID || info.providerID)) {
          const served = { providerID: str(info.providerID, this.expected.providerID), modelID: str(info.modelID, this.expected.modelID) };
          if (served.providerID !== this.expected.providerID || served.modelID !== this.expected.modelID) {
            this.mismatchReported = true;
            out.lines.push({ t: 'model_mismatch', requested: `${this.expected.providerID}/${this.expected.modelID}`, served: `${served.providerID}/${served.modelID}` });
            this.finish(out, { ok: false, error: 'OpenCode served a different model from the one selected' });
          }
        }
        break;
      }
      case 'message.part.updated': {
        const part = obj(p.part);
        const partId = str(part.id);
        if (partId && this.known(part.sessionID)) this.parts.set(partId, part);
        if (!this.known(part.sessionID)) break;
        const role = this.roles.get(str(part.messageID));
        if (!role) {
          const list = this.held.get(str(part.messageID)) ?? [];
          if (list.length < 200) list.push(part);
          this.held.set(str(part.messageID), list);
        } else this.part(out, part, role);
        break;
      }
      case 'message.part.delta': {
        if (!this.known(p.sessionID) || p.field !== 'text' || typeof p.delta !== 'string') break;
        const part = this.parts.get(str(p.partID));
        if (!part || str(part.messageID) !== str(p.messageID) || str(part.sessionID) !== str(p.sessionID) || !['text', 'reasoning'].includes(str(part.type))) {
          this.finish(out, { ok: false, error: 'OpenCode sent a text delta for an unknown part; cannot reconstruct the stream' });
          break;
        }
        if (this.finalized.has(str(part.id))) break;
        part.text = str(part.text) + p.delta;
        const role = this.roles.get(str(p.messageID));
        if (role) this.part(out, part, role);
        break;
      }
      case 'permission.asked': {
        const id = str(p.id);
        if (id && this.known(p.sessionID) && !this.seenAsks.has(`p:${id}`)) {
          this.seenAsks.add(`p:${id}`);
          out.permission = { id, sessionID: str(p.sessionID), raw: p };
        }
        break;
      }
      case 'question.asked': {
        const id = str(p.id);
        if (id && this.known(p.sessionID) && !this.seenAsks.has(`q:${id}`)) {
          this.seenAsks.add(`q:${id}`);
          const questions = (Array.isArray(p.questions) ? p.questions : []).map((q) => {
            const o = obj(q);
            return { question: str(o.question), ...(o.multiple === true ? { multiple: true } : {}), header: o.header ? str(o.header) : undefined, options: (Array.isArray(o.options) ? o.options : []).map((x) => str(obj(x).label ?? x)).filter(Boolean) };
          });
          if (questions.length) out.question = { id, sessionID: str(p.sessionID), questions };
        }
        break;
      }
      default:
        break;
    }
    return out;
  }

  private finish(out: Mapped, f: Finished): void {
    if (this.done) return;
    this.done = true;
    for (const [id, v] of this.open) {
      this.finalized.add(id);
      out.lines.push(v.type === 'text' ? { t: 'message', role: 'assistant', partId: id, text: v.text } : { t: 'reasoning', partId: id, text: v.text });
    }
    this.open.clear();
    out.finished = f;
  }

  private endChild(out: Mapped, id: string, state: 'completed' | 'failed' | 'aborted', error?: string): void {
    const s = this.sessions.get(id);
    if (!s || s.state === 'done') return;
    s.state = 'done';
    out.lines.push({ t: 'child', sessionId: id, parentSessionId: s.parentId, title: s.title, state, ...(error ? { error } : {}) });
  }

  private part(out: Mapped, part: Obj, role: string): void {
    if (role === 'user') return;
    const id = str(part.id), type = str(part.type);
    // A child session's own prose stays inside that child; its tool calls and token usage are real
    // actions in this worktree and are still recorded.
    if (str(part.sessionID) !== this.rootId && type !== 'tool' && type !== 'step-finish') return;
    if (str(part.sessionID) === this.rootId) this.sawBusy = true;
    const time = obj(part.time);
    if (type === 'text' || type === 'reasoning') {
      const text = str(part.text);
      if (this.finalized.has(id) || !text) return;
      if (time.end) {
        this.finalized.add(id);
        this.open.delete(id);
        out.lines.push(type === 'text' ? { t: 'message', role: 'assistant', partId: id, text } : { t: 'reasoning', partId: id, text });
      } else {
        this.open.set(id, { type, text });
        out.lines.push({ t: 'delta', role: type === 'text' ? 'assistant' : 'reasoning', partId: id, text });
      }
    } else if (type === 'tool') {
      const callId = str(part.callID ?? id), tool = str(part.tool, 'tool'), state = obj(part.state), status = str(state.status);
      const prev = this.toolStatus.get(callId);
      if (status === 'running' && !prev) {
        this.toolStatus.set(callId, 'running');
        out.lines.push({ t: 'tool', callId, tool, status: 'running', input: smallInput(tool, state.input), title: state.title ? str(state.title) : undefined });
      } else if ((status === 'completed' || status === 'error') && prev !== 'completed' && prev !== 'error') {
        this.toolStatus.set(callId, status);
        const meta = obj(state.metadata);
        const exit = typeof meta.exit === 'number' ? meta.exit : typeof meta.exitCode === 'number' ? meta.exitCode : null;
        out.lines.push({ t: 'tool', callId, tool, status, input: smallInput(tool, state.input), output: clip(str(status === 'error' ? state.error ?? state.output : state.output), 64_000), title: state.title ? str(state.title) : undefined, exit });
      }
    } else if (type === 'step-finish') {
      if (this.usageSeen.has(id)) return;
      this.usageSeen.add(id);
      const tokens = obj(part.tokens);
      const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
      if (!count(tokens.input) || !count(tokens.output) || !count(tokens.reasoning)) return;
      out.lines.push({ t: 'usage', partId: id, input: tokens.input, output: tokens.output + tokens.reasoning, ...(typeof part.cost === 'number' && Number.isFinite(part.cost) && part.cost > 0 ? { costUsd: part.cost } : {}) });
    }
  }
}
