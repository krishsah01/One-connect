#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
"""Resolve the three expected conflicts when refactor/solid-foundations meets the Designer upgrade.

Run from the repository root while `git merge refactor/solid-foundations` is stopped on conflicts:
    python3 docs/handoff/resolve-designer-merge.py && pnpm -r typecheck

- adapters/agents/claude.ts and daemon.ts: keep the refactor side. The Designer's four new MCP
  tools go into mcp/tools.ts (a test fails if server.ts registers a tool missing there), and
  its design binding moves into WorkService.preflight (the commands left daemon.ts).
- designer.ts: keep both imports.
"""
import re
import subprocess

def theirs(path: str) -> None:
    subprocess.run(['git', 'checkout', '--theirs', path], check=True)

def edit(path: str, fn) -> None:
    src = open(path).read()
    out = fn(src)
    if out == src:
        raise SystemExit(f'{path}: nothing to change (already resolved?)')
    open(path, 'w').write(out)

theirs('packages/daemon/src/adapters/agents/claude.ts')
theirs('packages/daemon/src/daemon.ts')

edit('packages/daemon/src/designer.ts', lambda s: re.sub(
    r"<<<<<<< [^\n]*\n(import \{ DesignDocuments \} from './designDocuments.ts';\n)=======\n(import \{ sha256 \} from './util/hash.ts';\n)>>>>>>> [^\n]*\n",
    r"\1\2", s))

DESIGN_TOOLS = ['get_design_document', 'get_design_components', 'validate_design_document', 'propose_design_changes']
edit('packages/daemon/src/mcp/tools.ts', lambda s: s.replace(
    "  'ack_team_message',\n", "  'ack_team_message',\n" + ''.join(f"  '{t}',\n" for t in DESIGN_TOOLS if f"'{t}'" not in s), 1))

anchor = "      subscriptionConfirmation: agent ? this.d.subscriptionSafety.status(agent.id) : undefined,\n"
edit('packages/daemon/src/workService.ts', lambda s: s.replace(
    anchor, anchor + "      designBinding: this.d.designer.documents.bindingCheck(a),\n", 1))

subprocess.run(['git', 'add', 'packages/daemon/src/adapters/agents/claude.ts', 'packages/daemon/src/daemon.ts',
                'packages/daemon/src/designer.ts', 'packages/daemon/src/mcp/tools.ts', 'packages/daemon/src/workService.ts'], check=True)
print('Resolved. Run `pnpm -r typecheck` and `pnpm test`, then commit the merge.')
