// SPDX-License-Identifier: Apache-2.0
import { HUMAN, newId, type Decision } from '@acc/core';
import { run, type ExecResult } from './exec.ts';
import type { Daemon } from './daemon.ts';
import type { AnswerOptions } from './decisions.ts';
type DockerRun = (args: string[]) => Promise<ExecResult>;
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
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('Invalid container ID');
    const { containers } = await this.list();
    if (!containers.some(c => c.ID === id)) throw new Error('Container is outside this configured Compose project');
    return id;
  }
  async logs(id: string) {
    await this.target(id);
    const r = await this.execute(['logs', '--timestamps', '--tail', '300', id]);
    return { text: this.d.redactText(r.stdout + r.stderr), exitCode: r.code };
  }
  async request(id: string, action: string) {
    await this.target(id);
    if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Unsupported Docker action');
    const decision: Decision = { id: newId('decision'), question: `Run docker ${action} ${id} in ${this.d.config.project.docker_project ?? this.d.config.project.name}?`, options: ['approve', 'deny'], recommendation: null, evidenceLinks: [], urgency: 'normal', irreversible: false, answer: null, answeredAt: null, channel: null, createdAt: this.d.nowIso(), kind: 'docker' };
    this.d.commit([{ type: 'decision.created', actor: HUMAN, data: { decision } }], [], () => this.d.store.kvSet(`docker:${decision.id}`, JSON.stringify({ id, action, expires: Date.now() + 120000, consumed: false })));
    return { decision };
  }
  async resolve(decisionId: string, answer: string, o: AnswerOptions = {}) {
    const raw = this.d.store.kvGet(`docker:${decisionId}`);
    const decision = this.d.state.decisions[decisionId];
    if (!raw || !decision || decision.answeredAt) throw new Error('Approval missing or already consumed');
    const a = JSON.parse(raw) as { id: string; action: string; expires: number; consumed: boolean };
    if (a.consumed || a.expires < Date.now()) throw new Error('Approval expired or consumed');
    if (!['approve', 'deny'].includes(answer)) throw new Error('Choose approve or deny');
    await this.target(a.id);
    // Re-check after await: simultaneous confirmations cannot execute the same approval twice.
    if (this.d.state.decisions[decisionId].answeredAt) throw new Error('Approval already consumed');
    this.d.decisions.answerAtomic(decisionId, answer, { channel: 'dashboard', ...o }, HUMAN, [], () => this.d.store.kvSet(`docker:${decisionId}`, JSON.stringify({ ...a, consumed: true })));
    if (answer === 'deny') return { executed: false };
    const r = await this.execute([a.action, a.id]);
    this.d.commit([{ type: 'docker.action', actor: HUMAN, data: { decisionId, command: ['docker', a.action, a.id], exitCode: r.code, output: this.d.redactText(r.stdout + r.stderr + (r.error ?? '')) } }]);
    return { executed: true, exitCode: r.code, output: this.d.redactText(r.stdout + r.stderr) };
  }
}
