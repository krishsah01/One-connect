// SPDX-License-Identifier: Apache-2.0
// Schema for control-center.yaml. Everything project-specific is configuration.
import { z } from 'zod';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const EffortSchema = z.enum(EFFORTS);
export type Effort = z.infer<typeof EffortSchema>;

export const ROLES = ['lead', 'engineer', 'reviewer', 'qa', 'researcher'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

export const ADAPTER_TYPES = ['claude-headless', 'codex-cli', 'cursor-agent-cli', 'generic-cli', 'relay', 'opencode-server'] as const;
export const AdapterTypeSchema = z.enum(ADAPTER_TYPES);
export type AdapterType = z.infer<typeof AdapterTypeSchema>;

/**
 * How an agent's harness reaches a model. `subscription` = the vendor CLI's own login (default).
 * API-key providers bill per token and need metered_opt_in; local providers run on this machine.
 */
export const PROVIDERS = ['subscription', 'anthropic-api', 'openai-api', 'openrouter', 'ollama', 'ollama-cloud', 'lmstudio'] as const;
export const ProviderSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof ProviderSchema>;
export const PAID_PROVIDERS: readonly Provider[] = ['anthropic-api', 'openai-api', 'openrouter'];
export const LOCAL_PROVIDERS: readonly Provider[] = ['ollama', 'lmstudio'];
/**
 * Which harness each provider can run through. The FIRST entry is the default: OpenCode (MIT,
 * headless server) is the default harness for API-key and local-model providers; the official
 * Claude/Codex CLIs remain available as alternatives (e.g. `codex --oss`).
 * `ollama-cloud` = Ollama's paid subscription cloud models (signed-in local daemon or API key).
 */
export const PROVIDER_HARNESS: Record<Provider, readonly string[]> = {
  subscription: ['claude-headless', 'codex-cli', 'cursor-agent-cli', 'generic-cli', 'relay'],
  'anthropic-api': ['opencode-server', 'claude-headless'],
  'openai-api': ['opencode-server', 'codex-cli'],
  openrouter: ['opencode-server', 'codex-cli'],
  ollama: ['opencode-server', 'codex-cli'],
  'ollama-cloud': ['opencode-server'],
  lmstudio: ['opencode-server', 'codex-cli'],
};
export const defaultHarnessFor = (provider: Provider): AdapterType => PROVIDER_HARNESS[provider][0] as AdapterType;
/** Models Ollama serves from its own cloud (paid plan) rather than from this machine. */
export const isOllamaCloudModel = (name: string): boolean => /[-:]cloud$/.test(name);
/** Providers billed through a plan the user pays for elsewhere (usage may be unknown). */
export const SUBSCRIPTION_PROVIDERS: readonly Provider[] = ['ollama-cloud'];

export const AgentConfigSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'agent id: lowercase letters, digits, dashes'),
    name: z.string().min(1),
    /** Saved drafts do not probe or dispatch until the owner enables them. */
    enabled: z.boolean().default(true),
    instructions: z.string().max(4000).default(''),
    skills:z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(24).default([]),
    /** Same user's subscription connection, never credentials or a pool across users. */
    subscription_group: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
    subscription: z.string().optional(),
    vendor: z.string().optional(),
    surface: z.enum(['cli', 'desktop-app', 'web-app', 'ide']).default('cli'),
    role: RoleSchema,
    adapter: AdapterTypeSchema,
    /** Where the model comes from (see PROVIDERS). */
    provider: ProviderSchema.default('subscription'),
    /** What the user says they pay for. Derived from `provider` when omitted. */
    billing: z.enum(['subscription', 'metered', 'local']).optional(),
    /** Daily stop threshold on recorded usage; in-flight charges can exceed it. Use provider limits for a hard cap. */
    budget_usd_per_day: z.number().positive().optional(),
    /** Price per million tokens, for estimating spend when the provider doesn't report cost. */
    pricing: z.object({ input_per_mtok: z.number().nonnegative(), output_per_mtok: z.number().nonnegative() }).optional(),
    /** Provider endpoint override (OpenRouter, Ollama, LM Studio). */
    base_url: z.string().optional(),
    /** ollama-cloud only: `daemon` = signed-in local Ollama (…:cloud models); `api` = Ollama's cloud API with a Keychain key. */
    ollama_route: z.enum(['daemon', 'api']).optional(),
    /** Codex provider wire protocol for OpenRouter (verify with a live run). */
    wire_api: z.enum(['responses', 'chat']).default('responses'),
    /** Explicit, per-agent opt-in to metered/API-key billing. Shows a cost banner everywhere. */
    metered_opt_in: z.boolean().default(false),
    /** Paid overage / on-demand usage. Must stay false unless metered_opt_in is true. */
    on_demand: z.boolean().default(false),
    mode: z.enum(['normal', 'coordinator-only']).default('normal'),
    /** `newest` picks the newest allowed model in `model_family`; anything else is a literal model id. */
    model: z.string().default('newest'),
    model_family: z.string().optional(),
    allowed_models: z.array(z.string()).optional(),
    effort: EffortSchema.optional(),
    concurrency: z.number().int().min(1).max(8).default(1),
    /** Absolute path to pin a specific vendor binary (apps can ship a newer CLI than PATH). */
    binary: z.string().optional(),
    /** generic-cli only: command and argument template ({prompt} {model} {cwd} {effort}). */
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    stdin: z.enum(['prompt', 'none']).default('prompt'),
    /** Whether the agent may run shell commands without per-command approval. */
    allow_shell: z.boolean().default(true),
    /** Shell command prefixes auto-approved for agents that route approvals to us (Claude). */
    auto_approve_commands: z.array(z.string()).default([]),
  })
  .transform((a) => ({ ...a, billing: a.billing ?? (PAID_PROVIDERS.includes(a.provider) ? 'metered' : LOCAL_PROVIDERS.includes(a.provider) ? 'local' : 'subscription') }) as typeof a & { billing: 'subscription' | 'metered' | 'local' })
  .superRefine((a, ctx) => {
    if (!PROVIDER_HARNESS[a.provider].includes(a.adapter)) {
      ctx.addIssue({ code: 'custom', message: `${a.id}: provider ${a.provider} runs through ${PROVIDER_HARNESS[a.provider].join(' or ')}, not ${a.adapter}`, path: ['provider'] });
    }
    if (PAID_PROVIDERS.includes(a.provider) && !a.metered_opt_in) {
      ctx.addIssue({ code: 'custom', message: `${a.id}: ${a.provider} bills per token. Set metered_opt_in: true (and ideally budget_usd_per_day) to use it`, path: ['metered_opt_in'] });
    }
    if (a.on_demand && !a.metered_opt_in) {
      ctx.addIssue({ code: 'custom', message: `${a.id}: on_demand requires metered_opt_in: true (zero extra spend by default)`, path: ['on_demand'] });
    }
    if (a.billing === 'metered' && !a.metered_opt_in) {
      ctx.addIssue({ code: 'custom', message: `${a.id}: billing: metered requires metered_opt_in: true`, path: ['billing'] });
    }
    if (a.provider === 'ollama' && [a.model, ...(a.allowed_models ?? [])].some((m) => isOllamaCloudModel(m))) {
      ctx.addIssue({ code: 'custom', message: `${a.id}: models ending in -cloud / :cloud run on Ollama's servers under your Ollama plan: use provider ollama-cloud, not ollama`, path: ['model'] });
    }
    if (a.provider === 'ollama-cloud' && a.billing === 'local') {
      ctx.addIssue({ code: 'custom', message: `${a.id}: Ollama cloud models are billed through your Ollama plan, not local`, path: ['billing'] });
    }
    // Local servers are explicit loopback endpoints; the only remote Ollama endpoint is the cloud API route.
    if (a.base_url && ['ollama', 'lmstudio'].includes(a.provider) || a.base_url && a.provider === 'ollama-cloud' && (a.ollama_route ?? 'daemon') !== 'api') {
      let ok = false;
      try {
        const u = new URL(a.base_url!);
        ok = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !u.username && !u.password;
      } catch { /* invalid */ }
      if (!ok) ctx.addIssue({ code: 'custom', message: `${a.id}: local model servers must be an http loopback endpoint (127.0.0.1, localhost or [::1]) with no credentials`, path: ['base_url'] });
    }
    if (a.provider === 'ollama-cloud' && a.ollama_route === 'api' && a.base_url) {
      let ok = false;
      try { const u = new URL(a.base_url); ok = u.protocol === 'https:' && u.hostname === 'ollama.com' && !u.username; } catch { /* invalid */ }
      if (!ok) ctx.addIssue({ code: 'custom', message: `${a.id}: the Ollama cloud API route only accepts https://ollama.com`, path: ['base_url'] });
    }
    if (a.ollama_route && a.provider !== 'ollama-cloud') {
      ctx.addIssue({ code: 'custom', message: `${a.id}: ollama_route only applies to provider ollama-cloud`, path: ['ollama_route'] });
    }
    if (a.adapter === 'generic-cli' && !a.command) {
      ctx.addIssue({ code: 'custom', message: `${a.id}: generic-cli needs a command`, path: ['command'] });
    }
  });
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/** Project commands never inherit vendor harness credentials or Docker context settings. */
export const CheckRuntimeSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('docker'),
    image: z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/),
    endpoint: z.string().regex(/^unix:\/\/\/[^\s,\x00]+$/, 'use an explicit local Unix Docker socket'),
    binary: z.string().startsWith('/').optional(),
    cpus: z.number().min(0.1).max(8).default(1),
    memory_mb: z.number().int().min(64).max(8192).default(512),
    pids: z.number().int().min(16).max(512).default(128),
    workspace_mb: z.number().int().min(64).max(4096).default(1024),
    timeout_seconds: z.number().int().min(1).max(3600).default(900),
  }).strict(),
  z.object({
    mode: z.literal('host-fixture'),
    /** Exact disposable repo, also requiring the opt-in marker in its Git common directory. */
    fixture_repo: z.string().startsWith('/'),
  }).strict(),
]);
export type CheckRuntime = z.infer<typeof CheckRuntimeSchema>;
/** Stable key for binding recorded check proof to the explicit runtime configuration. */
export function checkRuntimeKey(runtime: CheckRuntime | undefined): string | undefined {
  return runtime ? JSON.stringify(CheckRuntimeSchema.parse(runtime)) : undefined;
}

