/**
 * microsoft.js — Arctic provider wrapper for Microsoft Entra ID (Azure AD)
 *
 * Uses PKCE. Returns id_token containing oid (Object ID — stable across tenant)
 * as providerUserId, and email or preferred_username.
 *
 * Config:
 *   clientId, clientSecret, redirectUri
 *   tenant: string — 'common' (default, multi-tenant + personal accounts)
 *                    'organizations' (work/school accounts only)
 *                    'consumers' (personal accounts only)
 *                    or a specific tenant UUID for single-tenant apps
 */
import { MicrosoftEntraId, generateState, generateCodeVerifier, decodeIdToken } from 'arctic';
import { ProviderError } from '../errors.js';

export const PROVIDER_NAME = 'microsoft';

export default class MicrosoftProvider {
  constructor(config) {
    const tenant = config.tenant ?? 'common';
    this._client = new MicrosoftEntraId(tenant, config.clientId, config.clientSecret, config.redirectUri);
  }

  /**
   * Generate the authorization URL.
   * @param {string} state
   * @param {string} codeVerifier — PKCE verifier
   * @returns {URL}
   */
  createAuthorizationURL(state, codeVerifier) {
    return this._client.createAuthorizationURL(state, codeVerifier, ['openid', 'email', 'profile']);
  }

  /**
   * Exchange authorization code for tokens and extract user identity.
   * @param {string} code
   * @param {string} codeVerifier
   * @returns {Promise<{ providerUserId: string, email: string|null }>}
   */
  async validateCallback(code, codeVerifier) {
    let tokens;
    try {
      tokens = await this._client.validateAuthorizationCode(code, codeVerifier);
    } catch (err) {
      throw new ProviderError(PROVIDER_NAME, `Token exchange failed: ${err.message}`);
    }

    let claims;
    try {
      claims = decodeIdToken(tokens.idToken());
    } catch (err) {
      throw new ProviderError(PROVIDER_NAME, `Failed to decode id_token: ${err.message}`);
    }

    // oid (Object ID) is the stable user identifier in Azure AD
    // It remains constant even if the user changes their UPN/email
    const providerUserId = String(claims.oid ?? claims.sub);
    const email = claims.email ?? claims.preferred_username ?? null;

    return {
      providerUserId,
      email: typeof email === 'string' ? email : null,
    };
  }
}

export { generateState, generateCodeVerifier };
