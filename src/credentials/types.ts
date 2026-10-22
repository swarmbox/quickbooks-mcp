// Credential provider types for QuickBooks OAuth management

/**
 * QuickBooks OAuth credentials structure
 */
export interface QBCredentials {
  client_id: string;
  client_secret: string;
  redirect_url: string;
  access_token: string;
  refresh_token: string;
  company_id?: string; // Stored in credentials for local mode
}

/**
 * Abstract credential provider interface
 * Implemented by AWS and Local providers
 */
export interface CredentialProvider {
  /**
   * Get current OAuth credentials
   */
  getCredentials(): Promise<QBCredentials>;

  /**
   * Credentials with a usable access token, refreshing through `refresh` when
   * this provider's policy says so. `force` names an access token the API just
   * rejected, so the provider refreshes even if the token looks unexpired.
   */
  getFreshCredentials(refresh: TokenRefresher, force?: { rejectedAccessToken: string }): Promise<QBCredentials>;

  /**
   * Save updated credentials (e.g., after an OAuth exchange). `expiresIn` is the
   * access token's lifetime in seconds, for providers that track expiry.
   */
  saveCredentials(credentials: QBCredentials, expiresIn?: number): Promise<void>;

  /**
   * Get the QuickBooks company/realm ID
   */
  getCompanyId(): Promise<string>;

  /**
   * Check if credentials are configured and available
   */
  isConfigured(): Promise<boolean>;
}

/**
 * Credential mode - determines which provider to use
 */
export type CredentialMode = "local" | "aws";

/**
 * Get credential mode from environment
 * Defaults to "local" if not specified
 */
export function getCredentialMode(): CredentialMode {
  const mode = process.env.QBO_CREDENTIAL_MODE?.toLowerCase();
  if (mode === "aws") {
    return "aws";
  }
  return "local";
}

/**
 * Tokens returned by an OAuth refresh. `expires_in` is the access token's
 * lifetime in seconds; it is optional because not every caller knows it.
 */
export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

/**
 * Exchanges the current credentials' refresh token for new tokens. Providers
 * call it when their refresh policy decides a refresh is due.
 */
export type TokenRefresher = (current: QBCredentials) => Promise<TokenSet>;