export const ProjectConfigSchema = z.object({
  name: z.string().min(1),
  repo: z.string().min(1),
  docker_project: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).optional(),
  integration_branch: z.string().default('integration'),
  protected_branches: z.array(z.string()).default(['main']),
  production_branch: z.string().optional(),
  checks: z.record(z.string(), z.string()).default({}),
  /** Missing runtime produces unavailable evidence; it never enables host execution. */
  check_runtime: CheckRuntimeSchema.optional(),
  /** Which checks the daemon runs itself after every run. Defaults to all `checks`. */
  required_checks: z.array(z.string()).optional(),
  /** Label → quality-floor category, e.g. { schema_security: [schema, security, migration] }. */
  categories: z.record(z.string(), z.array(z.string())).default({}),
  release_gates: z.array(z.string()).default([]),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

const poll = z.number().int().min(10).default(60);
export const TrackerConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('local'), key_prefix: z.string().default('LOC') }),
  z.object({
    type: z.literal('github'),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name'),
    /** Outbound integration stays off until the owner sets live: true. */
    live: z.boolean().default(false),
    poll_seconds: poll,
    label_prefix: z.string().default('acc:'),
    gh_binary: z.string().optional(),
  }),
  z.object({
    type: z.literal('linear'),
    team: z.string().min(1),
    project: z.string().optional(),
    live: z.boolean().default(false),
    poll_seconds: poll,
    /** Optional exact workflow-state names per category, e.g. { in_review: "In Review" }. */
    state_names: z.record(z.string(), z.string()).default({}),
    api_url: z.string().default('https://api.linear.app/graphql'),
  }),
]);
export type TrackerConfig = z.infer<typeof TrackerConfigSchema>;

