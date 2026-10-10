// SPDX-License-Identifier: Apache-2.0
// Reducer cases for project skills, connectors and design mock artifacts.
import type { ControlState } from './entities.ts';
import type { EventEnvelope } from './events.ts';
import type { MockRevision } from './mocks.ts';

export const LIBRARY_EVENT_TYPES = new Set<string>([
  'skill.draft_saved', 'skill.version_published', 'skill.disabled', 'skill.exported',
  'connector.saved', 'connector.disabled', 'connector.activation_requested', 'connector.activated', 'connector.activation_denied', 'connector.checked', 'connector.used',
  'connector.tool_requested', 'connector.tool_denied', 'connector.tool_execution_started', 'connector.tool_executed',
  'design.mock_captured', 'design.mock_exception', 'design.mock_reviewed', 'design.mock_evidence',
]);

export function applyLibraryEvent(state: ControlState, e: EventEnvelope): ControlState {
  const s = { ...state };
  const skills = { ...(s.skills ?? {}) };
  const connectors = { ...(s.connectors ?? {}) };
  const mocks = { ...(s.mocks ?? {}) };
  const ts = e.ts;
  const patchRev = (artifactId: string, rev: number, fn: (r: MockRevision) => MockRevision) => {
    const a = mocks[artifactId];
    if (!a) return;
    mocks[artifactId] = { ...a, updatedAt: ts, revisions: a.revisions.map(r => (r.rev === rev ? fn(r) : r)) };
  };
  switch (e.type) {
    case 'skill.draft_saved': {
      const cur = skills[e.data.id];
      const draft = { hash: e.data.hash, name: e.data.name, description: e.data.description, updatedAt: ts };
      skills[e.data.id] = cur
        ? { ...cur, draft, updatedAt: ts }
        : { id: e.data.id, name: e.data.name, description: e.data.description, latest: null, versions: [], draft, disabled: false, createdAt: ts, updatedAt: ts };
      break;
    }
    case 'skill.version_published': {
      const v = e.data.version;
      const cur = skills[v.id];
      const base = cur ?? { id: v.id, name: v.name, description: v.description, latest: null, versions: [], draft: null, disabled: false, createdAt: ts, updatedAt: ts };
      skills[v.id] = { ...base, name: v.name, description: v.description, latest: v.version, versions: [...base.versions.filter(x => x.version !== v.version), v], draft: null, updatedAt: ts };
      break;
    }
    case 'skill.disabled': {
      const cur = skills[e.data.id];
      if (cur) skills[e.data.id] = { ...cur, disabled: e.data.disabled, updatedAt: ts };
      break;
    }
    case 'skill.exported':
      break;
    case 'connector.saved': {
      const c = e.data.connector;
      const cur = connectors[c.id];
      const sameConfig = cur?.configHash === c.configHash;
      connectors[c.id] = {
        ...c,
        approvals: sameConfig ? cur.approvals : {},
        pending: sameConfig ? cur.pending : {},
        availability: sameConfig && cur ? cur.availability : { status: 'not_checked', checkedAt: null, detail: 'Not checked yet. Drafts make no outbound calls.' },
      };
      break;
    }
    case 'connector.disabled': {
      const cur = connectors[e.data.connectorId];
      if (cur) connectors[cur.id] = { ...cur, disabled: e.data.disabled, approvals: e.data.disabled ? {} : cur.approvals, pending: e.data.disabled ? {} : cur.pending, updatedAt: ts };
      break;
    }
    case 'connector.activation_requested': {
      const cur = connectors[e.data.connectorId];
      if (cur) connectors[cur.id] = { ...cur, pending: { ...cur.pending, [e.data.action]: { decisionId: e.data.decisionId, configHash: e.data.configHash } }, updatedAt: ts };
      break;
    }
    case 'connector.activated': {
      const cur = connectors[e.data.connectorId];
      if (!cur) break;
      const { [e.data.action]: _done, ...pending } = cur.pending;
      connectors[cur.id] = { ...cur, pending, approvals: { ...cur.approvals, [e.data.action]: { action: e.data.action, decisionId: e.data.decisionId, configHash: e.data.configHash, approvedAt: ts } }, updatedAt: ts };
      break;
    }
    case 'connector.activation_denied': {
      const cur = connectors[e.data.connectorId];
      if (!cur) break;
      const { [e.data.action]: _done, ...pending } = cur.pending;
      connectors[cur.id] = { ...cur, pending, updatedAt: ts };
      break;
    }
    case 'connector.checked': {
      const cur = connectors[e.data.connectorId];
      if (cur) connectors[cur.id] = { ...cur, availability: e.data.availability };
      break;
    }
    case 'connector.used':
      break;
    case 'design.mock_captured': {
      const cur = mocks[e.data.artifact.id];
      mocks[e.data.artifact.id] = { ...e.data.artifact, createdAt: cur?.createdAt ?? e.data.artifact.createdAt, updatedAt: ts, revisions: [...(cur?.revisions ?? []), e.data.revision] };
      break;
    }
    case 'design.mock_exception':
      patchRev(e.data.artifactId, e.data.rev, r => ({ ...r, exceptions: [...r.exceptions, e.data.exception] }));
      break;
    case 'design.mock_reviewed':
      patchRev(e.data.artifactId, e.data.rev, r => ({ ...r, reviews: [...r.reviews, e.data.review] }));
      break;
    case 'design.mock_evidence':
      patchRev(e.data.artifactId, e.data.rev, r => ({ ...r, evidence: [...r.evidence, e.data.evidence] }));
      break;
    default:
      return state;
  }
  s.skills = skills;
  s.connectors = connectors;
  s.mocks = mocks;
  return s;
}
