import { describe, it, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withKeyfileLock } from "../../src/credentials/keyfile.js";

// Invented fixtures only — this repository is public (CLAUDE.md).

// No test here constructs a provider or client, but the env is snapshotted and
// restored anyway so a stray QBO_* value can never leak between files.
const ENV_KEYS = ["QBO_CREDENTIAL_FILE", "QBO_CREDENTIAL_MODE", "QBO_CLIENT_ID", "QBO_CLIENT_SECRET"];

// The cross-process holders import the compiled module this test runs against:
// dist-test/tests/credentials/ → dist-test/src/credentials/keyfile.js.
const KEYFILE_MODULE_URL = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../src/credentials/keyfile.js"),
).href;

const READY_LINE = "locked";
const READY_TIMEOUT_MS = 10_000;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const live = new Set<ChildProcess>();

function killLiveChildren(): void {
  for (const child of live) child.kill("SIGKILL");
  live.clear();
}

/**
 * Spawn a lock holder and resolve once it prints the readiness line from inside
 * its lock. The holder keeps the lock until its stdin closes or it is killed.
 */
async function spawnHolder(command: string, args: string[]): Promise<ChildProcess> {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  live.add(child);
  child.on("exit", () => live.delete(child));

  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  await new Promise<void>((resolveReady, rejectReady) => {
    let stdout = "";
    const timer = setTimeout(
      () => rejectReady(new Error(`holder not ready after ${READY_TIMEOUT_MS} ms: ${stderr}`)),
      READY_TIMEOUT_MS,
    );
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.split("\n").includes(READY_LINE)) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`holder exited (${code}) before taking the lock: ${stderr}`));
    });
  });
  return child;
}

/** A child node process holding withKeyfileLock on `keyfilePath`. */
function spawnNodeHolder(keyfilePath: string): Promise<ChildProcess> {
  const script = `
    import { withKeyfileLock } from ${JSON.stringify(KEYFILE_MODULE_URL)};
    await withKeyfileLock(${JSON.stringify(keyfilePath)}, async () => {
      process.stdout.write(${JSON.stringify(READY_LINE + "\n")});
      await new Promise((done) => {
        process.stdin.on("end", done);
        process.stdin.on("close", done);
        process.stdin.resume();
      });
    });
  `;
  return spawnHolder(process.execPath, ["--input-type=module", "-e", script]);
}

/** A python3 child holding fcntl.flock(fd, LOCK_EX) on `lockPath`, the way a peer script does. */
function spawnPythonHolder(lockPath: string): Promise<ChildProcess> {
  const script = [
    "import fcntl, os, sys",
    "fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)",
    "fcntl.flock(fd, fcntl.LOCK_EX)",
    `print(${JSON.stringify(READY_LINE)}, flush=True)`,
    "sys.stdin.read()",
  ].join("\n");
  return spawnHolder("python3", ["-c", script, lockPath]);
}