export const RULE_NAMES = ['auto_refill', 'stall_detection', 'failure_retry', 'usage_limit', 'handoff_enforcement', 'infra_watch'] as const;
export type RuleName = (typeof RULE_NAMES)[number];

export const PolicySchema = z.object({
  zero_extra_spend: z.boolean().default(true),
  newest_model_rule: z.boolean().default(true),
  /** Category → floor, e.g. { code: "sonnet-class high", research: "pro-class" }. */
  quality_floor: z.record(z.string(), z.string()).default({}),
  /** Ordered model-class patterns (first match wins). Defaults are heuristics; override per vendor. */
  model_classes: z.array(z.object({ class: z.string(), pattern: z.string() })).optional(),
  allowed_models: z.array(z.string()).optional(),
  denied_models: z.array(z.string()).default([]),
  require_approval: z.array(z.string()).default(['push_protected', 'deploy', 'prod_db_write', 'migration_apply', 'publish', 'send_message']),
  /** Env var names whose values are redacted wherever they appear. */
  redact_env: z.array(z.string()).default([]),
  stall: z
    .object({ no_event_minutes: z.number().positive().default(10), approval_pending_minutes: z.number().positive().default(15) })
    .default({ no_event_minutes: 10, approval_pending_minutes: 15 }),
  idle_alert_minutes: z.number().positive().default(5),
  auto_dispatch_next: z.boolean().default(true),
  rules: z.partialRecord(z.enum(RULE_NAMES), z.boolean()).default({}),
  quiet_hours: z.object({ start: z.string(), end: z.string() }).optional(),
  privacy: z.object({ strict_mcp: z.boolean().default(true) }).default({ strict_mcp: true }),
});
export type Policy = z.infer<typeof PolicySchema>;

