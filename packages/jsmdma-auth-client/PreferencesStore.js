/**
 * PreferencesStore.js — Per-user opaque key-value preferences.
 *
 * localStorage key pattern: prefs:<userUuid>
 * set() merges with existing preferences (shallow merge).
 */
export default class PreferencesStore {
  static _key(userUuid) { return `prefs:${userUuid}`; }

  static get(userUuid) {
    try {
      return JSON.parse(localStorage.getItem(this._key(userUuid)) ?? '{}');
    } catch { return {}; }
  }

  static set(userUuid, prefs) {
    const existing = this.get(userUuid);
    localStorage.setItem(this._key(userUuid), JSON.stringify({ ...existing, ...prefs }));
  }

  static clear(userUuid) {
    localStorage.removeItem(this._key(userUuid));
  }
}
