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
    this.userRepository = null; // CDI autowired
    this.jwtSecret      = null; // CDI autowired (from config: auth.jwt.secret)
    this.logger         = null; // CDI autowired
  }

  /**
   * Generate the OAuth authorization URL and supporting parameters.
   *
   * @param {string} providerName — e.g. 'google', 'github'
   * @param {Object} providerInstance — one of the auth-core provider wrappers
   * @returns {{ authorizationURL: string, state: string, codeVerifier: string }}
   */
  beginAuth(providerName, providerInstance) {
    const state        = generateState();
    const codeVerifier = generateCodeVerifier();
    const url          = providerInstance.createAuthorizationURL(state, codeVerifier);

    this.logger?.debug?.(`[AuthService] beginAuth provider=${providerName} state=${state.slice(0, 8)}...`);

    return {
      authorizationURL: url.toString(),
      state,
      codeVerifier,
    };
  }

  /**
   * Complete an OAuth callback: validate state, exchange code, upsert user, issue JWT.
   *
   * @param {string} providerName
   * @param {Object} providerInstance
   * @param {string} code           — authorization code from callback
   * @param {string} state          — state from callback query string
   * @param {string} storedState    — state stored server-side (cookie or session) during beginAuth
   * @param {string} codeVerifier   — PKCE verifier stored during beginAuth
   * @returns {Promise<{ user: Object, token: string }>}
   * @throws {InvalidStateError} if state !== storedState
   */
  async completeAuth(providerName, providerInstance, code, state, storedState, codeVerifier) {
    // CSRF protection: reject if state doesn't match
    if (state !== storedState) {
      this.logger?.warn?.(`[AuthService] state mismatch provider=${providerName}`);
      throw new InvalidStateError(`OAuth state mismatch for provider ${providerName}`);
    }

    // Exchange authorization code for tokens and extract identity
    const result = await providerInstance.validateCallback(code, codeVerifier);
    const { providerUserId, email } = result;

    // Look up existing user
    const existing = await this.userRepository.findByProvider(providerName, providerUserId);

    let user;
    const isNew = existing == null;

    if (existing) {
      // Returning user — check if email needs updating (Apple sends email only on first login)
      if (email && !existing.email) {
        await this.userRepository.updateEmail(existing.userId, email);
      }
      user = await this.userRepository.getUser(existing.userId);
    } else {
      // New user — create with a fresh UUID
      const userId = globalThis.crypto.randomUUID();
      user = await this.userRepository.create(userId, email, providerName, providerUserId);
    }

    // Issue JWT
    const token = await JwtSession.sign(
      {
        sub:       user.userId,
        providers: user.providers.map((p) => p.provider),
        email:     user.email ?? null,
      },
      this.jwtSecret,
    );

    this.logger?.info?.(`[AuthService] completeAuth provider=${providerName} userId=${user.userId} new=${isNew}`);

    return { user, token };
  }
}