/** Kinds of work, used to route each piece of work to the right agent/model. */
export const WORK_TYPES = ['plan', 'code', 'review', 'test', 'docs', 'research'] as const;
export const WorkTypeSchema = z.enum(WORK_TYPES);
export type WorkType = z.infer<typeof WorkTypeSchema>;

export const StageSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  /** Which kind of work this stage is; routing picks the agent. `item` = the item's own work type. */
  work: z.union([WorkTypeSchema, z.literal('item')]),
  /** A human must approve before this stage starts (waterfall gates). */
  gate: z.boolean().default(false),
});
export type Stage = z.infer<typeof StageSchema>;

export const WorkflowSchema = z.object({
  methodology: z.enum(['kanban', 'scrum', 'waterfall']).default('kanban'),
  /** Items moved to Ready are dispatched automatically (respecting the WIP limit). */
  auto_start: z.boolean().default(true),
  wip_limit: z.number().int().positive().default(3),
  /** Code review by a different agent after every build stage. */
  review: z.boolean().default(true),
  /** Merge approved work to the integration branch without waiting for a click. Off by default. */
  auto_merge: z.boolean().default(false),
  sprint: z.object({ name: z.string().default('Sprint 1') }).default({ name: 'Sprint 1' }),
  /** Waterfall phases (in order). Kanban/Scrum use build → review. */
  phases: z.array(StageSchema).default([
    { id: 'requirements', work: 'research', gate: false },
    { id: 'design', work: 'plan', gate: true },
    { id: 'implementation', work: 'item', gate: true },
    { id: 'verification', work: 'test', gate: false },
  ]),
});
export type WorkflowConfig = z.infer<typeof WorkflowSchema>;

