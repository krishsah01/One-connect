// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { containsSecret, GraphifyConfigSchema, HUMAN, isActiveRun, parseConfig, type CodeHostConfig, type ControlCenterConfig, type GraphifyConfig, type InfraConfig, type NewEvent, type Policy, type ProjectConfig } from '@acc/core';
import { CommandError } from './errors.ts';
import type { AnswerOptions, Decisions } from './decisions.ts';
import { sha256 } from './util/hash.ts';
import type { ConfigCommands, Kernel } from './kernel.ts';
import type { ContextSync } from './context/sync.ts';

/** What this service needs from the daemon (see kernel.ts). */
export type SettingsDeps = Kernel & ConfigCommands & { readonly context: ContextSync; readonly decisions: Decisions };

export interface SettingsDraft { project: ProjectConfig; policies: Policy; code_host: CodeHostConfig | null; infra: InfraConfig | null; graphify: GraphifyConfig }
const digest = (value: unknown) => sha256(JSON.stringify(value));
const PREFIX = 'settings:decision:';
export function settingsSnapshot(config: ControlCenterConfig): SettingsDraft { return { project: config.project, policies: config.policies, code_host: config.code_host ?? null, infra: config.infra ?? null, graphify: config.graphify ?? GraphifyConfigSchema.parse({}) }; }
export function settingsConfig(base: ControlCenterConfig, value: SettingsDraft) { return parseConfig({ ...base, project: value.project, policies: value.policies, code_host: value.code_host ?? undefined, infra: value.infra ?? undefined, graphify: value.graphify ?? base.graphify }); }
const validBranch = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name) && !/\.\.|\/\/|\/$|\.$|\.lock(?:\/|$)/.test(name);

export class Settings {
  readonly d: SettingsDeps;
  constructor(d: SettingsDeps) { this.d = d; }
  read() { const settings = settingsSnapshot(this.d.config); return { settings, revision: digest(settings), tracker: this.d.config.tracker }; }

  private validate(input: SettingsDraft): { config: ControlCenterConfig; settings: SettingsDraft } {
    const config = settingsConfig(this.d.config, input);
    const before = this.d.config;
    if (config.project.repo !== before.project.repo || config.project.docker_project !== before.project.docker_project) throw new CommandError('Repository and Docker namespace belong to this project. Add another project to change them.');
    if (!config.policies.zero_extra_spend || !config.policies.privacy.strict_mcp) throw new CommandError('Zero-extra-spend defaults and strict connector privacy must remain enabled. Paid agents have a separate cost Decision.');
    if (before.project.protected_branches.some(branch => !config.project.protected_branches.includes(branch)) || before.policies.require_approval.some(action => !config.policies.require_approval.includes(action))) throw new CommandError('This settings editor can add protections and required approvals; it cannot remove existing safety gates.');
    if ([config.project.integration_branch, ...(config.project.production_branch ? [config.project.production_branch] : []), ...config.project.protected_branches].some(branch => !validBranch(branch))) throw new CommandError('Use valid branch names without spaces, traversal or option prefixes.');
    if (config.project.integration_branch === config.project.production_branch || config.project.protected_branches.includes(config.project.integration_branch)) throw new CommandError('Choose an integration branch separate from protected and production branches.');
    if (config.project.required_checks?.some(name => !config.project.checks[name]?.trim())) throw new CommandError('Every required check needs a configured command.');
    if (config.project.check_runtime?.mode === 'host-fixture' && digest(config.project.check_runtime) !== digest(before.project.check_runtime)) throw new CommandError('Host fixture execution cannot be enabled from Settings. Use a Docker check runtime.');
    if (containsSecret(JSON.stringify(input), { denylist: this.d.denylist() }).length) throw new CommandError('Remove credentials from settings. Connections store keys separately.');
    if (config.graphify?.semantic || config.graphify?.semantic_opt_in) throw new CommandError('Graphify in Settings uses code-only extraction. Paid semantic extraction needs its own reviewed cost and data action.');
    if (config.graphify?.binary && !config.graphify.binary.startsWith('/')) throw new CommandError('Pin Graphify to an absolute path, or leave it blank for installed-tool detection.');
    // Saving a draft cannot activate any remote integration. Connectors owns read approval.
    if (config.code_host) config.code_host.activated = false;
    if (config.infra?.vercel) config.infra.vercel.activated = false;
    if (config.infra?.supabase) config.infra.supabase.activated = false;
    return { config, settings: settingsSnapshot(config) };
  }

