import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readKeyfile,
  writeKeyfileAtomic,
  isAccessTokenFresh,
  withTokens,
  EXPIRES_AT_KEY,
  REFRESH_MARGIN_MS,
  type KeyfileData,
} from "../../src/credentials/keyfile.js";
import type { TokenSet } from "../../src/credentials/types.js";

// Invented fixtures only — this repository is public (CLAUDE.md).

// No test here constructs a provider or client, but the env is snapshotted and
// restored anyway so a stray QBO_* value can never leak between files.
const ENV_KEYS = ["QBO_CREDENTIAL_FILE", "QBO_CREDENTIAL_MODE", "QBO_CLIENT_ID", "QBO_CLIENT_SECRET"];

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
const iso = (epoch: number) => new Date(epoch).toISOString();

describe("keyfile", () => {
  let dir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.QBO_CREDENTIAL_MODE = "local";
    dir = mkdtempSync(join(tmpdir(), "keyfile-test-"));
    process.env.QBO_CREDENTIAL_FILE = join(dir, "creds.json");
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

  const tmpEntries = (d: string) => readdirSync(d).filter((e) => e.endsWith(".tmp"));

  it("keyfile-write-replaces-0600 — replaces the file atomically with mode 0600", async () => {
    const path = join(dir, "creds.json");
    writeFileSync(path, JSON.stringify({ access_token: "access-1" }), { mode: 0o644 });
    chmodSync(path, 0o644);
    const data = { access_token: "access-2", note: "kept" };

    await writeKeyfileAtomic(path, data);

    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), data);
    assert.deepEqual(tmpEntries(dir), []);
  });

  it("keyfile-write-failure-cleans-temp — removes the temp file when the rename fails", async () => {
    const target = join(dir, "target");
    mkdirSync(target);

    await assert.rejects(writeKeyfileAtomic(target, { access_token: "access-2" }));

    assert.deepEqual(tmpEntries(dir), []);
  });

  it("keyfile-read-missing — names the path and qbo_authenticate", async () => {
    const path = join(dir, "absent.json");

    await assert.rejects(readKeyfile(path), (err: Error) => {
      assert.match(err.message, /not found/);
      assert.ok(err.message.includes(path));
      assert.match(err.message, /qbo_authenticate/);
      return true;
    });
  });

  it("keyfile-read-not-object — rejects arrays and unparseable JSON", async () => {
    const array = join(dir, "array.json");
    const junk = join(dir, "junk.json");
    writeFileSync(array, "[1]");
    writeFileSync(junk, "not json");

    for (const path of [array, junk]) {
      await assert.rejects(readKeyfile(path), (err: Error) => {
        assert.match(err.message, /unreadable or not a JSON object/);
        assert.ok(err.message.includes(path));
        return true;
      });
    }
  });

  it("token-fresh-beyond-margin — fresh with 5 minutes and 1 second left", () => {
    const data: KeyfileData = {
      access_token: "access-1",
      [EXPIRES_AT_KEY]: iso(NOW + REFRESH_MARGIN_MS + 1000),
    };
    assert.equal(isAccessTokenFresh(data, NOW), true);
  });

  it("token-stale-at-margin — stale with exactly 5 minutes left", () => {
    const data: KeyfileData = {
      access_token: "access-1",
      [EXPIRES_AT_KEY]: iso(NOW + REFRESH_MARGIN_MS),
    };
    assert.equal(isAccessTokenFresh(data, NOW), false);
  });

  it("token-stale-when-unknown — stale when expiry is past, missing, unparseable or the token is absent", () => {
    const future = iso(NOW + 3_600_000);
    const variants: KeyfileData[] = [
      { access_token: "access-1", [EXPIRES_AT_KEY]: iso(NOW - 1000) },
      { access_token: "access-1" },
      { access_token: "access-1", [EXPIRES_AT_KEY]: "soon" },
      { [EXPIRES_AT_KEY]: future },
    ];
    for (const data of variants) {
      assert.equal(isAccessTokenFresh(data, NOW), false, JSON.stringify(Object.keys(data)));
    }
  });

  it("with-tokens-sets-expiry — sets tokens and a second-precision UTC expiry without mutating input", () => {
    const data: KeyfileData = { access_token: "access-1", refresh_token: "refresh-1", note: "kept" };
    const tokens: TokenSet = { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 };

    const result = withTokens(data, tokens, Date.UTC(2026, 0, 1, 0, 0, 0, 500));

    assert.equal(result.access_token, "access-2");
    assert.equal(result.refresh_token, "refresh-2");
    assert.equal(result[EXPIRES_AT_KEY], "2026-01-01T01:00:00Z");
    assert.equal(result.note, "kept");
    assert.deepEqual(data, { access_token: "access-1", refresh_token: "refresh-1", note: "kept" });
  });

  it("with-tokens-drops-expiry — removes a stale expiry when expires_in is absent", () => {
    const data: KeyfileData = {
      access_token: "access-1",
      refresh_token: "refresh-1",
      [EXPIRES_AT_KEY]: "2026-01-01T00:00:00Z",
    };
    const tokens: TokenSet = { access_token: "access-2", refresh_token: "refresh-2" };

    const result = withTokens(data, tokens, NOW);

    assert.equal(EXPIRES_AT_KEY in result, false);
    assert.equal(result.access_token, "access-2");
    assert.equal(EXPIRES_AT_KEY in data, true);
  });
});