/** Obsidian vault (or any markdown folder) used for shared context: contract, brief, handoffs, decisions. */
const VaultFolderSchema = z.string().min(1).refine(s => !s.startsWith('/') && !s.includes('\\') && !s.split('/').some(p => p === '..' || p === '.' || !p), 'use a vault-relative folder without traversal');
export const DocSearchConfigSchema = z.object({
  semantic: z.boolean().default(false),
  endpoint: z.string().url().default('http://127.0.0.1:11434').refine(s => {
    const u = new URL(s);
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/';
  }, 'local embeddings require an HTTP endpoint on 127.0.0.1 with no credentials or path'),
  embedding_model: z.string().min(1).max(120).default('embeddinggemma'),
  answer_model: z.string().min(1).max(120).optional(),
  budget_chars: z.number().int().min(1500).max(12000).default(6000),
}).default({ semantic: false, endpoint: 'http://127.0.0.1:11434', embedding_model: 'embeddinggemma', budget_chars: 6000 });
export const KnowledgeConfigSchema = z.object({
  vault: z.string().min(1),
  /** Folder inside the vault the control center owns and rewrites. */
  folder: VaultFolderSchema.default('Agent Control Center'),
  /** Extra vault folders agents may read. Nothing else in the vault is ever read. */
  context_folders: z.array(VaultFolderSchema).max(32).default([]),
  search: DocSearchConfigSchema,
  /** Use the official `obsidian` CLI (Obsidian 1.12.4+) for search when Obsidian is running. */
  obsidian_cli: z.enum(['auto', 'on', 'off']).default('auto'),
  obsidian_binary: z.string().optional(),
  /** Vault name for `obsidian vault=…` and obsidian:// links (default: vault folder name). */
  vault_name: z.string().optional(),
  write: z
    .object({ contract: z.boolean().default(true), brief: z.boolean().default(true), issues: z.boolean().default(true), handoffs: z.boolean().default(true), decisions: z.boolean().default(true) })
    .default({ contract: true, brief: true, issues: true, handoffs: true, decisions: true }),
});
export type KnowledgeConfig = z.infer<typeof KnowledgeConfigSchema>;

/** graphify code knowledge graph of the integration branch, queryable by every agent. */
export const GraphifyConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    binary: z.string().optional(),
    /** Rebuild the AST graph (no LLM, no cost) whenever the integration branch moves. */
    auto_update: z.boolean().default(true),
    /** Semantic (LLM) extraction uses an API key and costs money: off unless explicitly opted in. */
    semantic: z.boolean().default(false),
    semantic_opt_in: z.boolean().default(false),
    semantic_backend: z.string().optional(),
    budget: z.number().int().min(100).max(20_000).default(1500),
    /** Copy GRAPH_REPORT.md into the vault folder as "Graph Report". */
    publish_report: z.boolean().default(true),
  })
  .superRefine((g, ctx) => {
    if (g.semantic && !g.semantic_opt_in) ctx.addIssue({ code: 'custom', message: 'graphify.semantic uses a paid LLM API: set semantic_opt_in: true to accept the cost', path: ['semantic'] });
  });
export type GraphifyConfig = z.infer<typeof GraphifyConfigSchema>;

const LoopbackFixture = z.string().refine((s) => {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1') && !u.username && !u.password && !u.hash;
  } catch {
    return false;
  }
}, 'use an HTTP loopback fixture with no credentials');

const RelativeDir = z.string().min(1).max(200).refine((s) => !pathLikeAbsolute(s) && !s.split('/').some((p) => p === '..' || p === '.' || !p), 'use a relative directory without traversal');
function pathLikeAbsolute(s: string): boolean {
  return s.startsWith('/') || s.startsWith('\\');
}

const HostName = z.string().regex(/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::[0-9]{1,5})?$/, 'hostname, optional port').max(253);
const ScopeList = z.array(z.string().regex(/^[a-zA-Z0-9_.:-]{1,80}$/)).max(16).default([]);

/** Owner opt-in. Host and scopes are required when activated. No outbound call until then. */
const ActivationFields = {
  activated: z.boolean().default(false),
  host: HostName.optional(),
  scopes: ScopeList,
};

function refineActivation(c: { activated?: boolean; host?: string; scopes?: string[] }, ctx: z.RefinementCtx): void {
  if (c.activated && (!c.host || !c.scopes?.length)) ctx.addIssue({ code: 'custom', message: 'An activated connection needs a host and at least one scope.', path: ['activated'] });
}

const WebhookConfigSchema = z.object({
  secret_account: z.enum(['github-webhook', 'gitlab-webhook']),
  max_skew_seconds: z.number().int().min(1).max(300).default(300),
  replay_window_seconds: z.number().int().min(30).max(3600).default(600),
}).strict();

