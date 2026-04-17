/**
 * namespaceKey.spec.js — Unit tests for namespaceKey()
 */
import { assert } from 'chai';
import { namespaceKey } from '../namespaceKey.js';

describe('namespaceKey()', () => {
  it('produces a colon-separated key from clean segments', () => {
    assert.equal(namespaceKey('user-uuid', 'todo', 'tasks'), 'user-uuid:todo:tasks');
  });

  it('encodes colons in userId', () => {
    const key = namespaceKey('user:with:colons', 'todo', 'tasks');
    assert.equal(key, 'user%3Awith%3Acolons:todo:tasks');
  });

  it('encodes colons in application name', () => {
    const key = namespaceKey('user1', 'app:name', 'col');
    assert.equal(key, 'user1:app%3Aname:col');
  });

  it('encodes colons in collection name', () => {
    const key = namespaceKey('user1', 'myapp', 'col:name');
    assert.equal(key, 'user1:myapp:col%3Aname');
  });

  it('encodes colons in all three segments simultaneously', () => {
    const key = namespaceKey('u:1', 'a:p', 'c:l');
    assert.equal(key, 'u%3A1:a%3Ap:c%3Al');
  });

  it('separator colons are not encoded (only segment colons)', () => {
    const key = namespaceKey('user', 'app', 'col');
    const parts = key.split(':');
    assert.lengthOf(parts, 3, 'exactly 3 colon-separated parts');
    assert.equal(parts[0], 'user');
    assert.equal(parts[1], 'app');
    assert.equal(parts[2], 'col');
  });

  it('produces distinct keys for different users with same app+collection', () => {
    const a = namespaceKey('user-A', 'todo', 'tasks');
    const b = namespaceKey('user-B', 'todo', 'tasks');
    assert.notEqual(a, b);
  });

  it('produces distinct keys for different apps with same user+collection', () => {
    const a = namespaceKey('user', 'todo', 'items');
    const b = namespaceKey('user', 'shopping-list', 'items');
    assert.notEqual(a, b);
  });

  it('coerces non-string arguments to strings', () => {
    assert.doesNotThrow(() => namespaceKey(123, true, null));
  });
});
