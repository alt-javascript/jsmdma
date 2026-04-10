import { assert } from 'chai';
import DeviceSession from '../DeviceSession.js';

let _store = {};
const mockStorage = {
  getItem:    (k) => _store[k] ?? null,
  setItem:    (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear:      () => { _store = {}; },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('DeviceSession', () => {
  beforeEach(() => { global.localStorage = mockStorage; });
  afterEach(() => { mockStorage.clear(); });

  it('getDeviceId() creates and returns a UUID on first call', () => {
    const id = DeviceSession.getDeviceId();
    assert.match(id, UUID_RE);
  });

  it('getDeviceId() returns the same UUID on repeated calls', () => {
    const a = DeviceSession.getDeviceId();
    const b = DeviceSession.getDeviceId();
    assert.equal(a, b);
  });

  it('getOrCreateAnonUid() creates and returns a UUID', () => {
    const uid = DeviceSession.getOrCreateAnonUid();
    assert.match(uid, UUID_RE);
  });

  it('getOrCreateAnonUid() returns the same UUID on repeated calls', () => {
    const a = DeviceSession.getOrCreateAnonUid();
    const b = DeviceSession.getOrCreateAnonUid();
    assert.equal(a, b);
  });

  it('clear() removes dev and anon_uid from localStorage', () => {
    DeviceSession.getDeviceId();
    DeviceSession.getOrCreateAnonUid();
    DeviceSession.clear();
    assert.isNull(mockStorage.getItem('dev'));
    assert.isNull(mockStorage.getItem('anon_uid'));
  });
});
