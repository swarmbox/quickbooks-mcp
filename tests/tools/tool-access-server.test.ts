import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer, type McpServerOptions } from "../../src/server.js";
import { toolDefinitions } from "../../src/tools/definitions.js";
import { ENABLED_TOOLS_ENV, READ_ONLY_ENV, isReadOnlyTool } from "../../src/tools/access.js";

// The stdio server gates tools/list and tools/call through the resolver in
// src/tools/access.ts. What matters here is that both handlers read the same
// exposed set, resolved from process.env per request: a tool the server does
// not list cannot be called by name either. The Lambda transport is covered in
// tests/auth/remote-tool-allowlist.test.ts.
//
// The resolver's memo is module state shared by every case in this file, so a
// case that asserts on notices uses raw values no other case here uses.

type ToolCallResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

const ENV_KEYS = [READ_ONLY_ENV, ENABLED_TOOLS_ENV] as const;

let snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot = {};
  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  mock.restoreAll();
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const sorted = (names: Iterable<string>): string[] => [...names].sort();
const allNames = (): string[] => sorted(toolDefinitions.map((t) => t.name));
const readOnlyNames = (): string[] => sorted(toolDefinitions.filter(isReadOnlyTool).map((t) => t.name));

async function connect(
  options?: McpServerOptions
): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function listedNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return sorted(tools.map((t) => t.name));
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolCallResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolCallResult;
}

describe("stdio tool access", () => {
  it("stdio-read-only-lists-read-only-set", async () => {
    process.env[READ_ONLY_ENV] = "true";
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(sorted(tools.map((t) => t.name)), readOnlyNames());
      for (const t of tools) {
        const defined = toolDefinitions.find((d) => d.name === t.name) as { annotations?: unknown };
        assert.deepEqual(t.annotations, defined.annotations, t.name);
      }
    } finally {
      await close();
    }
  });

  it("stdio-gated-call-names-read-only", async () => {
    process.env[READ_ONLY_ENV] = "true";
    const { client, close } = await connect();
    try {
      // An unknown parameter that executeTool's validation would reject: the
      // gate's wording instead shows the call was refused before dispatch.
      const result = await callTool(client, "create_bill", { not_a_real_parameter: "x" });
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, "Tool create_bill is not available: disabled by QBO_READ_ONLY");
      assert.doesNotMatch(result.content[0].text, /Invalid arguments/);
    } finally {
      await close();
    }
  });

  it("stdio-gated-call-names-allowlist", async () => {
    process.env[ENABLED_TOOLS_ENV] = "query";
    const { client, close } = await connect();
    try {
      const result = await callTool(client, "get_bill", { id: "1" });
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, "Tool get_bill is not available: not listed in QBO_ENABLED_TOOLS");
    } finally {
      await close();
    }
  });

  it("stdio-read-only-allowlist-refusals", async () => {
    process.env[READ_ONLY_ENV] = "true";
    process.env[ENABLED_TOOLS_ENV] = "query,create_bill";
    const { client, close } = await connect();
    try {
      assert.deepEqual(await listedNames(client), ["query"]);

      // Listed but a write tool: refused for read-only, before argument
      // validation could reject the unknown parameter.
      const write = await callTool(client, "create_bill", { not_a_real_parameter: "x" });
      assert.equal(write.isError, true);
      assert.equal(write.content[0].text, "Tool create_bill is not available: disabled by QBO_READ_ONLY");

      // A read tool the allowlist leaves out: refused for the allowlist.
      const unlisted = await callTool(client, "get_bill", { id: "1" });
      assert.equal(unlisted.isError, true);
      assert.equal(unlisted.content[0].text, "Tool get_bill is not available: not listed in QBO_ENABLED_TOOLS");
    } finally {
      await close();
    }
  });

  it("stdio-exposed-tool-dispatches", async () => {
    process.env[READ_ONLY_ENV] = "true";
    const { client, close } = await connect();
    try {
      // Only executeTool's argument validation produces this reply, and it runs
      // before any credential lookup, so no QuickBooks connection is needed.
      const result = await callTool(client, "query", { qeury: "SELECT * FROM Account" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Invalid arguments/);
      assert.match(result.content[0].text, /Unknown parameter "qeury"/);
    } finally {
      await close();
    }
  });

  it("stdio-undefined-tool-unknown", async () => {
    const { client, close } = await connect();
    try {
      // Awaited directly: a JSON-RPC error would reject here and fail the case.
      const result = await callTool(client, "not_a_tool");
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, "Unknown tool: not_a_tool");
    } finally {
      await close();
    }
  });

  it("stdio-withheld-tool-unknown", async () => {
    process.env[ENABLED_TOOLS_ENV] = "get_bill,query";
    const { client, close } = await connect({ withhold: new Set(["get_bill"]) });
    try {
      assert.deepEqual(await listedNames(client), ["query"]);
      const result = await callTool(client, "get_bill", { id: "1" });
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, "Unknown tool: get_bill");
    } finally {
      await close();
    }
  });

  it("stdio-env-flip-per-request", async () => {
    const { client, close } = await connect();
    try {
      assert.deepEqual(await listedNames(client), allNames());
      process.env[READ_ONLY_ENV] = "true";
      assert.deepEqual(await listedNames(client), readOnlyNames());
      delete process.env[READ_ONLY_ENV];
      assert.deepEqual(await listedNames(client), allNames());
    } finally {
      await close();
    }
  });

  it("stdio-notices-logged-once", async () => {
    // Neither value is used by any other case in this file, and neither is a
    // recognized boolean, so each one changes the memo key and adds a notice.
    const first = "notice-probe-first";
    const second = "notice-probe-second";

    const errors = mock.method(console, "error", () => {});
    // stdout is the stdio JSON-RPC channel: nothing may log there. These spies
    // stand in for process.stdout.write, which the test runner writes to itself.
    const stdoutLoggers = (["log", "info", "warn"] as const).map((level) =>
      mock.method(console, level)
    );

    const noticesFor = (value: string, from = 0): number =>
      errors.mock.calls
        .slice(from)
        .filter((call) =>
          call.arguments.map(String).join(" ").includes(`${READ_ONLY_ENV}=${JSON.stringify(value)}`)
        ).length;

    const { client, close } = await connect();
    try {
      process.env[READ_ONLY_ENV] = first;
      await client.listTools();
      await client.listTools();
      assert.equal(noticesFor(first), 1, "first value's notice must be written exactly once");

      const before = errors.mock.callCount();
      process.env[READ_ONLY_ENV] = second;
      await client.listTools();
      assert.equal(noticesFor(second, before), 1, "second value's notice must be written");

      for (const spy of stdoutLoggers) {
        assert.equal(spy.mock.callCount(), 0, "notices must not reach stdout");
      }
    } finally {
      await close();
    }
  });
});
