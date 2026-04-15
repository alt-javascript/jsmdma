/**
 * AuthService.js — Orchestrates OAuth flows and user identity management.
 *
 * Responsibilities:
 *   1. Generate OAuth authorization URL + state/codeVerifier for a provider
 *   2. Validate the OAuth callback (state check, code exchange)
 *   3. Upsert user identity (create new or return existing UUID)
 *   4. Issue a signed JWT session token
 *
 * CDI autowiring (by name):
 *   this.userRepository — UserRepository instance
 *   this.jwtSecret      — string secret for JWT signing (from config)
 *   this.logger         — optional logger
 *
 * In tests, inject dependencies directly via the constructor or property assignment.
 */
import { generateState, generateCodeVerifier } from 'arctic';
import { JwtSession, InvalidStateError } from '@alt-javascript/jsmdma-auth-core';

export default class AuthService {
  constructor() {
    this.userRepository  = null; // CDI autowired
    this.jwtSecret       = null; // CDI autowired
    this.logger          = null; // CDI autowired
    this._pendingAuth    = new Map(); // state → { codeVerifier, expiry }
  }

  /**
   * Generate the OAuth authorization URL.
   * Stores codeVerifier server-side — it is NOT returned to the browser.
   *
   * @returns {{ authorizationURL: string, state: string }}
   */
  beginAuth(providerName, providerInstance, options = {}) {
    const state        = generateState();
    const codeVerifier = generateCodeVerifier();
    const url          = providerInstance.createAuthorizationURL(state, codeVerifier);

    // BFF: keep codeVerifier server-side; expires in 10 minutes
    const pending = { codeVerifier, expiry: Date.now() + 10 * 60 * 1000 };
    if (options.link) pending.linkMode = true;
    this._pendingAuth.set(state, pending);

    this.logger?.debug?.(`[AuthService] beginAuth provider=${providerName} state=${state.slice(0, 8)}... link=${!!options.link}`);

    return { authorizationURL: url.toString(), state };
  }

  /**
   * Complete an OAuth callback: validate state from server-side store, exchange code,
   * upsert user, issue JWT.
   *
   * @param {string} providerName
   * @param {Object} providerInstance
   * @param {string} code   — authorization code from Google's callback
   * @param {string} state  — state from Google's callback query string
   * @returns {Promise<{ user: Object, token: string }>}
   * @throws {InvalidStateError} if state is unknown, expired, or already consumed
   */
  async completeAuth(providerName, providerInstance, code, state) {
    const pending = this._pendingAuth.get(state);
    if (!pending || Date.now() > pending.expiry) {
      this._pendingAuth.delete(state);
      this.logger?.warn?.(`[AuthService] unknown/expired state provider=${providerName}`);
      throw new InvalidStateError(`Unknown or expired OAuth state for provider ${providerName}`);
    }
    const { codeVerifier, linkMode } = pending;
    this._pendingAuth.delete(state); // one-time use

    // Link mode: pass the code back to the SPA instead of exchanging it here.
    // The SPA will call POST /auth/link/:provider with the code.
    if (linkMode) {
      this.logger?.debug?.(`[AuthService] completeAuth linkMode — forwarding code to SPA`);
      return { linkMode: true, code, state, codeVerifier };
    }

    const result = await providerInstance.validateCallback(code, codeVerifier);
    const { providerUserId, email } = result;

    const existing = await this.userRepository.findByProvider(providerName, providerUserId);

    let user;
    const isNew = existing == null;

    if (existing) {
      if (email && !existing.email) {
        await this.userRepository.updateEmail(existing.userId, email);
      }
      user = await this.userRepository.getUser(existing.userId);
    } else {
      const userId = globalThis.crypto.randomUUID();
      user = await this.userRepository.create(userId, email, providerName, providerUserId);
    }

    const token = await JwtSession.sign(
      { sub: user.userId, providers: user.providers.map((p) => p.provider), email: user.email ?? null },
      this.jwtSecret,
    );

    this.logger?.info?.(`[AuthService] completeAuth provider=${providerName} userId=${user.userId} new=${isNew}`);

    return { user, token };
  }
}
