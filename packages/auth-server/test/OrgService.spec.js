/**
 * OrgService.spec.js — Unit tests for OrgService
 */
import { assert } from 'chai';
import '@alt-javascript/jsnosqlc-memory';
import { DriverManager } from '@alt-javascript/jsnosqlc-core';
import OrgRepository from '../OrgRepository.js';
import UserRepository from '../UserRepository.js';
import OrgService from '../OrgService.js';
import {
  OrgNotFoundError,
  NotOrgAdminError,
  LastAdminError,
  AlreadyMemberError,
  NotMemberError,
} from '../orgErrors.js';

// ── helpers ───────────────────────────────────────────────────────────────────

async function buildService() {
  const client  = await DriverManager.getClient('jsnosqlc:memory:');
  const orgRepo  = new OrgRepository(client);
  const userRepo = new UserRepository(client);
  const svc      = new OrgService();
  svc.orgRepository  = orgRepo;
  svc.userRepository = userRepo;
  return { svc, orgRepo, userRepo };
}

async function throwsTyped(fn, ErrorClass) {
  let caught = null;
  try { await fn(); } catch (e) { caught = e; }
  assert.instanceOf(caught, ErrorClass, `Expected ${ErrorClass.name}, got ${caught?.constructor?.name}: ${caught?.message}`);
  return caught;
}

// ── seed helpers ──────────────────────────────────────────────────────────────

