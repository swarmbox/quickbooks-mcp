// Local keyfile I/O: cross-process lock, read, atomic write, token freshness
// and token merge.
//
// The keyfile is shared with other processes (scripts that read and rewrite
// the same JSON). Three rules keep that safe: readers must never see a partly
// written file, so writes go through a temp file and rename; unknown keys
// must survive a round trip, so reads return the raw object rather than a
// typed view; and only one process at a time may refresh and persist the
// tokens, so that work runs under an exclusive lock on `<keyfile>.lock`.
//
// The lock contract, shared with the peer scripts: a holder opens
// `<keyfile>.lock` with O_CREAT|O_RDWR and mode 0600, takes
// `flock(fd, LOCK_EX | LOCK_NB)` (a Python script does this with
// `fcntl.flock`), polls every 50 ms for up to 30 s while the lock is busy,
// and never unlinks the lock file — unlinking would let a later opener lock a
// fresh inode while an earlier holder still locks the old one. The lock has to
// be a real flock(2): on Linux fcntl/OFD record locks don't exclude a flock
// holder, and mkdir or O_EXCL lock files are invisible to one everywhere, so
// any other primitive would leave both sides refreshing at once. Node core has no flock,
// so it is called from libc through koffi, and the kernel releases it if the
// holder crashes. Where it can't be taken, the lock fails closed: no refresh
// runs unlocked.

import { randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { TokenSet } from "./types.js";

/** Raw keyfile contents. Unknown keys are kept so other writers' fields survive. */
export type KeyfileData = Record<string, unknown>;

/**
 * Key holding when the current access token expires, as a UTC ISO-8601 string
 * with second precision and a `Z` suffix (e.g. `2026-01-01T01:00:00Z`). The
 * Python side of the shared keyfile contract reads and writes the same format.
 */
export const EXPIRES_AT_KEY = "access_token_expires_at";

/**
 * A token is treated as expired this long before it really is. Intuit rejects
 * a token the instant it lapses, and a request already in flight (or a clock
 * that is slightly off) would otherwise be sent with a token that dies
 * mid-call. Refreshing early trades one extra refresh for no such failures.
 */
export const REFRESH_MARGIN_MS = 5 * 60_000;

const NOT_FOUND_HINT = "Run qbo_authenticate to set up OAuth credentials.";

/**
 * Read the keyfile as a raw JSON object, unknown keys intact.
 * Throws a path-bearing message if the file is missing, unparseable, or not an object.
 */
export async function readKeyfile(path: string): Promise<KeyfileData> {
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Credentials file not found at ${path}. ${NOT_FOUND_HINT}`);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Credentials file at ${path} is unreadable or not a JSON object. ${NOT_FOUND_HINT}`);
  }
  return parsed as KeyfileData;
}

/**
 * Replace the keyfile atomically: write a 0600 temp file in the same directory
 * (so the rename stays on one filesystem), fsync it, rename it over the target,
 * then fsync the directory so the rename itself survives a crash. A concurrent
 * reader sees either the old file or the new one, never a partial write. The
 * temp file is removed if anything up to the rename fails.
 */
export async function writeKeyfileAtomic(path: string, data: KeyfileData): Promise<void> {
  const dir = dirname(path);
  const tmpPath = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);

  try {
    const handle = await fs.open(tmpPath, "wx", 0o600);
    try {
      // The mode passed to open is masked by the umask; chmod makes 0600 certain.
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(data, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, path);
  } catch (error) {
    try {
      await fs.unlink(tmpPath);
    } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
    }
    throw error;
  }

  // Best effort: some platforms and filesystems can't fsync a directory.
  try {
    const dirHandle = await fs.open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // ignored by design
  }
}

/**
 * True only when the keyfile records an access token that stays valid for more
 * than {@link REFRESH_MARGIN_MS}. A missing or unparseable expiry counts as
 * stale: refreshing needlessly is safe, using a dead token is not.
 */
export function isAccessTokenFresh(data: KeyfileData, now: number = Date.now()): boolean {
  const token = data.access_token;
  if (typeof token !== "string" || token === "") return false;

  const expiresAt = data[EXPIRES_AT_KEY];
  if (typeof expiresAt !== "string") return false;
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) return false;

  return expiresAtMs - now > REFRESH_MARGIN_MS;
}

/**
 * Return a copy of `data` carrying the refreshed tokens and the matching
 * expiry. Without `expires_in` the expiry is unknown, so any old value is
 * dropped rather than left describing a different token.
 */
export function withTokens(data: KeyfileData, tokens: TokenSet, now: number = Date.now()): KeyfileData {
  const result: KeyfileData = {
    ...data,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  };
  if (tokens.expires_in) {
    const expiresAtMs = now + tokens.expires_in * 1000;
    // toISOString has milliseconds; the shared contract is second precision.
    result[EXPIRES_AT_KEY] = new Date(expiresAtMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  } else {
    delete result[EXPIRES_AT_KEY];
  }
  return result;
}

/** How long {@link withKeyfileLock} waits for the lock by default, matching the peer scripts. */
export const LOCK_TIMEOUT_MS = 30_000;

/** How often a busy lock is retried, matching the peer scripts. */
const LOCK_POLL_MS = 50;

// flock(2) operations; the same values on darwin, linux and freebsd.
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

/** The libc that exports flock(2) on each supported platform. Anything else fails closed. */
const LIBC_BY_PLATFORM: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "libSystem.B.dylib",
  linux: "libc.so.6",
  freebsd: "libc.so.7",
};

interface FlockBinding {
  flock: (fd: number, operation: number) => number;
  /** errno as left by the last foreign call. */
  errno: () => number;
}

