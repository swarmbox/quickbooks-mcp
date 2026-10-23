import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CredentialProvider, QBCredentials } from "../../src/credentials/index.js";
import type { TokenRefresher } from "../../src/credentials/types.js";

// createClient is the test seam for getClient: it takes the provider and the
// refresher as arguments, so no real keyfile or Intuit call is involved. It is
// reached through a cast so that, until it exists, these tests fail at run time
// ("createClient is not a function") instead of stopping the test build.
type ForceArg = { rejectedAccessToken: string } | undefined;
type AuthModule = {
  createClient: (
    provider: CredentialProvider,
    refresh: TokenRefresher
  ) => Promise<{ token: string }>;
  clearCredentialsCache: () => void;
};

// Local mode, with the keyfile pointed at a throwaway directory, so nothing
// under test can reach a real keyfile even if the stub were bypassed.
const ENV_KEYS = [
  "QBO_CREDENTIAL_FILE",
  "QBO_CREDENTIAL_MODE",
  "QBO_CLIENT_ID",
  "QBO_CLIENT_SECRET",
] as const;

// Invented fixtures only — this repository is public (CLAUDE.md).
const CREDENTIALS: QBCredentials = {
  client_id: "client-file",
  client_secret: "secret-file",
  redirect_url: "https://example.invalid/cb",
  access_token: "access-1",
  refresh_token: "refresh-1",
  company_id: "1234",
};

type FreshCall = { refresh: TokenRefresher; force: ForceArg };

/** A provider that is always configured and hands back access-1, recording each getFreshCredentials call. */
function makeStubProvider(): { provider: CredentialProvider; calls: FreshCall[] } {
  const calls: FreshCall[] = [];
  const provider: CredentialProvider = {
    isConfigured: async () => true,
    getCompanyId: async () => "1234",
    getFreshCredentials: async (refresh, force) => {
      calls.push({ refresh, force });
      return { ...CREDENTIALS };
    },
    getCredentials: async () => {
      throw new Error("getCredentials is not used by createClient");
    },
    saveCredentials: async () => {
      throw new Error("saveCredentials is not used by createClient");
    },
  };
  return { provider, calls };
}

const noopRefresh: TokenRefresher = async (current) => ({
  access_token: current.access_token,
  refresh_token: current.refresh_token,
});

let snapshot: Record<string, string | undefined> = {};
let dir: string;
let generation = 0;

/**
 * Import a fresh instance of auth.js. Its client, credentials and pending-force
 * state live at module scope, so a plain import would share them across tests.
 */
async function loadAuth(): Promise<AuthModule> {
  const specifier = `../../src/client/auth.js?client-auth=${generation++}`;
  return (await import(specifier)) as AuthModule;
}

beforeEach(() => {
  snapshot = {};
  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), "client-auth-test-"));
  process.env.QBO_CREDENTIAL_MODE = "local";
  process.env.QBO_CREDENTIAL_FILE = join(dir, "keyfile.json");
  delete process.env.QBO_CLIENT_ID;
  delete process.env.QBO_CLIENT_SECRET;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("createClient and clearCredentialsCache", () => {
  it("client-uses-fresh-credentials — createClient asks the provider for fresh credentials and builds the client from them", async () => {
    const { createClient } = await loadAuth();
    const { provider, calls } = makeStubProvider();

    const client = await createClient(provider, noopRefresh);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].force, undefined);
    assert.equal(calls[0].refresh, noopRefresh);
    assert.equal(client.token, "access-1");
  });

  it("clear-forces-one-refresh — clearCredentialsCache makes the next createClient force a refresh once, carrying the rejected token", async () => {
    const { createClient, clearCredentialsCache } = await loadAuth();
    const { provider, calls } = makeStubProvider();

    await createClient(provider, noopRefresh);
    clearCredentialsCache();
    await createClient(provider, noopRefresh);
    await createClient(provider, noopRefresh);

    assert.equal(calls.length, 3);
    assert.equal(calls[0].force, undefined);
    assert.deepEqual(calls[1].force, { rejectedAccessToken: "access-1" });
    assert.equal(calls[2].force, undefined);
  });

  it("clear-before-client-no-force — clearCredentialsCache with no client created yet records no forced refresh", async () => {
    const { createClient, clearCredentialsCache } = await loadAuth();
    const { provider, calls } = makeStubProvider();

    clearCredentialsCache();
    await createClient(provider, noopRefresh);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].force, undefined);
  });
});
