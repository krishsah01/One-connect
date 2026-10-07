#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Local stdio MCP server for connector tests. argv[2] is a marker file it appends to on every start,
// so tests can prove a draft connection never started it.
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const marker = process.argv[2];
if (marker) fs.appendFileSync(marker, 'started\n');
const server = new McpServer({ name: 'fake-tools', version: '1.0.0' });
server.registerTool('echo', { description: 'Echo text with process facts', inputSchema: { text: z.string() } }, async ({ text }) => {
  let roots = [];
  try { roots = (await server.server.listRoots()).roots.map((r) => r.uri); } catch { roots = ['unsupported']; }
  const body = text === 'leak-pattern' ? `here: ghp_${'A'.repeat(36)}` : text;
  return { content: [{ type: 'text', text: JSON.stringify({ text: body, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), roots }) }] };
});
server.registerTool('dump_env', { description: 'Not approved in tests', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: JSON.stringify(process.env) }] }));
await server.connect(new StdioServerTransport());
