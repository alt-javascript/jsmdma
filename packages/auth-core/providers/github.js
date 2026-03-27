/**
 * github.js — Arctic provider wrapper for GitHub OAuth 2.0
 *
 * GitHub does not support PKCE or id_token. User info is retrieved
 * via the GitHub API using the access token. Email may be null for
 * users with private email settings — a second call to /user/emails
 * is made to find the primary verified email.
 *
 * Config: { clientId, clientSecret, redirectUri }
 */
import { GitHub, generateState } from 'arctic';
import { ProviderError } from '../errors.js';

export const PROVIDER_NAME = 'github';

export default class GitHubProvider {
  constructor(config) {
    this._client = new GitHub(config.clientId, config.clientSecret, config.redirectUri ?? null);
    // Allow injecting a fetch implementation for testing
    this._fetch = config._fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Generate the authorization URL.
   * codeVerifier is ignored — GitHub does not support PKCE.
   * @param {string} state
   * @returns {URL}
   */
  createAuthorizationURL(state) {
    return this._client.createAuthorizationURL(state, ['user:email']);
  }

  /**
   * Exchange authorization code for tokens and fetch user identity from GitHub API.
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

    const accessToken = tokens.accessToken();

    // Fetch primary user object
    let user;
    try {
      const res = await this._fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent':  'data-api',
          Accept:        'application/vnd.github+json',
        },
      });
      if (!res.ok) throw new Error(`GitHub /user returned ${res.status}`);
      user = await res.json();
    } catch (err) {
      throw new ProviderError(PROVIDER_NAME, `Failed to fetch GitHub user: ${err.message}`);
    }

    let email = typeof user.email === 'string' ? user.email : null;

    // If email is null (private account), try the emails endpoint
    if (email == null) {
      try {
        const res = await this._fetch('https://api.github.com/user/emails', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent':  'data-api',
            Accept:        'application/vnd.github+json',
          },
        });
        if (res.ok) {
          const emails = await res.json();
          const primary = emails.find((e) => e.primary && e.verified);
          email = primary?.email ?? null;
        }
      } catch {
        // Non-fatal — email stays null
      }
    }

    return {
      providerUserId: String(user.id),
      email,
    };
  }
}

export { generateState };
