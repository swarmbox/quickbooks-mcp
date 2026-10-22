import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { LocalCredentialProvider } from "../../src/credentials/local-provider.js";
import { EXPIRES_AT_KEY, withKeyfileLock, writeKeyfileAtomic, type KeyfileData } from "../../src/credentials/keyfile.js";
import type { QBCredentials, TokenRefresher, TokenSet } from "../../src/credentials/types.js";

// Invented fixtures only — this repository is public (CLAUDE.md).
const BASE_KEYFILE: KeyfileData = {
  client_id: "client-file",
  client_secret: "secret-file",
  redirect_url: "https://example.invalid/cb",
  access_token: "access-1",
  refresh_token: "refresh-1",
  company_id: "1234",
};

const SAVED_CREDENTIALS: QBCredentials = {
  client_id: "client-file",
  client_secret: "secret-file",
  redirect_url: "https://example.invalid/cb",
  access_token: "access-3",
  refresh_token: "refresh-3",
  company_id: "1234",
};

const REFRESHED: TokenSet = { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 };

/** Every token value a fixture uses; none may appear in an error message. */
const FIXTURE_TOKENS = ["access-1", "access-2", "refresh-1", "refresh-2"];

// Every test constructs a provider, so the env is snapshotted and restored and
// QBO_CREDENTIAL_FILE always points at a throwaway keyfile.
const ENV_KEYS = ["QBO_CREDENTIAL_FILE", "QBO_CREDENTIAL_MODE", "QBO_CLIENT_ID", "QBO_CLIENT_SECRET"];

const HOUR_MS = 60 * 60_000;

/** An expiry `offsetMs` from now in the keyfile's second-precision UTC format. */
const expiresIn = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "Z");

const fresh = (data: KeyfileData): KeyfileData => ({ ...data, [EXPIRES_AT_KEY]: expiresIn(HOUR_MS) });
const stale = (data: KeyfileData): KeyfileData => ({ ...data, [EXPIRES_AT_KEY]: expiresIn(-HOUR_MS) });

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function writeKeyfile(path: string, data: KeyfileData): void {
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
}

const readJson = (path: string): KeyfileData => JSON.parse(readFileSync(path, "utf8"));

/** Assert the expiry recorded in `data` is 59 to 61 minutes from now. */
function assertExpiresInAboutAnHour(data: KeyfileData): void {
  const value = data[EXPIRES_AT_KEY];
  assert.equal(typeof value, "string", `${EXPIRES_AT_KEY} is set`);
  const minutesAhead = (Date.parse(value as string) - Date.now()) / 60_000;
  assert.ok(minutesAhead >= 59 && minutesAhead <= 61, `expiry is ${minutesAhead} minutes ahead`);
}

function assertNoTokens(message: string): void {
  for (const token of FIXTURE_TOKENS) {
    assert.ok(!message.includes(token), `message must not carry the fixture token ${token}`);
  }
}

/** A TokenRefresher that counts its calls, records what it was given, and resolves REFRESHED. */
function fakeRefresher(before?: () => void): TokenRefresher & { calls: QBCredentials[] } {
  const calls: QBCredentials[] = [];
  const refresh = async (current: QBCredentials) => {
    calls.push(current);
    before?.();
    return { ...REFRESHED };
  };
  return Object.assign(refresh, { calls });
}

/**
 * Hold withKeyfileLock(path) in this process. The body calls `signal` from
 * inside the lock, which resolves `acquired`, so a caller started after that is
 * guaranteed to queue behind the holder.
 */
function holdLock(
  path: string,
  body: (signal: () => void) => Promise<void>,
): { acquired: Promise<void>; done: Promise<void> } {
  let signal!: () => void;
  const acquired = new Promise<void>((r) => { signal = r; });
  const done = withKeyfileLock(path, () => body(signal));
  return { acquired, done };
}

