// SPDX-License-Identifier: Apache-2.0
// Typed connector descriptors. Saved connections start as drafts that make no outbound calls;
// every action needs its own human decision bound to the exact configuration hash.
import { z } from 'zod';

export const CONNECTOR_KINDS = ['github-issues', 'linear', 'obsidian', 'docker', 'mcp', 'github', 'gitlab', 'vercel', 'supabase'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];
export type ConnectorAction = 'import' | 'read' | 'execute';

const absolute = z.string().min(2).max(500).refine(s => s.startsWith('/') && !s.split('/').includes('..') && !s.includes('\0'), 'use an absolute path without traversal');
const relFolder = z.string().min(1).max(200).refine(s => !s.startsWith('/') && !s.includes('\\') && !s.split('/').some(p => p === '..' || p === '.' || !p), 'use a vault-relative folder without traversal');
const toolName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'tool names: letters, digits, dot, dash, underscore');
export const RELEASE_CONNECTOR_KINDS = ['github', 'gitlab', 'vercel', 'supabase'] as const;
export type ReleaseConnectorKind = (typeof RELEASE_CONNECTOR_KINDS)[number];
export const RELEASE_CAPABILITIES = ['branch-protection:read', 'pulls:read', 'checks:read', 'deployments:read', 'migrations:read'] as const;
export type ReleaseCapability = (typeof RELEASE_CAPABILITIES)[number];
const releaseFields = {
  host: z.string().min(1).max(253).regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/, 'HTTPS hostname without credentials, path or port').transform(s => s.toLowerCase()),
  scopes: z.array(z.string().regex(/^[a-zA-Z0-9_.:-]{1,80}$/)).min(1).max(16),
  capabilities: z.array(z.enum(RELEASE_CAPABILITIES)).min(1).max(5),
  /** Set by the daemon when saving, never trusted from client input. */
  binding: z.object({ projectRepo: z.string(), projectName: z.string(), productionBranch: z.string(), configuredHash: z.string() }).strict().optional(),
};

export const ConnectorConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github'), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name'), ...releaseFields }).strict(),
  z.object({ kind: z.literal('gitlab'), project: z.string().min(1).max(200).refine(s => !s.includes('..') && !s.includes('://'), 'project id or path'), ...releaseFields }).strict(),
  z.object({ kind: z.literal('vercel'), project: z.string().min(1).max(100), ...releaseFields }).strict(),
  z.object({ kind: z.literal('supabase'), project_ref: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), migrations_dir: relFolder.default('supabase/migrations'), ...releaseFields }).strict(),
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
export type ReleaseConnectorConfig = Extract<ConnectorConfig, { kind: ReleaseConnectorKind }>;
export function isReleaseConnector(config: ConnectorConfig): config is ReleaseConnectorConfig {
  return (RELEASE_CONNECTOR_KINDS as readonly string[]).includes(config.kind);
}

export const RELEASE_CONNECTOR_DEFAULTS = {
  github: { kind: 'github', host: 'api.github.com', repo: '', scopes: ['administration:read', 'pull_requests:read', 'contents:read', 'checks:read'], capabilities: ['branch-protection:read', 'pulls:read', 'checks:read'] },
  gitlab: { kind: 'gitlab', host: 'gitlab.com', project: '', scopes: ['read_api'], capabilities: ['branch-protection:read', 'pulls:read', 'checks:read'] },
  vercel: { kind: 'vercel', host: 'api.vercel.com', project: '', scopes: ['deployments:read'], capabilities: ['deployments:read'] },
  supabase: { kind: 'supabase', host: 'api.supabase.com', project_ref: '', migrations_dir: 'supabase/migrations', scopes: ['database_migrations_read'], capabilities: ['migrations:read'] },
} satisfies Record<ReleaseConnectorKind, ReleaseConnectorConfig>;

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
  capabilities: ('import' | 'tracker' | 'knowledge' | 'containers' | 'tools' | 'release' | 'hosting' | 'migrations')[];
  links?: { label: string; href: string }[];
  actions: { id: ConnectorAction; label: string; outbound: string | null; writes: boolean }[];
  credential: { type: 'secret'; name: 'linear' | ReleaseConnectorKind } | { type: 'cli-login'; tool: string } | { type: 'none' };
  cost: { kind: 'free' | 'local' | 'unknown'; note: string };
  egress: string;
}

