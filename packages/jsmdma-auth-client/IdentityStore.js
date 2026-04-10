/**
 * IdentityStore.js — Persistent list of user identities.
 *
 * localStorage key: ids
 * Format: JSON array of { uuid, name, provider, email }
 */
export default class IdentityStore {
  static _key = 'ids';

  static getAll() {
    try {
      return JSON.parse(localStorage.getItem(this._key) ?? '[]');
    } catch { return []; }
  }

  static upsert(identity) {
    const all = this.getAll();
    const idx = all.findIndex(i => i.uuid === identity.uuid);
    if (idx >= 0) all[idx] = identity;
    else all.push(identity);
    localStorage.setItem(this._key, JSON.stringify(all));
  }

  static remove(uuid) {
    const filtered = this.getAll().filter(i => i.uuid !== uuid);
    localStorage.setItem(this._key, JSON.stringify(filtered));
  }

  static clear() {
    localStorage.removeItem(this._key);
  }
}