function pythonAvailable(): boolean {
  const probe = spawnSync("python3", ["-c", "import fcntl"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

async function releaseHolder(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.on("exit", () => done()));
  child.stdin!.end();
  await exited;
}

describe("withKeyfileLock", () => {
  let dir: string;
  let keyfilePath: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.QBO_CREDENTIAL_MODE = "local";
    dir = mkdtempSync(join(tmpdir(), "keyfile-lock-test-"));
    keyfilePath = join(dir, "creds.json");
    process.env.QBO_CREDENTIAL_FILE = keyfilePath;
  });

  afterEach(() => {
    killLiveChildren();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  after(killLiveChildren);

  const isBusy = (path: string) => (err: Error) => {
    assert.match(err.message, /keyfile lock is busy/);
    assert.ok(err.message.includes(`${path}.lock`), `message names ${path}.lock`);
    return true;
  };

  it("lock-busy-across-processes — times out while another process holds the lock", async () => {
    await spawnNodeHolder(keyfilePath);
    let ran = false;

    await assert.rejects(
      withKeyfileLock(keyfilePath, async () => { ran = true; }, { timeoutMs: 300 }),
      isBusy(keyfilePath),
    );
    assert.equal(ran, false);
  });

  it("lock-acquired-after-holder-exits — takes the lock once the other process exits", async () => {
    const holder = await spawnNodeHolder(keyfilePath);
    await releaseHolder(holder);

    const result = await withKeyfileLock(keyfilePath, async () => "acquired", { timeoutMs: 2000 });

    assert.equal(result, "acquired");
  });

  it("lock-excludes-python-flock — a python3 fcntl.flock holder excludes the Node side", async (t) => {
    if (!pythonAvailable()) {
      t.skip("python3 unavailable");
      return;
    }
    await spawnPythonHolder(`${keyfilePath}.lock`);
    let ran = false;

    await assert.rejects(
      withKeyfileLock(keyfilePath, async () => { ran = true; }, { timeoutMs: 300 }),
      isBusy(keyfilePath),
    );
    assert.equal(ran, false);
  });

  it("lock-serializes-in-process — parallel same-process callers never overlap", async () => {
    let active = 0;
    let maxActive = 0;
    const body = async (value: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(50);
      active--;
      return value;
    };

    const results = await Promise.all([
      withKeyfileLock(keyfilePath, () => body("first")),
      withKeyfileLock(keyfilePath, () => body("second")),
    ]);

    assert.deepEqual(results, ["first", "second"]);
    assert.equal(maxActive, 1);
  });

  it("lock-released-after-throw — a throwing body still releases the lock", async () => {
    const boom = new Error("body failed");

    await assert.rejects(
      withKeyfileLock(keyfilePath, async () => { throw boom; }),
      (err) => err === boom,
    );

    const result = await withKeyfileLock(keyfilePath, async () => "after", { timeoutMs: 300 });
    assert.equal(result, "after");
  });

  it("lock-queue-wait-times-out — a queued caller's deadline covers the in-process wait", async () => {
    let signalEntered!: () => void;
    const entered = new Promise<void>((r) => { signalEntered = r; });
    let firstDone = false;

    const first = withKeyfileLock(keyfilePath, async () => {
      signalEntered();
      await delay(600);
      firstDone = true;
    });
    await entered;

    let secondRan = false;
    let firstDoneWhenSecondSettled: boolean | undefined;
    const second = withKeyfileLock(keyfilePath, async () => { secondRan = true; }, { timeoutMs: 200 })
      .finally(() => { firstDoneWhenSecondSettled = firstDone; });

    let firstDoneWhenThirdRan: boolean | undefined;
    const third = withKeyfileLock(keyfilePath, async () => {
      firstDoneWhenThirdRan = firstDone;
      return "third";
    }, { timeoutMs: 2000 });

    await assert.rejects(second, isBusy(keyfilePath));
    assert.equal(secondRan, false);
    assert.equal(firstDoneWhenSecondSettled, false, "the second caller timed out while still queued");

    await first;
    assert.equal(await third, "third");
    assert.equal(firstDoneWhenThirdRan, true);
  });

  it("lock-file-persists-0600 — leaves <path>.lock in place with mode 0600", async () => {
    const lockPath = `${keyfilePath}.lock`;
    assert.equal(existsSync(lockPath), false);

    await withKeyfileLock(keyfilePath, async () => undefined);

    assert.equal(existsSync(lockPath), true);
    assert.equal(statSync(lockPath).mode & 0o777, 0o600);
  });

  it("lock-unsupported-platform-fails-closed — refuses on an unsupported platform before touching the filesystem", async () => {
    let ran = false;

    await assert.rejects(
      withKeyfileLock(keyfilePath, async () => { ran = true; }, { platform: "win32" }),
      (err: Error) => {
        assert.match(err.message, /keyfile lock unavailable on win32/);
        assert.match(err.message, /refusing to refresh/);
        assert.ok(err.message.includes(keyfilePath), "message names the keyfile path");
        return true;
      },
    );
    assert.equal(ran, false);
    assert.equal(existsSync(`${keyfilePath}.lock`), false);
  });
});
