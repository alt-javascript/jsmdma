/**
 * OrgRepository.js — jsnosqlc-backed store for organisations and memberships.
 *
 * Two collections:
 *
 *   orgs:
 *     key = orgId (UUID)
 *     { orgId, name, createdAt, createdBy }
 *
 *   orgMembers:
 *     key = '{orgId}:{userId}'
 *     { orgId, userId, role: 'org-admin'|'member', joinedAt }
 *
 * Orgs are application-agnostic — there is no application field on either
 * record. The org is a pure identity and membership construct; the application
 * context is supplied at sync time by the caller, not stored here.
 *
 * findOrgsByUser and getOrgMembers use Filter scans on the orgMembers
 * collection. This is acceptable — membership lookups happen at auth time
 * and the collection is bounded by human org size.
 *
 * nosqlClient injected directly (tests) or CDI-autowired (production).
 */
import { Filter } from '@alt-javascript/jsnosqlc-core';

const ORGS_COL    = 'orgs';
const MEMBERS_COL = 'orgMembers';

export default class OrgRepository {
  /**
   * @param {import('@alt-javascript/jsnosqlc-core').Client} nosqlClient
   * @param {object} [logger]
   */
  constructor(nosqlClient, logger) {
    this.nosqlClient = nosqlClient;
    this.logger      = logger ?? null;
  }

  _orgs()    { return this.nosqlClient.getCollection(ORGS_COL);    }
  _members() { return this.nosqlClient.getCollection(MEMBERS_COL); }

  _memberKey(orgId, userId) { return `${orgId}:${userId}`; }

  // ── Org operations ────────────────────────────────────────────────────────

  /**
   * Create and store a new organisation.
   * @param {string} orgId
   * @param {string} name
   * @param {string} createdBy — userId of the creator
   * @returns {Promise<Object>} stored org record
   */
  async createOrg(orgId, name, createdBy) {
    const org = {
      orgId,
      name,
      createdBy,
      createdAt: new Date().toISOString(),
    };
    await this._orgs().store(orgId, org);
    this.logger?.info?.(`[OrgRepository] createOrg orgId=${orgId} createdBy=${createdBy}`);
    return org;
  }

  /**
   * Retrieve an organisation by ID.
   * @param {string} orgId
   * @returns {Promise<Object|null>}
   */
  async getOrg(orgId) {
    return (await this._orgs().get(orgId)) ?? null;
  }

  // ── Member operations ─────────────────────────────────────────────────────

  /**
   * Add a member to an org.
   * @param {string} orgId
   * @param {string} userId
   * @param {'org-admin'|'member'} role
   * @returns {Promise<Object>} stored member record
   */
  async createMember(orgId, userId, role) {
    const member = {
      orgId,
      userId,
      role,
      joinedAt: new Date().toISOString(),
    };
    await this._members().store(this._memberKey(orgId, userId), member);
    this.logger?.info?.(`[OrgRepository] createMember orgId=${orgId} userId=${userId} role=${role}`);
    return member;
  }

  /**
   * Retrieve a specific membership record.
   * @param {string} orgId
   * @param {string} userId
   * @returns {Promise<Object|null>}
   */
  async getMember(orgId, userId) {
    return (await this._members().get(this._memberKey(orgId, userId))) ?? null;
  }

  /**
   * Remove a member from an org.
   * @param {string} orgId
   * @param {string} userId
   * @returns {Promise<void>}
   */
  async removeMember(orgId, userId) {
    await this._members().delete(this._memberKey(orgId, userId));
    this.logger?.info?.(`[OrgRepository] removeMember orgId=${orgId} userId=${userId}`);
  }

  /**
   * Change a member's role.
   * @param {string} orgId
   * @param {string} userId
   * @param {'org-admin'|'member'} role
   * @returns {Promise<Object>} updated member record
   */
  async setMemberRole(orgId, userId, role) {
    const existing = await this.getMember(orgId, userId);
    if (!existing) throw new Error(`Member not found: orgId=${orgId} userId=${userId}`);
    const updated = { ...existing, role };
    await this._members().store(this._memberKey(orgId, userId), updated);
    this.logger?.info?.(`[OrgRepository] setMemberRole orgId=${orgId} userId=${userId} role=${role}`);
    return updated;
  }

  /**
   * Return all membership records for a given user (across all orgs).
   * @param {string} userId
   * @returns {Promise<Object[]>} array of member records
   */
  async findOrgsByUser(userId) {
    const filter = Filter.where('userId').eq(userId).build();
    const cursor = await this._members().find(filter);
    return cursor.getDocuments();
  }

  /**
   * Return all membership records for a given org.
   * @param {string} orgId
   * @returns {Promise<Object[]>} array of member records
   */
  async getOrgMembers(orgId) {
    const filter = Filter.where('orgId').eq(orgId).build();
    const cursor = await this._members().find(filter);
    return cursor.getDocuments();
  }
}
