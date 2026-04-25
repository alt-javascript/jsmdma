import { OAuthSessionEngine } from '@alt-javascript/boot-oauth-core';

export const TEST_JWT_SECRET = 'jsmdma-test-secret-at-least-32-chars!!';

const _engine = new OAuthSessionEngine({ secret: TEST_JWT_SECRET });

export function mintTestToken(overrides = {}) {
  return _engine.sign({
    userId:          overrides.userId          ?? 'test-user-id',
    provider:        overrides.provider        ?? 'github',
    providerUserId:  overrides.providerUserId  ?? 'test-provider-user-id',
    email:           overrides.email           ?? 'test@example.com',
    intent:          overrides.intent          ?? 'signin',
    mode:            overrides.mode            ?? 'bearer',
    ...overrides,
  });
}

export class TestOAuthSessionEngine {
  constructor() {
    this._engine = new OAuthSessionEngine({ secret: TEST_JWT_SECRET });
  }

  sign(claims) {
    return this._engine.sign(claims);
  }

  verify(token) {
    return this._engine.verify(token);
  }

  needsRefresh(token) {
    return this._engine.needsRefresh(token);
  }

  refresh(token) {
    return this._engine.refresh(token);
  }
}
