/**
 * JwtSession.spec.js — Mocha tests for JwtSession
 *
 * To test TTL expiry without real time passing, we manually craft JWTs
 * with past iat/iat_session values using jose's SignJWT directly.
 */
import { assert } from 'chai';
import { SignJWT } from 'jose';
import JwtSession from '../JwtSession.js';
import { InvalidTokenError, IdleExpiredError, HardExpiredError } from '../errors.js';

const SECRET = 'test-secret-must-be-at-least-32-chars!!';
const KEY    = new TextEncoder().encode(SECRET);

const PAYLOAD = { sub: 'user-uuid-1', providers: ['github'] };

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Craft a JWT with arbitrary iat and iat_session (bypassing JwtSession.sign).
 * Used to simulate tokens issued at specific times in the past.
 */
async function craftToken({ iat, iatSession, sub = 'test-user', providers = ['github'] }) {
  return new SignJWT({ sub, providers, iat_session: iatSession })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(iat)
    .setSubject(sub)
    .sign(KEY);
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ── sign() ───────────────────────────────────────────────────────────────────

describe('JwtSession', () => {

  describe('sign()', () => {
    it('returns a JWT string', async () => {
      const token = await JwtSession.sign(PAYLOAD, SECRET);
      assert.isString(token);
      assert.include(token, '.'); // JWT has dots
    });

    it('includes iat in the payload', async () => {
      const before = nowSec();
      const token  = await JwtSession.sign(PAYLOAD, SECRET);
      const p      = await JwtSession.verify(token, SECRET);
      assert.isAtLeast(p.iat, before);
    });

    it('includes iat_session equal to iat for a fresh token', async () => {
      const token = await JwtSession.sign(PAYLOAD, SECRET);
      const p     = await JwtSession.verify(token, SECRET);
      assert.equal(p.iat, p.iat_session);
    });

    it('preserves iatSession from options (for refresh)', async () => {
      const oldSession = nowSec() - 3600;
      const token = await JwtSession.sign(PAYLOAD, SECRET, { iatSession: oldSession });
      const p     = await JwtSession.verify(token, SECRET);
      assert.equal(p.iat_session, oldSession);
    });

    it('preserves sub and providers', async () => {
      const token = await JwtSession.sign({ sub: 'abc', providers: ['google', 'github'] }, SECRET);
      const p     = await JwtSession.verify(token, SECRET);
      assert.equal(p.sub, 'abc');
      assert.deepEqual(p.providers, ['google', 'github']);
    });
  });

  // ── verify() ─────────────────────────────────────────────────────────────────

  describe('verify()', () => {
    it('returns payload for a valid token', async () => {
      const token = await JwtSession.sign(PAYLOAD, SECRET);
      const p     = await JwtSession.verify(token, SECRET);
      assert.equal(p.sub, PAYLOAD.sub);
    });

    it('throws InvalidTokenError for a bad signature', async () => {
      const token = await JwtSession.sign(PAYLOAD, SECRET);
      try {
        await JwtSession.verify(token, 'wrong-secret-also-at-least-32-chars!!');
        assert.fail('should have thrown');
      } catch (err) {
        assert.instanceOf(err, InvalidTokenError);
      }
    });

    it('throws InvalidTokenError for a malformed token', async () => {
      try {
        await JwtSession.verify('not.a.jwt', SECRET);
        assert.fail('should have thrown');
      } catch (err) {
        assert.instanceOf(err, InvalidTokenError);
      }
    });

    it('throws IdleExpiredError when iat is > 3 days ago', async () => {
      const threeDaysAgoPlus = nowSec() - (3 * 24 * 60 * 60 + 60); // 3 days + 1 min
      const token = await craftToken({ iat: threeDaysAgoPlus, iatSession: threeDaysAgoPlus });
      try {
        await JwtSession.verify(token, SECRET);
        assert.fail('should have thrown IdleExpiredError');
      } catch (err) {
        assert.instanceOf(err, IdleExpiredError, `expected IdleExpiredError, got ${err.constructor.name}: ${err.message}`);
      }
    });

    it('does not throw IdleExpiredError when iat is < 3 days ago', async () => {
      const twoDaysAgo = nowSec() - (2 * 24 * 60 * 60);
      // iat_session must also be recent enough (< 7 days) — use same value here
      const token = await craftToken({ iat: twoDaysAgo, iatSession: twoDaysAgo });
      const p = await JwtSession.verify(token, SECRET);
      assert.equal(p.sub, 'test-user');
    });

    it('throws HardExpiredError when iat_session is > 7 days ago', async () => {
      const sevenDaysAgoPlus = nowSec() - (7 * 24 * 60 * 60 + 60); // 7 days + 1 min
      // iat is recent (token was "refreshed" today) but session is old
      const token = await craftToken({ iat: nowSec(), iatSession: sevenDaysAgoPlus });
      try {
        await JwtSession.verify(token, SECRET);
        assert.fail('should have thrown HardExpiredError');
      } catch (err) {
        assert.instanceOf(err, HardExpiredError, `expected HardExpiredError, got ${err.constructor.name}: ${err.message}`);
      }
    });

    it('does not throw HardExpiredError when iat_session is < 7 days ago', async () => {
      const sixDaysAgo = nowSec() - (6 * 24 * 60 * 60);
      // iat is recent (refreshed today) — only iatSession is old; should NOT throw
      const token = await craftToken({ iat: nowSec(), iatSession: sixDaysAgo });
      const p = await JwtSession.verify(token, SECRET);
      assert.equal(p.sub, 'test-user');
    });

    it('checks HardExpiredError before IdleExpiredError (hard is outer bound)', async () => {
      // Both expired: session > 7d, idle > 3d — HardExpiredError should win
      const eightDaysAgo = nowSec() - (8 * 24 * 60 * 60);
      const token = await craftToken({ iat: eightDaysAgo, iatSession: eightDaysAgo });
      try {
        await JwtSession.verify(token, SECRET);
        assert.fail('should have thrown');
      } catch (err) {
        assert.instanceOf(err, HardExpiredError, `expected HardExpiredError, got ${err.constructor.name}`);
      }
    });
  });

  // ── needsRefresh() ───────────────────────────────────────────────────────────

  describe('needsRefresh()', () => {
    it('returns false when iat is recent (< 1 hour ago)', async () => {
      const token = await JwtSession.sign(PAYLOAD, SECRET);
      const p     = await JwtSession.verify(token, SECRET);
      assert.isFalse(JwtSession.needsRefresh(p));
    });

    it('returns true when iat is > 1 hour ago', () => {
      const fakePayload = { iat: nowSec() - (60 * 60 + 60), iat_session: nowSec() };
      assert.isTrue(JwtSession.needsRefresh(fakePayload));
    });

    it('returns false when iat is exactly at the refresh boundary', () => {
      // Exactly 1h old — boundary case; should be false (> not >=)
      const fakePayload = { iat: nowSec() - 3600, iat_session: nowSec() };
      assert.isFalse(JwtSession.needsRefresh(fakePayload));
    });
  });

  // ── refresh() ────────────────────────────────────────────────────────────────

  describe('refresh()', () => {
    it('returns a new valid token', async () => {
      const token   = await JwtSession.sign(PAYLOAD, SECRET);
      const payload = await JwtSession.verify(token, SECRET);
      const newTok  = await JwtSession.refresh(payload, SECRET);
      assert.isString(newTok);
      // Both tokens may be identical if issued in the same second (same iat)
      // — correctness proven by the iat_session and payload preservation tests
    });

    it('preserves iat_session from original payload', async () => {
      const oldSession = nowSec() - 3600;
      const token      = await JwtSession.sign(PAYLOAD, SECRET, { iatSession: oldSession });
      const payload    = await JwtSession.verify(token, SECRET);
      const newTok     = await JwtSession.refresh(payload, SECRET);
      const newPayload = await JwtSession.verify(newTok, SECRET);
      assert.equal(newPayload.iat_session, oldSession);
    });

    it('updates iat to current time', async () => {
      const before  = nowSec();
      const token   = await JwtSession.sign(PAYLOAD, SECRET);
      const payload = await JwtSession.verify(token, SECRET);
      const newTok  = await JwtSession.refresh(payload, SECRET);
      const newP    = await JwtSession.verify(newTok, SECRET);
      assert.isAtLeast(newP.iat, before);
    });

    it('preserves sub and providers', async () => {
      const token   = await JwtSession.sign({ sub: 'xyz', providers: ['apple'] }, SECRET);
      const payload = await JwtSession.verify(token, SECRET);
      const newTok  = await JwtSession.refresh(payload, SECRET);
      const newP    = await JwtSession.verify(newTok, SECRET);
      assert.equal(newP.sub, 'xyz');
      assert.deepEqual(newP.providers, ['apple']);
    });

    it('new token verifies successfully with same secret', async () => {
      const token   = await JwtSession.sign(PAYLOAD, SECRET);
      const payload = await JwtSession.verify(token, SECRET);
      const newTok  = await JwtSession.refresh(payload, SECRET);
      const newP    = await JwtSession.verify(newTok, SECRET);
      assert.equal(newP.sub, PAYLOAD.sub);
    });
  });

});