  private idle() {
    const docs = this.d.context.docs?.status();
    if (this.d.context.answer.busy || docs?.indexing || docs?.searching) throw new CommandError('Wait for indexing and document queries to finish before changing project settings.', 409);
    if (Object.values(this.d.state.runs).some(run => isActiveRun(run)) || Object.values(this.d.state.assignments).some(a => a.position === 'now' || a.position === 'next') || Object.values(this.d.state.workflows ?? {}).some(w => w.status === 'running') || Object.values(this.d.state.releases ?? {}).some(p => p.steps.some(s => s.status === 'running'))) throw new CommandError('Finish or cancel active and queued work before changing project safety settings.', 409);
  }

  request(input: SettingsDraft, expected: string) {
    if (!input || typeof input !== 'object' || !input.project || !input.policies || typeof expected !== 'string') throw new CommandError('Provide project settings and the saved revision to review.');
    this.idle();
    if (expected !== this.read().revision) throw new CommandError('Project settings changed. Reload them before saving.', 409);
    const { settings } = this.validate(input);
    const hash = digest(settings);
    if (hash === expected) throw new CommandError('There are no settings changes to save.');
    const previous = Object.values(this.d.state.decisions).filter(d => d.kind === 'settings' && !d.answeredAt && !d.consumedAt);
    const expiresAt = new Date(this.d.now().getTime() + 15 * 60_000).toISOString();
    return this.d.decisions.createBound({
      kind: 'settings', question: `Save project settings for ${settings.project.name}?`, options: ['save', 'cancel'], confirmOptions: ['save'], irreversible: true, urgency: 'normal', risk: 'high', expiresAt,
      action: { kind: 'settings', repo: settings.project.repo, hash },
      evidence: [
        { label: 'Exact reviewed settings', detail: JSON.stringify(settings, null, 2) },
        { label: 'Remote integrations', detail: 'Saved disabled. Each connection requires its own read approval in Connectors. No remote service is contacted by this action.' },
        { label: 'Runtime', detail: 'Commands run only when work is dispatched or a release action is explicitly approved. Required checks are bound to this runtime revision.' },
      ],
    }, HUMAN, () => previous.map(d => ({ type: 'decision.consumed', actor: HUMAN, data: { decisionId: d.id, outcome: 'replaced by a newer settings draft' } })), id => {
      for (const dec of previous) { this.d.store.kvDelete(PREFIX + dec.id); this.d.store.kvDelete(`decision-confirm:${dec.id}`); }
      this.d.store.kvSet(PREFIX + id, JSON.stringify({ settings, hash, expected, expiresAt }));
    });
  }

  async resolve(id: string, answer: string, options: AnswerOptions) {
    this.d.decisions.validateAnswer(id, answer, options);
    if (answer === 'cancel') {
      this.d.decisions.answerAtomic(id, answer, options, HUMAN, [{ type: 'decision.consumed', actor: HUMAN, data: { decisionId: id, outcome: 'settings unchanged' } }], () => this.d.store.kvDelete(PREFIX + id));
      return { saved: false };
    }
    const raw = this.d.store.kvGet(PREFIX + id);
    if (!raw) throw new CommandError('This settings draft is missing. Request a new review.', 409);
    const pending = JSON.parse(raw) as { settings: SettingsDraft; hash: string; expected: string; expiresAt: string };
    if (Date.parse(pending.expiresAt) <= this.d.now().getTime()) throw new CommandError('This settings review expired.', 410);
    if (pending.expected !== this.read().revision) throw new CommandError('Project settings changed since this review.', 409);
    this.idle();
    const { config, settings } = this.validate(pending.settings);
    const action = this.d.state.decisions[id].action;
    if (digest(settings) !== pending.hash || action?.kind !== 'settings' || action.hash !== pending.hash || action.repo !== this.d.config.project.repo) throw new CommandError('The settings binding changed.', 409);
    const previous = this.d.config;
    this.d.config = config;
    const events: NewEvent[] = [
      { type: 'config.loaded', actor: HUMAN, data: { project: config.project, tracker: config.tracker, policies: config.policies } },
      { type: 'decision.consumed', actor: HUMAN, data: { decisionId: id, outcome: 'reviewed project settings saved' } },
    ];
    try {
      this.d.decisions.answerAtomic(id, answer, options, HUMAN, events, () => { this.d.store.kvSet('project:settings', JSON.stringify(settings)); this.d.store.kvDelete(PREFIX + id); });
    } catch (error) { this.d.config = previous; throw error; }
    this.d.refreshEgress();
    if (previous.project.integration_branch !== config.project.integration_branch || digest(previous.graphify) !== digest(config.graphify)) await this.d.reloadContext();
    return { saved: true, revision: digest(settings) };
  }
}