async function seedUser(userRepo, userId) {
  // Insert a minimal user record directly via repo
  await userRepo._users().store(userId, { userId, email: `${userId}@test.com`, providers: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('OrgService', () => {

  // ── createOrg ─────────────────────────────────────────────────────────────

  it('createOrg returns org + membership; caller is org-admin', async () => {
    const { svc, userRepo } = await buildService();
    await seedUser(userRepo, 'alice');

    const { org, membership } = await svc.createOrg('alice', 'Acme Corp');

    assert.isString(org.orgId);
    assert.equal(org.name,      'Acme Corp');
    assert.equal(org.createdBy, 'alice');

    assert.equal(membership.userId, 'alice');
    assert.equal(membership.orgId,  org.orgId);
    assert.equal(membership.role,   'org-admin');
  });

  // ── addMember ─────────────────────────────────────────────────────────────

  it('addMember: valid call returns member record with role member', async () => {
    const { svc, userRepo } = await buildService();
    await seedUser(userRepo, 'alice');
    await seedUser(userRepo, 'bob');

    const { org } = await svc.createOrg('alice', 'Acme');
    const member  = await svc.addMember('alice', org.orgId, 'bob');

    assert.equal(member.userId, 'bob');
    assert.equal(member.role,   'member');
  });

  it('addMember: throws NotOrgAdminError when caller is not org-admin', async () => {
    const { svc, userRepo } = await buildService();
    await seedUser(userRepo, 'alice');
    await seedUser(userRepo, 'bob');
    await seedUser(userRepo, 'carol');

    const { org } = await svc.createOrg('alice', 'Acme');
    await svc.addMember('alice', org.orgId, 'bob'); // bob is member

    await throwsTyped(() => svc.addMember('bob', org.orgId, 'carol'), NotOrgAdminError);
  });

  it('addMember: throws AlreadyMemberError when target already a member', async () => {
    const { svc, userRepo } = await buildService();
    await seedUser(userRepo, 'alice');
    await seedUser(userRepo, 'bob');

    const { org } = await svc.createOrg('alice', 'Acme');
    await svc.addMember('alice', org.orgId, 'bob');

    await throwsTyped(() => svc.addMember('alice', org.orgId, 'bob'), AlreadyMemberError);
  });

  it('addMember: throws OrgNotFoundError for unknown org', async () => {
    const { svc, userRepo } = await buildService();
    await seedUser(userRepo, 'alice');
    await seedUser(userRepo, 'bob');

    await throwsTyped(() => svc.addMember('alice', 'no-such-org', 'bob'), OrgNotFoundError);
  });

  // ── removeMember ──────────────────────────────────────────────────────────

  it('removeMember: valid call removes member', async () => {
    const { svc, userRepo, orgRepo } = await buildService();
    await seedUser(userRepo, 'alice');
    await seedUser(userRepo, 'bob');

    const { org } = await svc.createOrg('alice', 'Acme');
    await svc.addMember('alice', org.orgId, 'bob');
    await svc.removeMember('alice', org.orgId, 'bob');

    assert.isNull(await orgRepo.getMember(org.orgId, 'bob'));
  });

  it('removeMember: throws NotOrgAdminError when caller is not org-admin', async () => {
    const { svc, userRepo } = await buildService();
    await seedUser(userRepo, 'alice');
    await seedUser(userRepo, 'bob');
    await seedUser(userRepo, 'carol');

    const { org } = await svc.createOrg('alice', 'Acme');
    await svc.addMember('alice', org.orgId, 'bob');
    await svc.addMember('alice', org.orgId, 'carol');

    await throwsTyped(() => svc.removeMember('bob', org.orgId, 'carol'), NotOrgAdminError);
  });

  it('removeMember: throws NotMemberError when target is not a member', async () => {
    const { svc, userRepo } = await buildService();
    await seedUser(userRepo, 'alice');

    const { org } = await svc.createOrg('alice', 'Acme');

    await throwsTyped(() => svc.removeMember('alice', org.orgId, 'nobody'), NotMemberError);
  });

  it('removeMember: throws LastAdminError when removing the last org-admin', async () => {
    const { svc, userRepo } = await buildService();
    await seedUser(userRepo, 'alice');

    const { org } = await svc.createOrg('alice', 'Acme');

    await throwsTyped(() => svc.removeMember('alice', org.orgId, 'alice'), LastAdminError);
  });

  it('removeMember: succeeds when a second admin exists', async () => {
    const { svc, userRepo } = await buildService();
    await seedUser(userRepo, 'alice');
    await seedUser(userRepo, 'bob');

    const { org } = await svc.createOrg('alice', 'Acme');
    await svc.addMember('alice', org.orgId, 'bob', 'org-admin');
    // now two admins — alice can remove herself
    await svc.removeMember('alice', org.orgId, 'alice'); // should not throw
  });

  // ── setMemberRole ─────────────────────────────────────────────────────────

  it('setMemberRole: valid promotion member → org-admin', async () => {
    const { svc, userRepo } = await buildService();
    await seedUser(userRepo, 'alice');
    await seedUser(userRepo, 'bob');

    const { org } = await svc.createOrg('alice', 'Acme');
    await svc.addMember('alice', org.orgId, 'bob');
    const updated = await svc.setMemberRole('alice', org.orgId, 'bob', 'org-admin');

    assert.equal(updated.role, 'org-admin');
  });

  it('setMemberRole: valid demotion when a second admin exists', async () => {
    const { svc, userRepo } = await buildService();
    await seedUser(userRepo, 'alice');
    await seedUser(userRepo, 'bob');

    const { org } = await svc.createOrg('alice', 'Acme');
    await svc.addMember('alice', org.orgId, 'bob', 'org-admin');
    // two admins — alice can demote herself
    const updated = await svc.setMemberRole('alice', org.orgId, 'alice', 'member');
    assert.equal(updated.role, 'member');
  });

  it('setMemberRole: throws LastAdminError when demoting the last org-admin', async () => {
    const { svc, userRepo } = await buildService();
    await seedUser(userRepo, 'alice');

    const { org } = await svc.createOrg('alice', 'Acme');

    await throwsTyped(() => svc.setMemberRole('alice', org.orgId, 'alice', 'member'), LastAdminError);
  });

  it('setMemberRole: throws NotOrgAdminError when caller is not org-admin', async () => {
    const { svc, userRepo } = await buildService();
    await seedUser(userRepo, 'alice');
    await seedUser(userRepo, 'bob');
    await seedUser(userRepo, 'carol');

    const { org } = await svc.createOrg('alice', 'Acme');
    await svc.addMember('alice', org.orgId, 'bob');
    await svc.addMember('alice', org.orgId, 'carol');

    await throwsTyped(() => svc.setMemberRole('bob', org.orgId, 'carol', 'org-admin'), NotOrgAdminError);
  });

  // ── listUserOrgs ──────────────────────────────────────────────────────────

  it('listUserOrgs returns all orgs for a user', async () => {
    const { svc, userRepo } = await buildService();
    await seedUser(userRepo, 'alice');

    const { org: o1 } = await svc.createOrg('alice', 'Org One');
    const { org: o2 } = await svc.createOrg('alice', 'Org Two');

    const memberships = await svc.listUserOrgs('alice');
    const orgIds = memberships.map((m) => m.orgId).sort();
    assert.deepEqual(orgIds, [o1.orgId, o2.orgId].sort());
  });

  // ── listOrgMembers ────────────────────────────────────────────────────────

  it('listOrgMembers returns all members; requires caller to be a member', async () => {
    const { svc, userRepo } = await buildService();
    await seedUser(userRepo, 'alice');
    await seedUser(userRepo, 'bob');

    const { org } = await svc.createOrg('alice', 'Acme');
    await svc.addMember('alice', org.orgId, 'bob');

    const members = await svc.listOrgMembers('alice', org.orgId);
    assert.lengthOf(members, 2);
  });

  it('listOrgMembers: throws NotMemberError for non-member caller', async () => {
    const { svc, userRepo } = await buildService();
    await seedUser(userRepo, 'alice');

    const { org } = await svc.createOrg('alice', 'Acme');

    await throwsTyped(() => svc.listOrgMembers('outsider', org.orgId), NotMemberError);
  });

  // ── isMember ─────────────────────────────────────────────────────────────

  it('isMember returns true for a member, false for a non-member', async () => {
    const { svc, userRepo } = await buildService();
    await seedUser(userRepo, 'alice');
    await seedUser(userRepo, 'bob');

    const { org } = await svc.createOrg('alice', 'Acme');

    assert.isTrue(await svc.isMember('alice', org.orgId));
    assert.isFalse(await svc.isMember('bob',  org.orgId));

    await svc.addMember('alice', org.orgId, 'bob');
    assert.isTrue(await svc.isMember('bob', org.orgId));
  });

});
