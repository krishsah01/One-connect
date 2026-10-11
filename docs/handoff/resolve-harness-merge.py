#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
"""Resolve the expected conflicts when claude/harness-setup-compliance meets the refactored tree.

Run from the repository root while `git merge claude/harness-setup-compliance` is stopped on
conflicts, on a branch that already contains refactor/solid-foundations:
    python3 docs/handoff/resolve-harness-merge.py && pnpm -r typecheck

The harness branch edits code that the refactor moved, so its additions are re-applied where that
code lives now:
- daemon.ts: keep the refactored side, then add the account watch (import, option, field,
  construction, start, a step-isolated stop) and `initialProbe`.
- probe() is in agentService.ts, preflight() in workService.ts; both now read `accounts`.
- The account-terms routes go to server/agentRoutes.ts, key-age bookkeeping to
  server/connectionRoutes.ts (http.ts only lists route modules now).
- AgentsSetup.tsx: both import lists.
"""
import re
import subprocess

def ours(path: str) -> None:
    subprocess.run(['git', 'checkout', '--ours', path], check=True)

def edit(path: str, *pairs: tuple[str, str]) -> None:
    src = open(path).read()
    for old, new in pairs:
        if old not in src:
            raise SystemExit(f'{path}: anchor not found:\n{old}')
        src = src.replace(old, new, 1)
    open(path, 'w').write(src)

D = 'packages/daemon/src/'

ours(D + 'daemon.ts')
ours(D + 'server/http.ts')

edit(D + 'daemon.ts',
     ("import { InfraHealth } from './infra/health.ts';\n",
      "import { InfraHealth } from './infra/health.ts';\nimport { AccountCompliance } from './accountCompliance.ts';\n"),
     ("  rulesTickMs?: number;\n",
      "  rulesTickMs?: number;\n  /** Login / confirmation / key-age watch interval; 0 disables it (tests). */\n  accountWatchMs?: number;\n"),
     ("  readonly subscriptionSafety: SubscriptionSafety;\n",
      "  readonly subscriptionSafety: SubscriptionSafety;\n  readonly accounts: AccountCompliance;\n"),
     ("  closed = false;\n",
      "  closed = false;\n  /** The startup probe of every enabled agent (login, billing, models, binary signature). */\n  initialProbe: Promise<void> = Promise.resolve();\n"),
     ("    this.subscriptionSafety = new SubscriptionSafety(this);\n",
      "    this.subscriptionSafety = new SubscriptionSafety(this);\n    this.accounts = new AccountCompliance(this);\n"),
     ("    this.rules.start(this.opts.rulesTickMs ?? 15_000);\n",
      "    this.rules.start(this.opts.rulesTickMs ?? 15_000);\n    if (this.opts.accountWatchMs !== 0) this.accounts.start(this.opts.accountWatchMs ?? 15 * 60_000);\n"),
     ("    if (this.opts.probe !== false) void this.probeAll();\n",
      "    if (this.opts.probe !== false) this.initialProbe = this.probeAll();\n"),
     ("    await step('rules', () => this.rules.stop());\n",
      "    await step('rules', () => this.rules.stop());\n    await step('account watch', () => this.accounts.stop());\n"))

edit(D + 'agentService.ts',
     ("import { needsCostApproval, type AgentCosts } from './agentCosts.ts';\n",
      "import type { AccountCompliance } from './accountCompliance.ts';\nimport { needsCostApproval, type AgentCosts } from './agentCosts.ts';\n"),
     ("  readonly agentCosts: AgentCosts;\n",
      "  readonly agentCosts: AgentCosts;\n  readonly accounts: AccountCompliance;\n"),
     ("    this.d.commit([{ type: 'agent.probed', agentId, data: r }]);\n",
      "    this.d.commit([{ type: 'agent.probed', agentId, data: r }]);\n    await this.d.accounts.refreshSignature(agentId).catch(() => undefined);\n"))

edit(D + 'workService.ts',
     ("import type { TrackerAdapter } from './adapters/trackers/index.ts';\n",
      "import type { AccountCompliance } from './accountCompliance.ts';\nimport type { TrackerAdapter } from './adapters/trackers/index.ts';\n"),
     ("  readonly subscriptionSafety: SubscriptionSafety;\n",
      "  readonly subscriptionSafety: SubscriptionSafety;\n  readonly accounts: AccountCompliance;\n"),
     ("      subscriptionConfirmation: agent ? this.d.subscriptionSafety.status(agent.id) : undefined,\n",
      "      subscriptionConfirmation: agent ? this.d.subscriptionSafety.status(agent.id) : undefined,\n"
      "      accountTerms: agent ? this.d.accounts.check(agent.id) : undefined,\n"
      "      signature: agent ? this.d.accounts.signature(agent.id) : undefined,\n"))

edit(D + 'server/agentRoutes.ts',
     ("  app.post('/api/agents/:id/subscription-safety',",
      "  // Own-account / vendor-terms confirmation for subscription logins (owner only, at this Mac).\n"
      "  app.get('/api/agents/:id/account-terms', async (req: Req) => d.accounts.status(req.params.id));\n"
      "  app.post('/api/agents/:id/account-terms', async (req: Req<{ statements?: unknown }>) => d.accounts.acknowledge(req.params.id, req.body?.statements));\n"
      "  app.delete('/api/agents/:id/account-terms', async (req: Req) => d.accounts.revoke(req.params.id));\n"
      "  app.post('/api/agents/:id/subscription-safety',"))

edit(D + 'server/connectionRoutes.ts',
     ("    const out: Record<string, { stored: boolean; usedBy: string[] }> = {};",
      "    const out: Record<string, { stored: boolean; usedBy: string[]; storedAt: string | null; ageDays: number | null; rotationDue: boolean }> = {};"),
     ("      out[name] = { stored: await hasSecret(name, d.baseEnv()), usedBy:",
      "      out[name] = { stored: await hasSecret(name, d.baseEnv()), ...d.accounts.keyAge(name), usedBy:"),
     ("    d.addSecret(key);\n", "    d.addSecret(key);\n    d.accounts.keyStored(name);\n"),
     ("    await deleteSecret(secretName(req.params.id));\n",
      "    const name = secretName(req.params.id);\n    await deleteSecret(name);\n    d.accounts.keyRemoved(name);\n"))

setup = 'packages/web/src/pages/AgentsSetup.tsx'
edit(setup, (re.search(r"<<<<<<< [^\n]*\n.*?>>>>>>> [^\n]*\n", open(setup).read(), re.S).group(0),
             "import type { AccountPolicy, AgentState, BinaryInfo, BillingInfo, ControlState, Run } from '@acc/core';\n"
             "import { isManualRelay, RULE_NAMES, ruleEnabled, sharedCapacity, shellJoin } from '@acc/core';\n"))

subprocess.run(['git', 'add', D + 'daemon.ts', D + 'server/http.ts', D + 'agentService.ts', D + 'workService.ts',
                D + 'server/agentRoutes.ts', D + 'server/connectionRoutes.ts', setup], check=True)
print('Resolved. Run `pnpm -r typecheck` and `pnpm test`, then commit the merge.')
