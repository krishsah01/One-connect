// SPDX-License-Identifier: Apache-2.0
// Typed connector descriptors. Saved connections start as drafts that make no outbound calls;
// every action needs its own human decision bound to the exact configuration hash.
import { z } from 'zod';

export const CONNECTOR_KINDS = ['github-issues', 'linear', 'obsidian', 'docker', 'mcp'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];
export type ConnectorAction = 'import' | 'read' | 'execute';

const absolute = z.string().min(2).max(500).refine(s => s.startsWith('/') && !s.split('/').includes('..') && !s.includes('\0'), 'use an absolute path without traversal');
const relFolder = z.string().min(1).max(200).refine(s => !s.startsWith('/') && !s.includes('\\') && !s.split('/').some(p => p === '..' || p === '.' || !p), 'use a vault-relative folder without traversal');
const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'tool names: letters, digits, dot, dash, underscore');

export const ConnectorConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github-issues'), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name'), labels: z.array(z.string().max(60)).max(10).default([]) }),
  z.object({ kind: z.literal('linear'), team: z.string().min(1).max(60), project: z.string().max(120).optional() }),
  z.object({ kind: z.literal('obsidian'), vault: absolute, folders: z.array(relFolder).min(1).max(16) }),
  z.object({ kind: z.literal('docker') }),
  z.object({
    kind: z.literal('mcp'),
    command: absolute,
    args: z.array(z.string().max(500).refine(s => !s.includes('\0'))).max(32).default([]),
    tools: z.array(toolName).min(1).max(32),
    read_roots: z.array(absolute).max(8).default([]),
  }),
]);
export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;

export const ConnectorDraftSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/, 'connection id: lowercase letters, digits and dashes'),
  name: z.string().trim().min(1).max(100),
  config: ConnectorConfigSchema,
});
export type ConnectorDraft = z.infer<typeof ConnectorDraftSchema>;

export interface ConnectorDescriptor {
  kind: ConnectorKind;
  title: string;
  summary: string;
  capabilities: ('import' | 'tracker' | 'knowledge' | 'containers' | 'tools')[];
  actions: { id: ConnectorAction; label: string; outbound: string | null; writes: boolean }[];
  credential: { type: 'secret'; name: 'linear' } | { type: 'cli-login'; tool: string } | { type: 'none' };
  cost: { kind: 'free' | 'local' | 'unknown'; note: string };
  egress: string;
}

export const CONNECTOR_DESCRIPTORS: Record<ConnectorKind, ConnectorDescriptor> = {
  'github-issues': {
    kind: 'github-issues', title: 'GitHub Issues', summary: 'Preview open issues and accept selected ones onto the local board with provenance.',
    capabilities: ['import', 'tracker'], actions: [{ id: 'import', label: 'Read issues for import', outbound: 'GitHub API through your installed gh login', writes: false }],
    credential: { type: 'cli-login', tool: 'gh' }, cost: { kind: 'free', note: 'GitHub API rate limits apply; no metered spend.' }, egress: 'gh CLI → api.github.com',
  },
  linear: {
    kind: 'linear', title: 'Linear', summary: 'Preview team issues and accept selected ones with acceptance criteria and provenance.',
    capabilities: ['import', 'tracker'], actions: [{ id: 'import', label: 'Read issues for import', outbound: 'api.linear.app', writes: false }],
    credential: { type: 'secret', name: 'linear' }, cost: { kind: 'free', note: 'Linear API; no metered spend.' }, egress: 'api.linear.app through the egress guard',
  },
  obsidian: {
    kind: 'obsidian', title: 'Obsidian knowledge', summary: 'Read only the selected vault folders for One Answer and agent search.',
    capabilities: ['knowledge'], actions: [{ id: 'read', label: 'Index selected folders; write project notes only to the One Connect folder', outbound: null, writes: true }],
    credential: { type: 'none' }, cost: { kind: 'local', note: 'Local files; no network.' }, egress: 'none',
  },
  docker: {
    kind: 'docker', title: 'Local Docker', summary: 'List and read logs of this project’s Compose containers. Start/stop/restart still need a per-action decision.',
    capabilities: ['containers'], actions: [{ id: 'read', label: 'List containers and read logs', outbound: null, writes: false }],
    credential: { type: 'none' }, cost: { kind: 'local', note: 'Local Docker engine.' }, egress: 'none (local Docker socket)',
  },
  mcp: {
    kind: 'mcp', title: 'MCP / plugin tools', summary: 'A local stdio MCP server. Off until a human approves the exact command, tools and read roots.',
    capabilities: ['tools'], actions: [{ id: 'execute', label: 'Start the exact command and call approved tools', outbound: 'whatever the approved program does', writes: true }],
    credential: { type: 'none' }, cost: { kind: 'unknown', note: 'Unknown: the program decides. Review it before approving.' }, egress: 'unknown: not mediated by One Connect',
  },
};

export type ConnectorAvailability = { status: 'not_checked' | 'available' | 'missing_credential' | 'offline' | 'error'; checkedAt: string | null; detail: string };
export interface ConnectorApproval { action: ConnectorAction; decisionId: string; configHash: string; approvedAt: string }
export interface Connector {
  id: string;
  name: string;
  kind: ConnectorKind;
  config: ConnectorConfig;
  configHash: string;
  disabled: boolean;
  approvals: Partial<Record<ConnectorAction, ConnectorApproval>>;
  pending: Partial<Record<ConnectorAction, { decisionId: string; configHash: string }>>;
  availability: ConnectorAvailability;
  createdAt: string;
  updatedAt: string;
}

/** Active only when not disabled and the action's approval matches the current configuration. */
export function connectorAllows(c: Connector | undefined, action: ConnectorAction): boolean {
  const ap = c?.approvals[action];
  return Boolean(c && !c.disabled && ap && ap.configHash === c.configHash);
}

export function connectorState(c: Connector): 'draft' | 'pending' | 'active' | 'disabled' {
  if (c.disabled) return 'disabled';
  if (CONNECTOR_DESCRIPTORS[c.kind].actions.some(a => connectorAllows(c, a.id))) return 'active';
  return Object.values(c.pending).some(p => p?.configHash === c.configHash) ? 'pending' : 'draft';
}
