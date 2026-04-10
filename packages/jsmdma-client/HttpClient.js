/**
 * HttpClient.js — Shared fetch wrapper with Bearer token injection and rolling refresh.
 *
 * On every request:
 *   - Injects `Authorization: Bearer <token>` if getToken() returns a non-null string
 *   - After every successful response: checks for X-Auth-Token header; if present,
 *     calls onTokenRefresh(newToken) so the caller can store the refreshed JWT
 *
 * On non-2xx:
 *   - Throws Error with err.status set to the HTTP status code
 */
export default class HttpClient {
  /**
   * @param {{ getToken: () => string|null, onTokenRefresh: (token: string) => void }} options
   */
  constructor({ getToken, onTokenRefresh } = {}) {
    this.getToken = getToken ?? (() => null);
    this.onTokenRefresh = onTokenRefresh ?? (() => {});
  }

  /**
   * Fetch JSON with auth header injected. Handles X-Auth-Token rolling refresh.
   *
   * @param {string} url
   * @param {RequestInit} [options]
   * @returns {Promise<object>}
   * @throws {{ status: number, message: string }} on non-2xx
   */
  async fetchJSON(url, options = {}) {
    const token = this.getToken();
    const headers = {
      Accept: 'application/json',
      ...options.headers,
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (options.body && typeof options.body === 'string') {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    }

    const response = await fetch(url, { ...options, headers });

    // Rolling refresh — store new token transparently
    const newToken = response.headers.get('X-Auth-Token');
    if (newToken) this.onTokenRefresh(newToken);

    if (!response.ok) {
      const err = new Error(`HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }

    return response.json();
  }

  /**
   * POST JSON body to url.
   * @param {string} url
   * @param {object} body
   * @returns {Promise<object>}
   */
  async post(url, body) {
    return this.fetchJSON(url, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * DELETE request to url.
   * @param {string} url
   * @returns {Promise<object>}
   */
  async delete(url) {
    return this.fetchJSON(url, { method: 'DELETE' });
  }
}
