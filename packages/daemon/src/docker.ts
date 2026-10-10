// SPDX-License-Identifier: Apache-2.0
import { HUMAN, newId, type Decision } from '@acc/core';
import { run, type ExecResult } from './exec.ts';
import { CommandError, type Daemon } from './daemon.ts';
import type { AnswerOptions } from './decisions.ts';
type DockerRun = (args: string[]) => Promise<ExecResult>;
interface DockerApproval { id: string; action: string; project: string; namespace: string; expires: number; consumed: boolean }
export class ProjectDocker {
  readonly d: Daemon;
  readonly execute: DockerRun;
  constructor(d: Daemon, execute?: DockerRun) { this.d = d; this.execute = execute ?? (args => run('docker', args, { timeoutMs: 30000, maxBytes: 128000 })); }
  async list() {
    const project = this.d.config.project.docker_project ?? this.d.config.project.name;
    const r = await this.execute(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{json .}}']);
    if (r.code !== 0) return { available: false, project, containers: [], error: r.error ?? r.stderr.trim() };
    const containers = r.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as { ID: string; Names: string; State: string; Status: string; Image: string });
    return { available: true, project, containers, error: null };
  }
  private async target(id: string) {
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new CommandError('Invalid container ID');
    const { containers } = await this.list();
    if (!containers.some(c => c.ID === id)) throw new CommandError('Container is outside this configured Compose project', 409);
    return id;
  }
  async logs(id: string) {
    await this.target(id);
    const r = await this.execute(['logs', '--timestamps', '--tail', '300', id]);
    return { text: this.d.redactText(r.stdout + r.stderr), exitCode: r.code };
  }
  async request(id: string, action: string) {
    const project = this.d.config.project.repo;
    const namespace = this.d.config.project.docker_project ?? this.d.config.project.name;
    await this.target(id);
    if (project !== this.d.config.project.repo || namespace !== (this.d.config.project.docker_project ?? this.d.config.project.name)) throw new CommandError('Docker project changed. Request a fresh Decision.', 409);
    if (!['start', 'stop', 'restart'].includes(action)) throw new CommandError('Unsupported Docker action');
    const expires = this.d.now().getTime() + 120_000;
    const decision: Decision = { id: newId('decision'), question: `Run docker ${action} ${id} in ${namespace}?`, options: ['approve', 'deny'], recommendation: null, evidenceLinks: [], urgency: 'normal', irreversible: false, answer: null, answeredAt: null, channel: null, createdAt: this.d.nowIso(), kind: 'docker', confirmOptions: ['approve'], expiresAt: new Date(expires).toISOString() };
    this.d.commit([{ type: 'decision.created', actor: HUMAN, data: { decision } }], [], () => this.d.store.kvSet(`docker:${decision.id}`, JSON.stringify({ id, action, project, namespace, expires, consumed: false } satisfies DockerApproval)));
    return { decision };
  }
  async resolve(decisionId: string, answer: string, o: AnswerOptions = {}) {
    const raw = this.d.store.kvGet(`docker:${decisionId}`);
    const decision = this.d.state.decisions[decisionId];
    if (!raw || !decision || decision.answeredAt) throw new CommandError('Approval missing or already consumed', 409);
    const a = JSON.parse(raw) as DockerApproval;
    const validate = () => {
      if (a.consumed || !Number.isFinite(a.expires) || a.expires <= this.d.now().getTime()) throw new CommandError('Approval expired or consumed', 410);
      if (a.project !== this.d.config.project.repo || a.namespace !== (this.d.config.project.docker_project ?? this.d.config.project.name)) throw new CommandError('Docker project changed. Request a fresh Decision.', 409);
      if (!['start', 'stop', 'restart'].includes(a.action)) throw new CommandError('Unsupported Docker action');
      if (answer === 'approve' && !this.d.decisions.needsConfirmation(decision, answer)) throw new CommandError('This approval lacks confirmation. Request a fresh Decision.', 428);
    };
    if (!['approve', 'deny'].includes(answer)) throw new CommandError('Choose approve or deny');
    if (answer === 'deny') {
      this.d.decisions.answerAtomic(decisionId, answer, { channel: 'dashboard', ...o }, HUMAN, [], () => this.d.store.kvSet(`docker:${decisionId}`, JSON.stringify({ ...a, consumed: true })));
      return { executed: false };
    }
    validate();
    await this.target(a.id);
    validate();
    // Re-check after await: simultaneous confirmations cannot execute the same approval twice.
    if (this.d.state.decisions[decisionId].answeredAt) throw new CommandError('Approval already consumed', 409);
    this.d.decisions.answerAtomic(decisionId, answer, { channel: 'dashboard', ...o }, HUMAN, [], () => this.d.store.kvSet(`docker:${decisionId}`, JSON.stringify({ ...a, consumed: true })));
    const r = await this.execute([a.action, a.id]);
    this.d.commit([{ type: 'docker.action', actor: HUMAN, data: { decisionId, command: ['docker', a.action, a.id], exitCode: r.code, output: this.d.redactText(r.stdout + r.stderr + (r.error ?? '')) } }]);
    return { executed: true, exitCode: r.code, output: this.d.redactText(r.stdout + r.stderr) };
  }
}
