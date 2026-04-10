/**
 * ClientAuthSession.js — JWT storage with client-side TTL validation.
 *
 * Does NOT verify the JWT signature (secret is server-only).
 * Decodes the payload using jose's decodeJwt and checks TTL rules.
 *
 * TTL rules (matching jsmdma-auth-server):
 *   Idle: 3 days from iat
 *   Hard: 7 days from iat_session
 *
 * localStorage keys: auth_token, auth_provider, auth_time
 */
import { decodeJwt } from 'jose';

const IDLE_TTL_SECONDS = 3 * 24 * 60 * 60;   // 3 days
const HARD_TTL_SECONDS = 7 * 24 * 60 * 60;   // 7 days

function isExpired(payload) {
  const now = Math.floor(Date.now() / 1000);
  const { iat, iat_session } = payload;
  if (typeof iat !== 'number' || typeof iat_session !== 'number') return true;
  if (now - iat > IDLE_TTL_SECONDS) return true;
  if (now - iat_session > HARD_TTL_SECONDS) return true;
  return false;
}

export default class ClientAuthSession {
  static store(token) {
    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_time', String(Date.now()));
  }

  static getToken() {
    const token = localStorage.getItem('auth_token');
    if (!token) return null;
    try {
      const payload = decodeJwt(token);
      if (isExpired(payload)) return null;
      return token;
    } catch {
      return null;
    }
  }

  static getPayload() {
    const token = this.getToken();
    if (!token) return null;
    try { return decodeJwt(token); } catch { return null; }
  }

  static isSignedIn() {
    return this.getToken() !== null;
  }

  static getUserUuid() {
    return this.getPayload()?.sub ?? null;
  }

  static clear() {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_provider');
    localStorage.removeItem('auth_time');
  }
}
