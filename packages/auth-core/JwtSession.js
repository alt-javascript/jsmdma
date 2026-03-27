/**
 * JwtSession.js — Stateless JWT session engine
 *
 * Issues and verifies HS256 JWTs with:
 *   - Idle TTL: 3 days (time since last token issue)
 *   - Hard TTL: 7 days (time since session started)
 *   - Rolling refresh: when iat is >1h old, middleware should issue a new token
 *     with the same iat_session (session continuity) and fresh iat (idle reset)
 *
 * Uses jose for JWT operations — runtime-agnostic (Node, browser, edge).
 *
 * Token payload shape:
 *   {
 *     sub:         string,    — user UUID
 *     providers:   string[],  — list of linked provider names
 *     iat:         number,    — issued-at (Unix seconds); updated on each refresh
 *     iat_session: number,    — session start (Unix seconds); fixed for the session lifetime
 *   }
 */
import { SignJWT, jwtVerify } from 'jose';
import { InvalidTokenError, IdleExpiredError, HardExpiredError } from './errors.js';

const IDLE_TTL_SECONDS  = 3 * 24 * 60 * 60; // 3 days
const HARD_TTL_SECONDS  = 7 * 24 * 60 * 60; // 7 days
const REFRESH_WINDOW    = 60 * 60;           // 1 hour — refresh if older than this

/**
 * Encode a string secret to a Uint8Array key for jose.
 * jose requires a Uint8Array for HMAC secrets.
 */
function encodeSecret(secret) {
  if (secret instanceof Uint8Array) return secret;
  return new TextEncoder().encode(secret);
}

/**
 * Sign a new JWT session token.
 *
 * @param {{ sub: string, providers: string[], [key: string]: any }} payload
 * @param {string | Uint8Array} secret
 * @param {{ iatSession?: number }} [options] — pass existing iatSession for refresh
 * @returns {Promise<string>} signed JWT
 */
async function sign(payload, secret, options = {}) {
  const now = Math.floor(Date.now() / 1000);
  const iatSession = options.iatSession ?? now;

  const key = encodeSecret(secret);

  return new SignJWT({ ...payload, iat_session: iatSession })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setSubject(payload.sub)
    .sign(key);
}

/**
 * Verify a JWT session token and enforce idle + hard TTL.
 *
 * @param {string} token
 * @param {string | Uint8Array} secret
 * @returns {Promise<Object>} decoded payload
 * @throws {InvalidTokenError} bad signature or malformed
 * @throws {IdleExpiredError}  now - iat > 3 days
 * @throws {HardExpiredError}  now - iat_session > 7 days
 */
async function verify(token, secret) {
  const key = encodeSecret(secret);

  let payload;
  try {
    // Disable jose's built-in exp check — we manage TTL ourselves via iat/iat_session
    const result = await jwtVerify(token, key, { clockTolerance: Infinity });
    payload = result.payload;
  } catch (err) {
    throw new InvalidTokenError(`Token verification failed: ${err.message}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const iat = payload.iat;
  const iatSession = payload.iat_session;

  if (typeof iat !== 'number' || typeof iatSession !== 'number') {
    throw new InvalidTokenError('Token missing iat or iat_session fields');
  }

  // Hard TTL check first (session start is the outer bound)
  if (now - iatSession > HARD_TTL_SECONDS) {
    throw new HardExpiredError(`Session started ${Math.floor((now - iatSession) / 86400)} days ago (hard limit: 7 days)`);
  }

  // Idle TTL check (time since last token issue)
  if (now - iat > IDLE_TTL_SECONDS) {
    throw new IdleExpiredError(`Token idle for ${Math.floor((now - iat) / 86400)} days (idle limit: 3 days)`);
  }

  return payload;
}

/**
 * Check whether a verified payload warrants a rolling refresh.
 *
 * @param {Object} payload — verified JWT payload (from verify())
 * @returns {boolean}
 */
function needsRefresh(payload) {
  const now = Math.floor(Date.now() / 1000);
  return (now - payload.iat) > REFRESH_WINDOW;
}

/**
 * Issue a refreshed token: same iat_session (session continuity), fresh iat (idle reset).
 * Preserves all other payload fields.
 *
 * @param {Object} payload — verified JWT payload
 * @param {string | Uint8Array} secret
 * @returns {Promise<string>} new signed JWT
 */
async function refresh(payload, secret) {
  // Extract fields we want to carry forward
  const { sub, providers, iat_session, iat: _oldIat, ...rest } = payload;
  return sign({ sub, providers, ...rest }, secret, { iatSession: iat_session });
}

const JwtSession = { sign, verify, needsRefresh, refresh };

export default JwtSession;
