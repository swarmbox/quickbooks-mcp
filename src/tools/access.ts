// Which tools the server exposes, decided from two environment variables.
//
// QBO_READ_ONLY limits the server to tools that cannot change QuickBooks data.
// That set is read off each tool's `readOnlyHint` annotation instead of being
// listed here, so a new tool is classified the moment it is defined, and one
// without annotations is left out. QBO_ENABLED_TOOLS names the tools to expose.
// The two combine: with QBO_READ_ONLY off the allowlist selects any tools, and
// with it on the allowlist only narrows the read-only set (their intersection),
// so a listed write tool stays hidden. Each hidden tool is reported in `gated`
// with the variable that hid it.
//
// `qbo_authenticate` is the one exception. Its hints say "write" (they are
// value-identical to CREATE's, so the hints cannot single it out), but it only
// stores local OAuth credentials, and a read-only project still needs it for
// first-time setup and for recovering from a rejected refresh token.
//
// Pure: the caller passes its environment and logs the returned notices.

export const READ_ONLY_ENV = "QBO_READ_ONLY";
export const ENABLED_TOOLS_ENV = "QBO_ENABLED_TOOLS";

/** readOnlyHint false, but change no QuickBooks data (local state only). */
export const LOCAL_ONLY_TOOLS: ReadonlySet<string> = new Set(["qbo_authenticate"]);

type ToolDef = { name: string; annotations?: { readOnlyHint?: boolean } };

/** The variable that keeps a defined tool out of `names`. */
export type GateCause = "read-only" | "allowlist";

export interface ToolAccess {
  mode: "all" | "read-only" | "allowlist" | "read-only-allowlist";
  /** Tools to expose, in the definitions' own spelling. */
  names: ReadonlySet<string>;
  /**
   * Every defined tool not in `names`, mapped to its cause. Read-only wins: a
   * tool failing `isReadOnlyTool` under read-only is "read-only" whether or not
   * it is listed. A tool only the allowlist leaves out is "allowlist".
   */
  gated: ReadonlyMap<string, GateCause>;
  /** Stderr lines; the caller logs them. */
  notices: string[];
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["", "0", "false", "no", "off"]);

export function isReadOnlyTool(t: ToolDef): boolean {
  return t.annotations?.readOnlyHint === true || LOCAL_ONLY_TOOLS.has(t.name);
}

/** Unrecognized values fail closed: this is a safety switch. */
function parseReadOnly(raw: string | undefined): { on: boolean; unrecognized: boolean } {
  const value = (raw ?? "").trim().toLowerCase();
  if (TRUTHY.has(value)) return { on: true, unrecognized: false };
  if (FALSY.has(value)) return { on: false, unrecognized: false };
  return { on: true, unrecognized: true };
}

export function resolveToolAccess(env: NodeJS.ProcessEnv, defs: readonly ToolDef[]): ToolAccess {
  const notices: string[] = [];
  const readOnly = parseReadOnly(env[READ_ONLY_ENV]);
  const entries = (env[ENABLED_TOOLS_ENV] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const allowlistOn = entries.length > 0;

  if (readOnly.unrecognized) {
    notices.push(
      `${READ_ONLY_ENV}=${JSON.stringify(env[READ_ONLY_ENV])} is not a recognized boolean; treated as read-only`,
    );
  }

  // A blank allowlist counts as unset, so it lists every tool.
  const wanted = new Set(entries.map((entry) => entry.toLowerCase()));
  const listed = (def: ToolDef): boolean => !allowlistOn || wanted.has(def.name.toLowerCase());

  const exposed: ToolDef[] = [];
  const gated = new Map<string, GateCause>();
  for (const def of defs) {
    if (readOnly.on && !isReadOnlyTool(def)) gated.set(def.name, "read-only");
    else if (!listed(def)) gated.set(def.name, "allowlist");
    else exposed.push(def);
  }

  let mode: ToolAccess["mode"] = "all";
  if (readOnly.on) mode = allowlistOn ? "read-only-allowlist" : "read-only";
  else if (allowlistOn) mode = "allowlist";

  if (allowlistOn) {
    const known = new Set(defs.map((def) => def.name.toLowerCase()));
    const unknown = [...new Set(entries.filter((entry) => !known.has(entry.toLowerCase())))];
    if (unknown.length > 0) {
      notices.push(`${ENABLED_TOOLS_ENV}: ignored unknown tool name(s): ${unknown.join(", ")}`);
    }
    const matched = defs.filter(listed);
    const dropped = matched.filter((def) => gated.get(def.name) === "read-only");
    if (dropped.length > 0) {
      notices.push(
        `${ENABLED_TOOLS_ENV}: tool(s) disabled by ${READ_ONLY_ENV}: ${dropped.map((def) => def.name).join(", ")}`,
      );
    }
    if (matched.length === 0) {
      notices.push(`${ENABLED_TOOLS_ENV} matches no known tool; no tools are exposed`);
    } else if (exposed.length === 0) {
      notices.push(`${ENABLED_TOOLS_ENV} matches no read-only tool; no tools are exposed`);
    }
  }

  if (mode !== "all") {
    notices.push(`tool access: ${mode}, ${exposed.length} of ${defs.length} tools exposed`);
  }
  return { mode, names: new Set(exposed.map((def) => def.name)), gated, notices };
}
