import { assert } from 'chai';
import PreferencesStore from '../PreferencesStore.js';

let _store = {};
const mockStorage = {
  getItem:    (k) => _store[k] ?? null,
  setItem:    (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear:      () => { _store = {}; },
};

describe('PreferencesStore', () => {
  const USER_UUID = 'user-prefs-uuid';

  beforeEach(() => { global.localStorage = mockStorage; });
  afterEach(() => { mockStorage.clear(); });

  it('get() returns {} for unknown user', () => {
    assert.deepEqual(PreferencesStore.get(USER_UUID), {});
  });

  it('set() writes preferences for a user', () => {
    PreferencesStore.set(USER_UUID, { theme: 'ink', dark: false });
    assert.deepEqual(PreferencesStore.get(USER_UUID), { theme: 'ink', dark: false });
  });

  it('set() merges with existing preferences (does not wipe)', () => {
    PreferencesStore.set(USER_UUID, { theme: 'ink', dark: false });
    PreferencesStore.set(USER_UUID, { lang: 'en' });
    const prefs = PreferencesStore.get(USER_UUID);
    assert.equal(prefs.theme, 'ink');
    assert.equal(prefs.dark, false);
    assert.equal(prefs.lang, 'en');
  });

  it('set() overwrites an existing key', () => {
    PreferencesStore.set(USER_UUID, { dark: false });
    PreferencesStore.set(USER_UUID, { dark: true });
    assert.equal(PreferencesStore.get(USER_UUID).dark, true);
  });

  it('clear() removes preferences for the user', () => {
    PreferencesStore.set(USER_UUID, { theme: 'ink' });
    PreferencesStore.clear(USER_UUID);
    assert.deepEqual(PreferencesStore.get(USER_UUID), {});
  });

  it('different users have isolated preferences', () => {
    PreferencesStore.set('user-a', { theme: 'ink' });
    PreferencesStore.set('user-b', { theme: 'crisp' });
    assert.equal(PreferencesStore.get('user-a').theme, 'ink');
    assert.equal(PreferencesStore.get('user-b').theme, 'crisp');
  });
});
