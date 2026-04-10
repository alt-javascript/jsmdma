/**
 * DeviceSession.js — Stable anonymous device UUID management.
 *
 * localStorage keys:
 *   dev      — stable device UUID (one per browser profile, never changes)
 *   anon_uid — anonymous user UUID (cleared on sign-out, recreated on next visit)
 */
export default class DeviceSession {
  static getDeviceId() {
    let id = localStorage.getItem('dev');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('dev', id);
    }
    return id;
  }

  static getOrCreateAnonUid() {
    let uid = localStorage.getItem('anon_uid');
    if (!uid) {
      uid = crypto.randomUUID();
      localStorage.setItem('anon_uid', uid);
    }
    return uid;
  }

  static clear() {
    localStorage.removeItem('dev');
    localStorage.removeItem('anon_uid');
  }
}
