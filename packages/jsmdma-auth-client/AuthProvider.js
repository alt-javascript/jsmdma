/**
 * AuthProvider.js — OAuth sign-in flows for jsmdma applications.
 *
 * Sign-in flow:
 *   1. signIn('google') → fetch GET {apiUrl}auth/google → { authorizationURL, state, codeVerifier }
 *   2. Stores state + codeVerifier in sessionStorage
 *   3. Sets window.location.href → browser redirects to provider
 *   4. After OAuth, Application.js handles ?code=&state= and exchanges for JWT
 *
 * config keys: one entry per provider (google, apple, microsoft), plus `apiUrl`.
 */

const KNOWN_PROVIDERS = new Set(['google', 'apple', 'microsoft']);

export default class AuthProvider {
  constructor(config = {}) {
    this._config = config;
    this._apiUrl = config.apiUrl ?? 'http://127.0.0.1:8081/';
    if (!this._apiUrl.endsWith('/')) this._apiUrl += '/';
  }

  getAvailableProviders() {
    return Object.keys(this._config).filter(k => KNOWN_PROVIDERS.has(k));
  }

  isConfigured() {
    return this.getAvailableProviders().length > 0;
  }

  async signIn(provider) {
    if (!this._config[provider]) {
      throw new Error(`AuthProvider: provider '${provider}' is not configured`);
    }

    const res = await fetch(`${this._apiUrl}auth/${provider}`);
    if (!res.ok) {
      throw new Error(`AuthProvider: server returned ${res.status} for /auth/${provider}`);
    }

    const { authorizationURL, state, codeVerifier } = await res.json();
    if (!authorizationURL) {
      throw new Error(`AuthProvider: no authorizationURL from server for provider '${provider}'`);
    }

    sessionStorage.setItem('oauth_state', state);
    sessionStorage.setItem('oauth_code_verifier', codeVerifier);

    (globalThis.window ?? global).location.href = authorizationURL;

    // This promise never resolves — the page navigates away.
    return new Promise(() => {});
  }

  signOut() {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_provider');
    localStorage.removeItem('auth_time');
  }
}
