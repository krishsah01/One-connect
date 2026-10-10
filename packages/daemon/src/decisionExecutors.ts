// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Every action that binds its own Decision, in one list. Decisions.answer() refuses these and
// Decisions.respond() routes to them, both from this registry, so a new executor is added once.
import type { Daemon } from './daemon.ts';
import type { DecisionExecutor } from './decisions.ts';

export function decisionExecutors(d: Daemon): DecisionExecutor[] {
  const bound = (...prefixes: string[]) => (id: string) => prefixes.some((p) => d.store.kvGet(`${p}${id}`) !== null);
  return [
    {
      key: 'link',
      owns: bound('workflow-link:decision:'),
      resolve: (id, answer, actor, o) => d.workflowLinks.decide(d.store.kvGet(`workflow-link:decision:${id}`)!, answer, actor, o),
    },
    { key: 'settings', owns: bound('settings:decision:'), resolve: (id, answer, _actor, o) => d.settings.resolve(id, answer, o) },
    { key: 'cost', owns: bound('agent-cost:'), resolve: (id, answer, actor, o) => d.agentCosts.resolve(id, answer, o, actor) },
    { key: 'connection', owns: bound('connector:decision:'), resolve: (id, answer, actor, o) => d.connectors.resolve(id, answer, actor, o) },
    { key: 'tool', owns: bound('connector-tool:'), resolve: (id, answer, actor, o) => d.connectors.resolveToolCall(id, answer, actor, o) },
    {
      key: 'environment',
      owns: bound('env-action:'),
      resolve: (id, answer, _actor, o) => {
        const pending = JSON.parse(d.store.kvGet(`env-action:${id}`)!) as { digest: string };
        return d.environment.resolve(id, answer, pending.digest, o);
      },
    },
    { key: 'docker', owns: bound('docker:'), resolve: (id, answer, _actor, o) => d.docker.resolve(id, answer, o) },
    { key: 'remote', owns: (id) => d.remote.isRemoteDecision(id), resolve: async (id, answer, actor, o) => (await d.remote.resolve(id, answer, actor, o)).status },
    { key: 'notification', owns: (id) => d.notifications.isEndpointDecision(id), resolve: (id, answer, actor, o) => d.notifications.resolveEndpoint(id, answer, actor, o) },
    { key: 'release', owns: bound('release:', 'release-rollback:', 'release-inspect:'), resolve: (id, answer, _actor, o) => d.releasePlans.resolve(id, answer, o) },
  ];
}
