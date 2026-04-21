import { assert } from 'chai';
import {
  normalizeSessionModeLiteral,
  resolveSessionMode,
  sessionModeAliases,
} from '../sessionModeContract.js';

function captureError(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

describe('sessionModeContract', () => {
  describe('normalizeSessionModeLiteral()', () => {
    it('normalizes canonical literals and aliases deterministically', () => {
      assert.equal(normalizeSessionModeLiteral('cookie'), 'cookie');
      assert.equal(normalizeSessionModeLiteral('bearer'), 'bearer');
      assert.equal(normalizeSessionModeLiteral('session'), 'cookie');
      assert.equal(normalizeSessionModeLiteral('stateless'), 'bearer');
      assert.equal(normalizeSessionModeLiteral('  SESSION  '), 'cookie');
      assert.equal(normalizeSessionModeLiteral('  STATELESS  '), 'bearer');
    });

    it('rejects unsupported mode literals with typed invalid_state reason', () => {
      const err = captureError(() => normalizeSessionModeLiteral('oauth-cookie')); // unsupported literal

      assert.instanceOf(err, Error);
      assert.equal(err?.code, 'invalid_state');
      assert.equal(err?.reason, 'unsupported_session_mode');
      assert.equal(err?.status, 400);
    });

    it('returns null when mode is missing and allowMissing=true', () => {
      assert.isNull(normalizeSessionModeLiteral(undefined, { allowMissing: true }));
      assert.isNull(normalizeSessionModeLiteral(null, { allowMissing: true }));
    });
  });

  describe('resolveSessionMode()', () => {
    it('enforces explicit mode precedence when both credentials are present', () => {
      const resolved = resolveSessionMode({
        explicitMode: 'session',
        bearerToken: 'bearer-token',
        cookieToken: 'cookie-token',
      });

      assert.deepEqual(resolved, {
        mode: 'cookie',
        source: 'explicit',
        explicit: true,
      });
    });

    it('fails closed on dual credentials without explicit mode', () => {
      const err = captureError(() => resolveSessionMode({
        bearerToken: 'bearer-token',
        cookieToken: 'cookie-token',
      }));

      assert.equal(err?.code, 'invalid_state');
      assert.equal(err?.reason, 'session_mode_mismatch');
      assert.deepEqual(err?.details?.available, ['bearer', 'cookie']);
    });

    it('returns session_required when no credentials are present', () => {
      const err = captureError(() => resolveSessionMode({}));

      assert.equal(err?.code, 'invalid_state');
      assert.equal(err?.reason, 'session_required');
    });

    it('returns session_not_found when explicit mode is provided but matching credential is missing', () => {
      const err = captureError(() => resolveSessionMode({
        explicitMode: 'bearer',
        cookieToken: 'cookie-token',
      }));

      assert.equal(err?.code, 'invalid_state');
      assert.equal(err?.reason, 'session_mode_mismatch');
      assert.equal(err?.details?.expected, 'bearer');
      assert.equal(err?.details?.available, 'cookie');

      const missingCredentialErr = captureError(() => resolveSessionMode({
        explicitMode: 'cookie',
      }));

      assert.equal(missingCredentialErr?.code, 'invalid_state');
      assert.equal(missingCredentialErr?.reason, 'session_not_found');
      assert.equal(missingCredentialErr?.details?.expected, 'cookie');
    });

    it('uses aliases map as a stable shared contract', () => {
      assert.deepEqual(sessionModeAliases(), {
        session: 'cookie',
        stateless: 'bearer',
      });
    });
  });
});
