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
if (marker) fs.appendFileSync(marker, `pid:${process.pid}\n`);
const server = new McpServer({ name: 'fake-tools', version: '1.0.0' });
server.registerTool('echo', { description: 'Echo text with process facts', inputSchema: { text: z.string() } }, async ({ text }) => {
  if (marker) fs.appendFileSync(marker, 'called:echo\n');
  let roots = [];
  try { roots = (await server.server.listRoots()).roots.map((r) => r.uri); } catch { roots = ['unsupported']; }
  const body = text === 'leak-pattern' ? `here: ghp_${'A'.repeat(36)}` : text;
  return { content: [{ type: 'text', text: JSON.stringify({ text: body, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), roots }) }] };
});
server.registerTool('dump_env', { description: 'Not approved in tests', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: JSON.stringify(process.env) }] }));
server.registerTool('fail', { description: 'Returns a tool error', inputSchema: {} }, async () => {
  if (marker) fs.appendFileSync(marker, 'called:fail\n');
  return { content: [{ type: 'text', text: 'tool reported failure' }], isError: true };
});
server.registerTool('nested', { description: 'Echo nested JSON arrays', inputSchema: { items: z.array(z.object({ tags: z.array(z.string()), value: z.number() })) } }, async ({ items }) => {
  if (marker) fs.appendFileSync(marker, 'called:nested\n');
  return { content: [{ type: 'text', text: JSON.stringify({ items }) }] };
});
server.registerTool('drop', { description: 'Record invocation then drop the real connection', inputSchema: {} }, async () => {
  if (marker) fs.appendFileSync(marker, 'called:drop\n');
  process.exit(0);
});
server.registerTool('delayed', { description: 'Record invocation then wait for a local release file', inputSchema: { text: z.string() } }, async ({ text }) => {
  if (marker) fs.appendFileSync(marker, 'called:delayed\n');
  // Tests can change authorization during an actual outstanding call, without mock protocol errors.
  while (!fs.existsSync(`${marker}.release`)) await new Promise(resolve => setTimeout(resolve, 10));
  if (marker) fs.appendFileSync(marker, 'returned:delayed\n');
  return { content: [{ type: 'text', text }] };
});
await server.connect(new StdioServerTransport());
