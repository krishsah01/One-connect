// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The tool names of the `acc` MCP server (server.ts), in one list that harness adapters use to
// pre-approve calls. test/mcp-tools.test.ts fails if server.ts registers a tool missing here.

/** Tools agents may call without a prompt: reads, handoffs and requests that create Decisions. */
export const ACC_MCP_AUTO_APPROVED = [
  'get_assignment',
  'post_handoff',
  'submit_review',
  'report_finding',
  'ask_human',
  'get_brief',
  'get_team',
  'read_messages',
  'send_team_message',
  'ack_team_message',
  'get_design_system',
  'get_design_skill',
  'search_context',
  'get_project_context',
  'ask_project',
  'read_note',
  'query_graph',
  'graph_path',
  'explain_node',
  'list_skills',
  'get_skill',
  'register_design_mock',
  'record_mock_evidence',
  'get_design_mock',
  'submit_design_review',
  'list_connector_tools',
  'call_connector_tool',
  'get_connector_tool_result',
] as const;

/** Registered tools that are not pre-approved (each call goes through the owner's approval). */
export const ACC_MCP_PROMPTED = ['get_release_status', 'get_infra_health'] as const;

/** The harness permission hook itself; never listed as an allowed tool. */
export const ACC_MCP_PERMISSION_TOOL = 'permission_prompt';

/** `mcp__acc__<tool>` names for a harness allowlist. */
export const accToolPatterns = (): string[] => ACC_MCP_AUTO_APPROVED.map((t) => `mcp__acc__${t}`);