/** Read-only code host. Live calls happen only after activation (host + scopes) and an egress allowlist entry. */
export const CodeHostConfigSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('github'),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    fixture_base: LoopbackFixture.optional(),
    ...ActivationFields,
    webhook: WebhookConfigSchema.optional(),
    poll_seconds: z.number().int().min(15).max(300).optional(),
    finding_issues: z.enum(['manual', 'rule']).default('manual'),
  }).strict().superRefine(refineActivation),
  z.object({
    provider: z.literal('gitlab'),
    project: z.string().min(1).max(200).refine((s) => !s.includes('..') && !s.includes('://'), 'project id or path'),
    fixture_base: LoopbackFixture.optional(),
    ...ActivationFields,
    webhook: WebhookConfigSchema.optional(),
    poll_seconds: z.number().int().min(15).max(300).optional(),
    finding_issues: z.enum(['manual', 'rule']).default('manual'),
  }).strict().superRefine(refineActivation),
]);
export type CodeHostConfig = z.infer<typeof CodeHostConfigSchema>;

/** Read-only hosting and database probes. Live Vercel and Supabase stay off until activated. */
export const InfraConfigSchema = z.object({
  finding_issues: z.enum(['manual', 'rule']).default('manual'),
  vercel: z.object({
    project: z.string().min(1).max(100),
    fixture_base: LoopbackFixture.optional(),
    ...ActivationFields,
  }).strict().superRefine(refineActivation).optional(),
  supabase: z.object({
    project_ref: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
    fixture_base: LoopbackFixture.optional(),
    migrations_dir: RelativeDir.default('supabase/migrations'),
    ...ActivationFields,
  }).strict().superRefine(refineActivation).optional(),
}).strict();
export type InfraConfig = z.infer<typeof InfraConfigSchema>;

export const ControlCenterConfigSchema = z
  .object({
    project: ProjectConfigSchema,
    tracker: TrackerConfigSchema.default({ type: 'local', key_prefix: 'LOC' }),
    policies: PolicySchema.default(PolicySchema.parse({})),
    agents: z.array(AgentConfigSchema).min(1),
    /** Who does what: work type → agents in order of preference. */
    import_sources: z.array(z.object({
      id: z.string().regex(/^[a-z0-9-]+$/), name: z.string(), type: z.enum(['github', 'linear']),
      enabled: z.boolean().default(false), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
      team: z.string().optional(), project: z.string().optional(),
    }).superRefine((s, ctx) => {
      if (s.type === 'github' && !s.repo || s.type === 'linear' && !s.team) ctx.addIssue({ code: 'custom', message: 'GitHub requires repo; Linear requires team' });
    })).default([]),
    routing: z.partialRecord(WorkTypeSchema, z.array(z.string())).default({}),
    workflow: WorkflowSchema.default(WorkflowSchema.parse({})),
    knowledge: KnowledgeConfigSchema.optional(),
    graphify: GraphifyConfigSchema.optional(),
    code_host: CodeHostConfigSchema.optional(),
    infra: InfraConfigSchema.optional(),
    server: z.object({ port: z.number().int().default(7317) }).default({ port: 7317 }),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    for (const a of c.agents) {
      if (ids.has(a.id)) ctx.addIssue({ code: 'custom', message: `duplicate agent id ${a.id}`, path: ['agents'] });
      ids.add(a.id);
    }
    for (const [type, ids] of Object.entries(c.routing)) {
      for (const id of ids ?? []) if (!ids.length || !c.agents.some((a) => a.id === id)) ctx.addIssue({ code: 'custom', message: `routing.${type}: unknown agent ${id}`, path: ['routing', type] });
    }
    if (c.project.protected_branches.includes(c.project.integration_branch)) {
      ctx.addIssue({ code: 'custom', message: 'integration_branch must not be a protected branch', path: ['project', 'integration_branch'] });
    }
  });
export type ControlCenterConfig = z.infer<typeof ControlCenterConfigSchema>;

export function parseConfig(raw: unknown): ControlCenterConfig {
  return ControlCenterConfigSchema.parse(raw);
}

export function formatConfigError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
  }
  return String(err);
}

export function ruleEnabled(p: Policy | undefined, rule: RuleName): boolean {
  return p?.rules?.[rule] ?? true;
}
