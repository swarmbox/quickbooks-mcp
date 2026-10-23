// QuickBooks client authentication and session management

import QuickBooks from "node-quickbooks";
import { getCredentialProvider, isLocalMode } from "../credentials/index.js";
import type { QBCredentials, CredentialProvider } from "../credentials/index.js";
import type { TokenRefresher, TokenSet } from "../credentials/types.js";
import { refreshAccessToken as refreshAccessTokenWithOAuthClient } from "../credentials/oauth-client.js";
import { promisify } from "./promisify.js";
import { clearLookupCache } from "./cache.js";

// Sandbox mode for development/testing
const useSandbox = process.env.QBO_SANDBOX === "true";

// QuickBooks client and credentials state
let qbo: QuickBooks | null = null;
let credentials: QBCredentials | null = null;
let companyId: string | null = null;
let provider: CredentialProvider | null = null;

// Export companyId getter for tools that need it
export function getCompanyIdValue(): string | null {
  return companyId;
}

// Access token the API just rejected, recorded by clearCredentialsCache and
// consumed by the next createClient so the provider refreshes once even if the
// token still looks unexpired.
let pendingForce: { rejectedAccessToken: string } | null = null;

// Clear cached credentials (call on auth errors to force fresh fetch). The
// token in use is remembered as rejected, so the next client forces one refresh
// unless another process has already replaced it.
export function clearCredentialsCache(): void {
  if (credentials) {
    pendingForce = { rejectedAccessToken: credentials.access_token };
  }
  qbo = null;
  credentials = null;
  clearLookupCache();
}

// Check if error is an authentication failure.
//
// The classification itself lives in utils/errors.ts next to the fault
// extraction it depends on; it is re-exported here because this is where the
// credential cache it drives lives, and because importing this module drags in
// the whole credential provider chain.
export { isAuthFault as isAuthError } from "../utils/errors.js";

function buildClient(creds: QBCredentials, realmId: string): QuickBooks {
  return new QuickBooks(
    creds.client_id,
    creds.client_secret,
    creds.access_token,
    false, // No OAuth 1.0 token secret for OAuth 2.0
    realmId,
    useSandbox, // Use sandbox if QBO_SANDBOX=true
    false, // Debug mode off
    null,  // Use latest minor version
    "2.0", // OAuth 2.0
    creds.refresh_token
  );
}

/**
 * Exchange the current refresh token for new tokens. The providers decide when
 * to call this; it only performs the exchange.
 *
 * node-quickbooks goes first. In local mode intuit-oauth is the fallback, and
 * when both fail the original error is rethrown. It is never logged or
 * serialized: raw QBO errors can carry the request's Authorization header.
 */
export const refreshTokens: TokenRefresher = async (current) => {
  try {
    const tokenInfo = await promisify<TokenSet>((cb) =>
      buildClient(current, current.company_id ?? "").refreshAccessToken(cb)
    );
    return {
      access_token: tokenInfo.access_token,
      refresh_token: tokenInfo.refresh_token,
      expires_in: tokenInfo.expires_in,
    };
  } catch (refreshError) {
    if (!isLocalMode()) {
      throw refreshError;
    }
    try {
      return await refreshAccessTokenWithOAuthClient(current);
    } catch {
      // If both methods fail, throw the original error
      throw refreshError;
    }
  }
};

/**
 * Build a QuickBooks client from fresh credentials. getClient() delegates here;
 * it is exported as the test seam so the forced-refresh hand-off can be driven
 * with a stub provider and refresher, with no keyfile or network involved.
 */
export async function createClient(
  credentialProvider: CredentialProvider,
  refresh: TokenRefresher
): Promise<QuickBooks> {
  // Check if credentials are configured
  const isConfigured = await credentialProvider.isConfigured();
  if (!isConfigured) {
    if (isLocalMode()) {
      throw new Error(
        "QuickBooks credentials not configured. Run the qbo_authenticate tool to set up OAuth."
      );
    } else {
      throw new Error(
        "QuickBooks credentials not found in AWS. Check your AWS Secrets Manager and SSM Parameter Store configuration."
      );
    }
  }

  // A recorded auth fault forces exactly one refresh
  const force = pendingForce ?? undefined;
  pendingForce = null;

  // The provider decides whether the stored access token is still usable
  credentials = await credentialProvider.getFreshCredentials(refresh, force);

  // Load company ID from provider if not cached
  if (!companyId) {
    companyId = await credentialProvider.getCompanyId();
  }

  qbo = buildClient(credentials, companyId);
  return qbo;
}

// Initialize or refresh the QuickBooks session
export async function getClient(): Promise<QuickBooks> {
  // Get credential provider (singleton)
  provider ??= getCredentialProvider();
  return createClient(provider, refreshTokens);
}