describe("LocalCredentialProvider", () => {
  let dir: string;
  let keyfilePath: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.QBO_CREDENTIAL_MODE = "local";
    delete process.env.QBO_CLIENT_ID;
    delete process.env.QBO_CLIENT_SECRET;
    dir = mkdtempSync(join(tmpdir(), "local-provider-test-"));
    keyfilePath = join(dir, "creds.json");
    process.env.QBO_CREDENTIAL_FILE = keyfilePath;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    // A failure test may leave the directory unwritable.
    try { chmodSync(dir, 0o700); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getFreshCredentials", () => {
    it("fresh-token-skips-refresh — a token well inside its lifetime is returned without refreshing", async () => {
      writeKeyfile(keyfilePath, fresh(BASE_KEYFILE));
      const before = readFileSync(keyfilePath);
      const refresh = fakeRefresher();

      const result = await new LocalCredentialProvider().getFreshCredentials(refresh);

      assert.equal(refresh.calls.length, 0);
      assert.equal(result.access_token, "access-1");
      assert.deepEqual(readFileSync(keyfilePath), before);
    });

    it("stale-token-refreshes-once — a past or missing expiry refreshes once and records the new expiry", async () => {
      const pastPath = join(dir, "past.json");
      const missingPath = join(dir, "missing.json");
      writeKeyfile(pastPath, stale(BASE_KEYFILE));
      writeKeyfile(missingPath, BASE_KEYFILE);

      for (const path of [pastPath, missingPath]) {
        process.env.QBO_CREDENTIAL_FILE = path;
        const refresh = fakeRefresher();

        const result = await new LocalCredentialProvider().getFreshCredentials(refresh);

        assert.equal(refresh.calls.length, 1, `one refresh for ${path}`);
        assert.equal(result.access_token, "access-2");
        const stored = readJson(path);
        assert.equal(stored.access_token, "access-2");
        assert.equal(stored.refresh_token, "refresh-2");
        assertExpiresInAboutAnHour(stored);
      }
    });

    it("parallel-stale-single-refresh — ten parallel callers on a stale keyfile share one refresh", async () => {
      writeKeyfile(keyfilePath, stale(BASE_KEYFILE));
      const refresh = fakeRefresher();
      const provider = new LocalCredentialProvider();

      const results = await Promise.all(Array.from({ length: 10 }, () => provider.getFreshCredentials(refresh)));

      assert.equal(refresh.calls.length, 1);
      assert.deepEqual(results.map((r) => r.access_token), Array(10).fill("access-2"));
    });

    it("forced-same-token-refreshes — a forced refresh replaces the rejected token even when it looks fresh", async () => {
      writeKeyfile(keyfilePath, fresh(BASE_KEYFILE));
      const refresh = fakeRefresher();

      await new LocalCredentialProvider().getFreshCredentials(refresh, { rejectedAccessToken: "access-1" });

      assert.equal(refresh.calls.length, 1);
      assert.equal(readJson(keyfilePath).access_token, "access-2");
    });

    it("forced-rotated-token-skips-refresh — a forced refresh is skipped once another process rotated the token", async () => {
      writeKeyfile(keyfilePath, fresh({ ...BASE_KEYFILE, access_token: "access-9", refresh_token: "refresh-9" }));
      const refresh = fakeRefresher();

      const result = await new LocalCredentialProvider().getFreshCredentials(refresh, {
        rejectedAccessToken: "access-1",
      });

      assert.equal(refresh.calls.length, 0);
      assert.equal(result.access_token, "access-9");
    });

    it("refresh-failure-leaves-keyfile — a rejected refresh writes nothing and surfaces the refresher's error", async () => {
      writeKeyfile(keyfilePath, stale(BASE_KEYFILE));
      const before = readFileSync(keyfilePath);
      const refreshError = new Error("refresh rejected by the token endpoint");
      const refresh: TokenRefresher = async () => { throw refreshError; };

      await assert.rejects(new LocalCredentialProvider().getFreshCredentials(refresh), (err: Error) => {
        assert.equal(err, refreshError);
        assertNoTokens(err.message);
        return true;
      });
      assert.deepEqual(readFileSync(keyfilePath), before);
    });

    it("refresh-waits-for-lock-holder — the provider takes the lock and re-reads the keyfile inside it", async () => {
      writeKeyfile(keyfilePath, stale(BASE_KEYFILE));
      const holder = holdLock(keyfilePath, async (signal) => {
        signal();
        await delay(300);
        await writeKeyfileAtomic(
          keyfilePath,
          fresh({ ...BASE_KEYFILE, access_token: "access-9", refresh_token: "refresh-9" }),
        );
      });
      await holder.acquired;
      const refresh = fakeRefresher();

      const result = await new LocalCredentialProvider().getFreshCredentials(refresh);
      await holder.done;

      assert.equal(refresh.calls.length, 0);
      assert.equal(result.access_token, "access-9");
    });

    it("write-failure-after-refresh — a failed save after a successful refresh says so without leaking tokens", async (t) => {
      if (process.getuid?.() === 0) {
        t.skip("root bypasses directory permissions, so the write cannot be made to fail");
        return;
      }
      writeKeyfile(keyfilePath, stale(BASE_KEYFILE));
      const refresh = fakeRefresher(() => chmodSync(dir, 0o500));

      try {
        await assert.rejects(new LocalCredentialProvider().getFreshCredentials(refresh), (err: Error) => {
          assert.match(err.message, /Intuit issued a new refresh token/);
          assert.ok(err.message.includes(keyfilePath), "message names the keyfile path");
          assert.match(err.message, /qbo_authenticate/);
          assertNoTokens(err.message);
          return true;
        });
      } finally {
        chmodSync(dir, 0o700);
      }
      assert.equal(refresh.calls.length, 1);
    });

    it("refresh-keeps-unknown-keys — a refresh keeps keys the provider does not know about", async () => {
      writeKeyfile(keyfilePath, stale({ ...BASE_KEYFILE, note: "kept" }));

      await new LocalCredentialProvider().getFreshCredentials(fakeRefresher());

      assert.equal(readJson(keyfilePath).note, "kept");
    });

    it("env-client-secret-not-persisted — env client credentials are used but never written by a refresh", async () => {
      writeKeyfile(keyfilePath, stale(BASE_KEYFILE));
      process.env.QBO_CLIENT_ID = "client-env";
      process.env.QBO_CLIENT_SECRET = "secret-env";
      const refresh = fakeRefresher();

      await new LocalCredentialProvider().getFreshCredentials(refresh);

      assert.equal(refresh.calls.length, 1);
      assert.equal(refresh.calls[0].client_id, "client-env");
      const stored = readJson(keyfilePath);
      assert.equal(stored.client_id, "client-file");
      assert.equal(stored.client_secret, "secret-file");
    });
  });

  describe("saveCredentials", () => {
    it("save-waits-for-lock-holder — a save queues behind the lock holder and merges what it wrote", async () => {
      writeKeyfile(keyfilePath, BASE_KEYFILE);
      const holder = holdLock(keyfilePath, async (signal) => {
        // Captured on acquiring the lock, without re-reading: a save that skipped
        // the lock would land first and be overwritten by this stale copy.
        const captured = { ...BASE_KEYFILE, note: "from-holder" };
        signal();
        await delay(300);
        await writeKeyfileAtomic(keyfilePath, captured);
      });
      await holder.acquired;

      await new LocalCredentialProvider().saveCredentials(SAVED_CREDENTIALS, 3600);
      await holder.done;

      const stored = readJson(keyfilePath);
      for (const [key, value] of Object.entries(SAVED_CREDENTIALS)) {
        assert.equal(stored[key], value, `${key} is saved`);
      }
      assert.equal(stored.note, "from-holder");
    });

    it("save-merges-and-sets-expiry — a save overlays the credentials, keeps unknown keys and records the expiry", async () => {
      writeKeyfile(keyfilePath, { ...BASE_KEYFILE, note: "kept" });

      await new LocalCredentialProvider().saveCredentials(SAVED_CREDENTIALS, 3600);

      const stored = readJson(keyfilePath);
      for (const [key, value] of Object.entries(SAVED_CREDENTIALS)) {
        assert.equal(stored[key], value, `${key} is saved`);
      }
      assert.equal(stored.note, "kept");
      assertExpiresInAboutAnHour(stored);
      assert.equal(statSync(keyfilePath).mode & 0o777, 0o600);
    });

    it("save-creates-missing-directory — a save creates the keyfile's directory", async () => {
      const nestedPath = join(dir, "nested", "deeper", "creds.json");
      process.env.QBO_CREDENTIAL_FILE = nestedPath;

      await new LocalCredentialProvider().saveCredentials(SAVED_CREDENTIALS, 3600);

      assert.ok(existsSync(dirname(nestedPath)), "directory exists");
      assert.ok(existsSync(nestedPath), "keyfile exists");
      const { [EXPIRES_AT_KEY]: _expiresAt, ...rest } = readJson(nestedPath);
      assert.deepEqual(rest, SAVED_CREDENTIALS);
      assertExpiresInAboutAnHour(readJson(nestedPath));
    });

    it("save-repairs-corrupt-keyfile — a save over an unparseable keyfile starts from scratch", async () => {
      writeFileSync(keyfilePath, "not json", { mode: 0o600 });

      await new LocalCredentialProvider().saveCredentials(SAVED_CREDENTIALS);

      const stored = readJson(keyfilePath);
      assert.deepEqual(stored, SAVED_CREDENTIALS);
      assert.ok(!(EXPIRES_AT_KEY in stored), `no ${EXPIRES_AT_KEY} without an expiry`);
    });
  });
});
