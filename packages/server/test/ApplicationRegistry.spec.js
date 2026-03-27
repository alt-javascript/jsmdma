/**
 * ApplicationRegistry.spec.js — Unit tests for ApplicationRegistry
 */
import { assert } from 'chai';
import ApplicationRegistry from '../ApplicationRegistry.js';

describe('ApplicationRegistry', () => {
  function make(applications) {
    const reg = new ApplicationRegistry();
    reg.applications = applications;
    return reg;
  }

  it('allows a known application', () => {
    const reg = make({ todo: {}, 'shopping-list': {} });
    assert.isTrue(reg.isAllowed('todo'));
    assert.isTrue(reg.isAllowed('shopping-list'));
  });

  it('rejects an unknown application', () => {
    const reg = make({ todo: {} });
    assert.isFalse(reg.isAllowed('unknown-app'));
  });

  it('rejects when applications config is null', () => {
    const reg = make(null);
    assert.isFalse(reg.isAllowed('todo'));
  });

  it('rejects when applications config is undefined', () => {
    const reg = make(undefined);
    assert.isFalse(reg.isAllowed('todo'));
  });

  it('rejects when applications config is not an object', () => {
    const reg = make('bad-value');
    assert.isFalse(reg.isAllowed('todo'));
  });

  it('getApplications returns all configured names', () => {
    const reg = make({ todo: {}, 'shopping-list': {}, notes: {} });
    const apps = reg.getApplications();
    assert.deepEqual(apps.sort(), ['notes', 'shopping-list', 'todo']);
  });

  it('getApplications returns [] when nothing configured', () => {
    const reg = make(null);
    assert.deepEqual(reg.getApplications(), []);
  });

  it('getConfig returns the config block for a known app', () => {
    const cfg = { schema: { type: 'object' } };
    const reg = make({ todo: cfg });
    assert.deepEqual(reg.getConfig('todo'), cfg);
  });

  it('getConfig returns null for an unknown app', () => {
    const reg = make({ todo: {} });
    assert.isNull(reg.getConfig('unknown'));
  });

  it('does not allow prototype pollution via __proto__', () => {
    const reg = make({ todo: {} });
    // '__proto__' is not an own property in a plain object literal
    assert.isFalse(reg.isAllowed('__proto__'));
  });
});
