// MCP Server setup and handler registration, shared by both transports

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { toolDefinitions, executeTool } from "./tools/index.js";
import {
  ENABLED_TOOLS_ENV,
  READ_ONLY_ENV,
  resolveToolAccess,
  type GateCause,
  type ToolAccess,
} from "./tools/access.js";

export interface McpServerOptions {
  /** Tools this transport never exposes, whatever the env says. */
  withhold?: ReadonlySet<string>;
}

// Refusal wording for a defined tool that env gates out, keyed by the cause
// the resolver reports for it.
const GATE_REASONS: Record<GateCause, string> = {
  "read-only": `disabled by ${READ_ONLY_ENV}`,
  allowlist: `not listed in ${ENABLED_TOOLS_ENV}`,
};

// Resolved from process.env on every request, never at module scope.
// src/index.ts loads .env with dotenv only after its static imports (this
// module included) have evaluated, so a module-scope read would miss any
// QBO_READ_ONLY or QBO_ENABLED_TOOLS set in .env.
//
// Memoized on the raw pair of values, so the resolver's notices are written
// once each time the configuration changes rather than once per request. They
// go to stderr: on stdio, stdout is the JSON-RPC channel.
let memo: { readOnly?: string; enabled?: string; access: ToolAccess } | undefined;

function currentToolAccess(): ToolAccess {
  const readOnly = process.env[READ_ONLY_ENV];
  const enabled = process.env[ENABLED_TOOLS_ENV];
  if (memo && memo.readOnly === readOnly && memo.enabled === enabled) {
    return memo.access;
  }
  const access = resolveToolAccess(process.env, toolDefinitions);
  for (const notice of access.notices) console.error(notice);
  memo = { readOnly, enabled, access };
  return access;
}

function refusal(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

export function createMcpServer(options: McpServerOptions = {}): Server {
  const withhold = options.withhold ?? new Set<string>();

  const server = new Server(
    { name: "quickbooks-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // The advertised list and the callable list must not diverge. Filtering
  // tools/list only changes what a caller is *told* about; tools/call
  // dispatches by name, so it checks the same exposed set before executeTool
  // runs. Otherwise a caller could still invoke a tool that was deliberately
  // withheld or gated out by env.
  const exposedNames = (access: ToolAccess): Set<string> =>
    new Set([...access.names].filter((name) => !withhold.has(name)));

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const exposed = exposedNames(currentToolAccess());
    return { tools: toolDefinitions.filter((t) => exposed.has(t.name)) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const access = currentToolAccess();
    if (exposedNames(access).has(name)) {
      return executeTool(name, args as Record<string, unknown>);
    }
    const cause = access.gated.get(name);
    if (cause && !withhold.has(name)) {
      // Gated out by env: name the cause, so a client holding a stale tool
      // list knows what to change. The cause is per tool, not per mode: with
      // both vars on, one configuration refuses different tools for
      // different reasons.
      return refusal(`Tool ${name} is not available: ${GATE_REASONS[cause]}`);
    }
    // Same wording executeTool uses for a name it has no handler for. A
    // withheld tool does not exist over that transport, and saying anything
    // more specific would confirm that it does elsewhere.
    return refusal(`Unknown tool: ${name}`);
  });

  return server;
}

// stdio server, connected by src/index.ts
export const server = createMcpServer();
