/**
 * OrgRepository.spec.js — Unit tests for OrgRepository
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { DriverManager } from '@alt-javascript/jsnosqlc-core';
import OrgRepository from '../OrgRepository.js';

async function makeRepo() {
  const client = await DriverManager.getClient('jsnosqlc:memory:');
  return new OrgRepository(client);
}

describe('OrgRepository', () => {

  // ── org operations ────────────────────────────────────────────────────────

  it('createOrg + getOrg round-trip', async () => {
    const repo = await makeRepo();
    const org  = await repo.createOrg('org-1', 'Acme Corp', 'user-alice');
    assert.equal(org.orgId,     'org-1');
    assert.equal(org.name,      'Acme Corp');
    assert.equal(org.createdBy, 'user-alice');
    assert.isString(org.createdAt);

    const fetched = await repo.getOrg('org-1');
    assert.deepEqual(fetched, org);
  });

  it('getOrg returns null for unknown orgId', async () => {
    const repo = await makeRepo();
    assert.isNull(await repo.getOrg('no-such-org'));
  });

  // ── member operations ─────────────────────────────────────────────────────

  it('createMember + getMember round-trip', async () => {
    const repo = await makeRepo();
    await repo.createOrg('org-1', 'Acme', 'user-alice');
    const m = await repo.createMember('org-1', 'user-alice', 'org-admin');

    assert.equal(m.orgId,  'org-1');
    assert.equal(m.userId, 'user-alice');
    assert.equal(m.role,   'org-admin');
    assert.isString(m.joinedAt);

    const fetched = await repo.getMember('org-1', 'user-alice');
    assert.deepEqual(fetched, m);
  });

  it('getMember returns null for unknown member', async () => {
    const repo = await makeRepo();
    assert.isNull(await repo.getMember('org-1', 'no-such-user'));
  });

  it('removeMember removes the record; getMember returns null after', async () => {
    const repo = await makeRepo();
    await repo.createOrg('org-1', 'Acme', 'user-alice');
    await repo.createMember('org-1', 'user-bob', 'member');

    await repo.removeMember('org-1', 'user-bob');
    assert.isNull(await repo.getMember('org-1', 'user-bob'));
  });

  it('setMemberRole updates role; getMember reflects change', async () => {
    const repo = await makeRepo();
    await repo.createOrg('org-1', 'Acme', 'user-alice');
    await repo.createMember('org-1', 'user-bob', 'member');

    const updated = await repo.setMemberRole('org-1', 'user-bob', 'org-admin');
    assert.equal(updated.role, 'org-admin');

    const fetched = await repo.getMember('org-1', 'user-bob');
    assert.equal(fetched.role, 'org-admin');
  });

  it('setMemberRole throws if member not found', async () => {
    const repo = await makeRepo();
    await assert.isRejected?.(
      repo.setMemberRole('org-x', 'no-user', 'member'),
    ) ?? await (async () => {
      let threw = false;
      try { await repo.setMemberRole('org-x', 'no-user', 'member'); }
      catch { threw = true; }
      assert.isTrue(threw, 'should throw for unknown member');
    })();
  });

  // ── findOrgsByUser ────────────────────────────────────────────────────────

  it('findOrgsByUser returns all orgs a user is a member of', async () => {
    const repo = await makeRepo();
    await repo.createOrg('org-1', 'Alpha', 'user-alice');
    await repo.createOrg('org-2', 'Beta',  'user-alice');
    await repo.createMember('org-1', 'user-alice', 'org-admin');
    await repo.createMember('org-2', 'user-alice', 'member');

    const memberships = await repo.findOrgsByUser('user-alice');
    assert.lengthOf(memberships, 2);
    const orgIds = memberships.map((m) => m.orgId).sort();
    assert.deepEqual(orgIds, ['org-1', 'org-2']);
  });

  it('findOrgsByUser returns empty array for unknown user', async () => {
    const repo = await makeRepo();
    const result = await repo.findOrgsByUser('nobody');
    assert.isArray(result);
    assert.isEmpty(result);
  });

  it('findOrgsByUser returns only the target user\'s memberships', async () => {
    const repo = await makeRepo();
    await repo.createOrg('org-1', 'Alpha', 'user-alice');
    await repo.createMember('org-1', 'user-alice', 'org-admin');
    await repo.createMember('org-1', 'user-bob',   'member');

    const aliceMemberships = await repo.findOrgsByUser('user-alice');
    assert.lengthOf(aliceMemberships, 1);
    assert.equal(aliceMemberships[0].userId, 'user-alice');
  });

  // ── getOrgMembers ─────────────────────────────────────────────────────────

  it('getOrgMembers returns all members of an org', async () => {
    const repo = await makeRepo();
    await repo.createOrg('org-1', 'Alpha', 'user-alice');
    await repo.createMember('org-1', 'user-alice', 'org-admin');
    await repo.createMember('org-1', 'user-bob',   'member');
    await repo.createMember('org-1', 'user-carol',  'member');

    const members = await repo.getOrgMembers('org-1');
    assert.lengthOf(members, 3);
    const userIds = members.map((m) => m.userId).sort();
    assert.deepEqual(userIds, ['user-alice', 'user-bob', 'user-carol']);
  });

  it('getOrgMembers returns empty array for org with no members', async () => {
    const repo = await makeRepo();
    await repo.createOrg('org-empty', 'Empty', 'user-x');
    const members = await repo.getOrgMembers('org-empty');
    assert.isArray(members);
    assert.isEmpty(members);
  });

  it('getOrgMembers does not return members of other orgs', async () => {
    const repo = await makeRepo();
    await repo.createOrg('org-1', 'Alpha', 'user-alice');
    await repo.createOrg('org-2', 'Beta',  'user-bob');
    await repo.createMember('org-1', 'user-alice', 'org-admin');
    await repo.createMember('org-2', 'user-bob',   'org-admin');

    const members = await repo.getOrgMembers('org-1');
    assert.lengthOf(members, 1);
    assert.equal(members[0].userId, 'user-alice');
  });

});