/** Bound flock per libc, loaded on first use so nothing outside local mode ever loads koffi. */
const flockBindings = new Map<string, Promise<FlockBinding>>();

function loadFlock(libc: string): Promise<FlockBinding> {
  let binding = flockBindings.get(libc);
  if (!binding) {
    binding = (async () => {
      const { default: koffi } = await import("koffi");
      const flock = koffi.load(libc).func("int flock(int fd, int operation)");
      return { flock: (fd, operation) => flock(fd, operation) as number, errno: () => koffi.errno() };
    })();
    // Cache successes only, so a failed load is retried rather than remembered.
    binding.catch(() => flockBindings.delete(libc));
    flockBindings.set(libc, binding);
  }
  return binding;
}

function lockUnavailable(platform: string, reason: string, keyfilePath: string): Error {
  return new Error(`keyfile lock unavailable on ${platform}: ${reason}; refusing to refresh ${keyfilePath} without it`);
}

function lockBusy(lockPath: string): Error {
  return new Error(
    `the keyfile lock is busy (${lockPath}); another process is refreshing the token. Try again shortly.`,
  );
}

/** Symbolic name for an errno value, e.g. `EBADF`, or the number when the platform has none. */
function errnoName(code: number): string {
  const entry = Object.entries(osConstants.errno).find(([, value]) => value === code);
  return entry ? entry[0] : String(code);
}

/**
 * FIFO mutex queueing same-process callers on one lock path before flock is
 * tried, so only the head of the queue polls the kernel lock and callers in
 * this process are served in arrival order.
 */
class PathMutex {
  private held = false;
  private readonly waiters: Array<() => void> = [];

  /** True when nobody holds the mutex or waits for it, so it can be dropped. */
  get idle(): boolean {
    return !this.held && this.waiters.length === 0;
  }

  /**
   * Wait for the mutex until `deadline` (epoch ms). A waiter that times out
   * leaves the queue, so the callers behind it are never delayed by it.
   */
  acquire(deadline: number, onTimeout: () => Error): Promise<void> {
    if (!this.held) {
      this.held = true;
      return Promise.resolve();
    }
    return new Promise((resolveAcquire, rejectAcquire) => {
      const waiter = () => {
        clearTimeout(timer);
        resolveAcquire();
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        rejectAcquire(onTimeout());
      }, Math.max(0, deadline - Date.now()));
      this.waiters.push(waiter);
    });
  }

  /** Hand the mutex straight to the next waiter, or free it when none is left. */
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.held = false;
  }
}

/** One mutex per resolved lock path, shared by every caller in this process. */
const pathMutexes = new Map<string, PathMutex>();

/**
 * Run `fn` while holding an exclusive flock(2) on `<keyfilePath>.lock`, the
 * lock the peer scripts take before refreshing (see the module doc).
 * Same-process callers queue on an in-process mutex first; the `timeoutMs`
 * deadline, taken when the call starts, covers that queue and the flock
 * polling together. Fails closed: an unsupported platform, a koffi or libc
 * load failure, a busy lock at the deadline or an unexpected flock errno all
 * throw without running `fn`. The lock file is created 0600 and never removed.
 *
 * `opts.timeoutMs` (default {@link LOCK_TIMEOUT_MS}) and `opts.platform`
 * (default `process.platform`) exist for tests.
 */
export async function withKeyfileLock<T>(
  keyfilePath: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number; platform?: NodeJS.Platform } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? LOCK_TIMEOUT_MS);
  const platform = opts.platform ?? process.platform;
  const lockPath = `${keyfilePath}.lock`;

  // Everything that can fail closed is checked before the filesystem is touched.
  const libc = LIBC_BY_PLATFORM[platform];
  if (!libc) throw lockUnavailable(platform, "unsupported platform", keyfilePath);
  let binding: FlockBinding;
  try {
    binding = await loadFlock(libc);
  } catch (error) {
    throw lockUnavailable(platform, (error as Error).message, keyfilePath);
  }

  const mutexKey = resolve(lockPath);
  let mutex = pathMutexes.get(mutexKey);
  if (!mutex) {
    mutex = new PathMutex();
    pathMutexes.set(mutexKey, mutex);
  }
  await mutex.acquire(deadline, () => lockBusy(lockPath));

  try {
    const handle = await fs.open(lockPath, fsConstants.O_CREAT | fsConstants.O_RDWR, 0o600);
    try {
      await pollFlock(binding, handle.fd, deadline, lockPath, keyfilePath);
      try {
        return await fn();
      } finally {
        // A failed unlock is harmless: closing the fd below releases the lock too.
        try {
          binding.flock(handle.fd, LOCK_UN);
        } catch {
          // ignored by design, so a release failure never masks fn's outcome
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  } finally {
    mutex.release();
    if (mutex.idle) pathMutexes.delete(mutexKey);
  }
}

/** Poll a non-blocking exclusive flock on `fd` until it is taken or `deadline` passes. */
async function pollFlock(
  binding: FlockBinding,
  fd: number,
  deadline: number,
  lockPath: string,
  keyfilePath: string,
): Promise<void> {
  for (;;) {
    if (binding.flock(fd, LOCK_EX | LOCK_NB) === 0) return;
    const errno = binding.errno();
    if (errno !== osConstants.errno.EWOULDBLOCK) {
      throw new Error(
        `flock on ${lockPath} failed (${errnoName(errno)}); refusing to refresh ${keyfilePath} without the lock`,
      );
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lockBusy(lockPath);
    await new Promise<void>((done) => setTimeout(done, Math.min(LOCK_POLL_MS, remaining)));
  }
}
