// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The acc MCP server's registered tools and the list harness adapters pre-approve stay in sync.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { ACC_MCP_AUTO_APPROVED, ACC_MCP_PERMISSION_TOOL, ACC_MCP_PROMPTED } from '../src/mcp/tools.ts';
import { MCP_SERVER_PATH } from '../src/runManager.ts';
import { tmpDir } from './helpers.ts';

describe('acc MCP tools', () => {
  it('every registered tool is either pre-approved, prompted or the permission hook', async () => {
    const client = new Client({ name: 'tool-list', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--disable-warning=ExperimentalWarning', MCP_SERVER_PATH, tmpDir('mcp-tools')] }));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...ACC_MCP_AUTO_APPROVED, ...ACC_MCP_PROMPTED, ACC_MCP_PERMISSION_TOOL].sort());
    } finally {
      await client.close();
    }
  }, 30_000);
});