export const CONNECTOR_DESCRIPTORS: Record<ConnectorKind, ConnectorDescriptor> = {
  github: {
    kind: 'github', title: 'GitHub release reads', summary: 'Read branch protection, open pull requests and CI for the selected repository and production branch.',
    capabilities: ['release'], actions: [{ id: 'read', label: 'Read approved release capabilities', outbound: 'the exact reviewed GitHub API host', writes: false }],
    credential: { type: 'secret', name: 'github' }, cost: { kind: 'free', note: 'Read-only API; rate limits apply. Token permissions remain unverified until a read.' }, egress: 'Reviewed HTTPS API host; manual reads only',
    links: [{ label: 'Branch protection permissions', href: 'https://docs.github.com/en/rest/branches/branch-protection' }, { label: 'Release cockpit', href: '/release' }],
  },
  gitlab: {
    kind: 'gitlab', title: 'GitLab release reads', summary: 'Read protected branches, open merge requests and pipelines for the exact selected project.',
    capabilities: ['release'], actions: [{ id: 'read', label: 'Read approved release capabilities', outbound: 'the exact reviewed GitLab host', writes: false }],
    credential: { type: 'secret', name: 'gitlab' }, cost: { kind: 'free', note: 'Read-only API; rate limits apply. Use a project-scoped read_api token.' }, egress: 'Reviewed HTTPS API host; manual reads only',
    links: [{ label: 'Protected branches API', href: 'https://docs.gitlab.com/api/protected_branches/' }, { label: 'Release cockpit', href: '/release' }],
  },
  vercel: {
    kind: 'vercel', title: 'Vercel deployment reads', summary: 'Read recent deployments for the selected Vercel project. A READY deployment is hosting evidence, not release approval.',
    capabilities: ['release', 'hosting'], actions: [{ id: 'read', label: 'Read deployments', outbound: 'api.vercel.com', writes: false }],
    credential: { type: 'secret', name: 'vercel' }, cost: { kind: 'free', note: 'Deployment listing only; never creates deployments. Reviewed scopes are a local capability ceiling, not proof of token permissions.' }, egress: 'api.vercel.com over HTTPS; manual reads only',
    links: [{ label: 'Deployment API', href: 'https://vercel.com/docs/rest-api/deployments/list-deployments' }, { label: 'Release cockpit', href: '/release' }],
  },
  supabase: {
    kind: 'supabase', title: 'Supabase migration reads', summary: 'Compare repository migrations with history read from the exact Supabase project. Missing history stays unknown.',
    capabilities: ['release', 'migrations'], actions: [{ id: 'read', label: 'Read migration history', outbound: 'api.supabase.com', writes: false }],
    credential: { type: 'secret', name: 'supabase' }, cost: { kind: 'free', note: 'Read-only migration history; never applies SQL or repairs migrations.' }, egress: 'api.supabase.com over HTTPS; manual reads only',
    links: [{ label: 'Management API', href: 'https://supabase.com/docs/reference/api/introduction' }, { label: 'Release cockpit', href: '/release' }],
  },
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
    kind: 'obsidian', title: 'Obsidian knowledge', summary: 'Read only the selected vault folders for Dictionary and agent search.',
    capabilities: ['knowledge'], actions: [{ id: 'read', label: 'Index selected folders; write project notes only to the One Connect folder', outbound: null, writes: true }],
    credential: { type: 'none' }, cost: { kind: 'local', note: 'Local files; no network.' }, egress: 'none',
  },
  docker: {
    kind: 'docker', title: 'Local Docker', summary: 'List and read logs of this project’s Compose containers. Start/stop/restart still need a per-action decision.',
    capabilities: ['containers'], actions: [{ id: 'read', label: 'List containers and read logs', outbound: null, writes: false }],
    credential: { type: 'none' }, cost: { kind: 'local', note: 'Local Docker engine.' }, egress: 'none (local Docker socket)',
  },
  mcp: {
    kind: 'mcp', title: 'MCP / plugin tools', summary: 'A local stdio MCP server. Off until a human approves the exact command, tools and read roots; each call still needs its own Decision.',
    capabilities: ['tools'], actions: [{ id: 'execute', label: 'Approve command, tool inventory and read roots (each call still asks separately)', outbound: 'whatever the approved program does', writes: true }],
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
