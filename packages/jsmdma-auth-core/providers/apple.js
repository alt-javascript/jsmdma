/**
 * apple.js — Arctic provider wrapper for Sign in with Apple
 *
 * Apple is the most complex provider:
 *   1. Client secret is a short-lived JWT signed with an ES256 private key
 *      (not a static string like other providers)
 *   2. Apple only sends the user's email in the id_token on the FIRST login.
 *      Subsequent logins have sub but no email.
 *   3. The private key must be provided as PKCS8 DER (raw binary ArrayBuffer).
 *      If provided as PEM, it is converted automatically.
 *   4. No PKCE — Apple uses a plain state parameter.
 *
 * Config:
 *   clientId:   string  — your App ID (e.g. com.example.app)
 *   teamId:     string  — Apple Developer Team ID (10 chars)
 *   keyId:      string  — Key ID from Apple Developer portal
 *   privateKey: string  — ES256 private key as PEM string
 *   redirectUri: string
 */
import { Apple, generateState, decodeIdToken } from 'arctic';
import { ProviderError } from '../errors.js';

export const PROVIDER_NAME = 'apple';

/**
 * Convert a PEM-encoded PKCS8 private key to a raw DER ArrayBuffer.
 * Arctic's Apple provider requires ArrayBuffer, not a PEM string.
 *
 * @param {string} pem — PEM string (-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----)
 * @returns {ArrayBuffer}
 */
export function pemToDer(pem) {
  const lines = pem
    .replace(/-----BEGIN .*?-----/, '')
    .replace(/-----END .*?-----/, '')
    .replace(/\s+/g, '');

  // Use atob if available (browser/edge), otherwise Buffer (Node)
  let binary;
  if (typeof atob === 'function') {
    const binStr = atob(lines);
    binary = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) {
      binary[i] = binStr.charCodeAt(i);
    }
  } else {
    // Node.js path
    binary = new Uint8Array(Buffer.from(lines, 'base64'));
  }

  return binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
}

export default class AppleProvider {
  constructor(config) {
    const pkcs8Der = pemToDer(config.privateKey);
    this._client = new Apple(
      config.clientId,
      config.teamId,
      config.keyId,
      pkcs8Der,
      config.redirectUri,
    );
  }

  /**
   * Generate the authorization URL.
   * codeVerifier is accepted but unused — Apple does not support PKCE.
   * @param {string} state
   * @returns {URL}
   */
  createAuthorizationURL(state) {
    // Apple requires response_mode=form_post for web; response_type=code
    // Arctic handles this via createAuthorizationURL
    return this._client.createAuthorizationURL(state, ['name', 'email']);
  }

  /**
   * Exchange authorization code for tokens and extract user identity.
   * @param {string} code
   * @returns {Promise<{ providerUserId: string, email: string|null }>}
   */
  async validateCallback(code) {
    let tokens;
    try {
      tokens = await this._client.validateAuthorizationCode(code);
    } catch (err) {
      throw new ProviderError(PROVIDER_NAME, `Token exchange failed: ${err.message}`);
    }

    let claims;
    try {
      claims = decodeIdToken(tokens.idToken());
    } catch (err) {
      throw new ProviderError(PROVIDER_NAME, `Failed to decode id_token: ${err.message}`);
    }

    return {
      providerUserId: String(claims.sub),
      // Apple only sends email on first login; null on subsequent logins
      email: typeof claims.email === 'string' ? claims.email : null,
    };
  }
}

export { generateState };
