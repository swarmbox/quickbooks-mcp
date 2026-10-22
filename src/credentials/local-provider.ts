// Local file-based credential provider

import { promises as fs } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import {
  isAccessTokenFresh,
  readKeyfile,
  withKeyfileLock,
  withTokens,
  writeKeyfileAtomic,
  type KeyfileData,
} from "./keyfile.js";
import type { CredentialProvider, QBCredentials, TokenRefresher } from "./types.js";

// Default credential file location
const DEFAULT_CREDENTIAL_PATH = join(homedir(), ".quickbooks-mcp", "credentials.json");

const DEFAULT_REDIRECT_URL = "https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl";

/**
 * The typed credentials a raw keyfile stands for. Env QBO_CLIENT_ID and
 * QBO_CLIENT_SECRET take precedence over the file and redirect_url gets its
 * default, both in memory only: nothing here is ever written back, so env
 * secrets stay out of the keyfile.
 */
function view(raw: KeyfileData): QBCredentials {
  return {
    client_id: process.env.QBO_CLIENT_ID || (raw.client_id as string),
    client_secret: process.env.QBO_CLIENT_SECRET || (raw.client_secret as string),
    redirect_url: (raw.redirect_url as string) || DEFAULT_REDIRECT_URL,
    access_token: raw.access_token as string,
    refresh_token: raw.refresh_token as string,
    company_id: raw.company_id as string | undefined,
  };
}

/**
 * Expand a leading ~ to the user's home directory.
 *
 * A shell expands ~ before the value ever reaches process.env, but this server
 * is normally configured through an MCP client's JSON "env" block, where nothing
 * does — so "~/qb/credentials.json" would otherwise be taken literally and
 * create a "./~/qb" directory. Only a leading ~ is expanded; ~user is left alone
 * because resolving another user's home is not something we can do portably.
 */
function expandHome(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return join(homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Get the credential file path from environment or use default
 */
function getCredentialPath(): string {
  const configured = process.env.QBO_CREDENTIAL_FILE;
  return configured ? expandHome(configured) : DEFAULT_CREDENTIAL_PATH;
}

/**
 * Local file-based credential provider
 * Stores credentials in ~/.quickbooks-mcp/credentials.json by default
 */
export class LocalCredentialProvider implements CredentialProvider {
  // Public so user-facing guidance can name the file actually in use rather
  // than assuming the default — QBO_CREDENTIAL_FILE may point elsewhere, and
  // advice about a path the server is not reading is worse than no advice.
  readonly credentialPath: string;

  constructor() {
    this.credentialPath = getCredentialPath();
  }

  async getCredentials(): Promise<QBCredentials> {
    return view(await readKeyfile(this.credentialPath));
  }

  /**
   * Return credentials whose access token is usable, refreshing at most once
   * across every process that shares the keyfile:
   *
   * 1. Read without the lock. This is safe because every writer replaces the
   *    keyfile by atomic rename, so the read sees a whole file, old or new. A
   *    fresh token with no `force` returns here, so the common case never waits.
   * 2. Otherwise take the keyfile lock and re-read. Another process (or another
   *    caller in this one) may have refreshed while we waited for the lock, and
   *    refreshing again would rotate the refresh token a second time for nothing.
   * 3. With `force`, the API rejected `force.rejectedAccessToken`. If the file
   *    now holds a different, fresh token, someone else already replaced it, so
   *    return that instead of rotating a second time.
   * 4. Otherwise call `refresh` (the only Intuit call, made under the lock) and
   *    persist just the token fields and their expiry, keeping every other key.
   *
   * If Intuit issued new tokens but the write fails, the old refresh token in
   * the file may already be revoked, so the error says to re-authenticate.
   */
  async getFreshCredentials(
    refresh: TokenRefresher,
    force?: { rejectedAccessToken: string },
  ): Promise<QBCredentials> {
    const path = this.credentialPath;
    const unlocked = await readKeyfile(path);
    if (!force && isAccessTokenFresh(unlocked)) return view(unlocked);

    return withKeyfileLock(path, async () => {
      const raw = await readKeyfile(path);
      const rotatedByOther = force !== undefined && raw.access_token !== force.rejectedAccessToken;
      if (isAccessTokenFresh(raw) && (!force || rotatedByOther)) return view(raw);

      const updated = withTokens(raw, await refresh(view(raw)));
      try {
        await writeKeyfileAtomic(path, updated);
      } catch (error) {
        // Only the errno code: the message carries the path, never a token value.
        const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
        throw new Error(
          `Intuit issued a new refresh token but saving it to ${path} failed (${code}); ` +
            "the keyfile still holds the old token, so re-run qbo_authenticate",
        );
      }
      return view(updated);
    });
  }

  /**
   * Merge `credentials` into the keyfile under the lock and record the access
   * token's expiry from `expiresIn` (seconds), or drop it when unknown. Keys
   * this provider doesn't know survive; a missing or unreadable keyfile is
   * replaced, so re-authorizing repairs a corrupt one.
   */
  async saveCredentials(credentials: QBCredentials, expiresIn?: number): Promise<void> {
    const path = this.credentialPath;
    // The directory must exist before the lock file can be created in it.
    await fs.mkdir(dirname(path), { recursive: true });

    await withKeyfileLock(path, async () => {
      let base: KeyfileData;
      try {
        base = await readKeyfile(path);
      } catch {
        base = {};
      }

      const overlay: KeyfileData = { ...base };
      for (const key of ["client_id", "client_secret", "redirect_url", "company_id"] as const) {
        if (credentials[key] !== undefined) overlay[key] = credentials[key];
      }

      await writeKeyfileAtomic(
        path,
        withTokens(overlay, {
          access_token: credentials.access_token,
          refresh_token: credentials.refresh_token,
          expires_in: expiresIn,
        }),
      );
    });
  }

  async getCompanyId(): Promise<string> {
    const credentials = await this.getCredentials();

    if (!credentials.company_id) {
      throw new Error(
        "Company ID not found in credentials. " +
          "Run qbo_authenticate to complete OAuth setup."
      );
    }

    return credentials.company_id;
  }

  async isConfigured(): Promise<boolean> {
    try {
      const credentials = await this.getCredentials();
      return !!(
        credentials.client_id &&
        credentials.client_secret &&
        credentials.access_token &&
        credentials.refresh_token &&
        credentials.company_id
      );
    } catch {
      return false;
    }
  }

  /**
   * Check if client credentials are available (for OAuth flow)
   * Client ID and secret can come from env vars or stored file
   */
  async hasClientCredentials(): Promise<boolean> {
    // Check environment variables first
    if (process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET) {
      return true;
    }

    // Check stored credentials
    try {
      const content = await fs.readFile(this.credentialPath, "utf-8");
      const stored = JSON.parse(content);
      return !!(stored.client_id && stored.client_secret);
    } catch {
      return false;
    }
  }

  /**
   * Get client credentials for OAuth flow
   * Returns null if not available
   */
  async getClientCredentials(): Promise<{ clientId: string; clientSecret: string } | null> {
    const clientId = process.env.QBO_CLIENT_ID;
    const clientSecret = process.env.QBO_CLIENT_SECRET;

    if (clientId && clientSecret) {
      return { clientId, clientSecret };
    }

    // Try to read from file
    try {
      const content = await fs.readFile(this.credentialPath, "utf-8");
      const stored = JSON.parse(content);
      if (stored.client_id && stored.client_secret) {
        return { clientId: stored.client_id, clientSecret: stored.client_secret };
      }
    } catch {
      // File doesn't exist or is invalid
    }

    return null;
  }
}
