/**
 * OrgService.js — Business logic for organisation and membership management.
 *
 * Responsibilities:
 *   - Create organisations (caller auto-becomes org-admin)
 *   - Add, remove, and role-change members
 *   - Enforce org-admin requirement on all mutations
 *   - Enforce last-admin guard on removal and demotion
 *   - Expose isMember() for sync-time membership checks (S04)
 *
 * CDI autowiring (by name):
 *   this.orgRepository  — OrgRepository instance
 *   this.userRepository — UserRepository instance (user existence check)
 *   this.logger         — optional logger
 */
import { randomUUID } from 'crypto';
import {
  OrgNotFoundError,
  NotOrgAdminError,
  LastAdminError,
  AlreadyMemberError,
  NotMemberError,
} from './orgErrors.js';

export default class OrgService {
  constructor() {
    this.orgRepository  = null; // CDI autowired
    this.userRepository = null; // CDI autowired
    this.logger         = null; // CDI autowired
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  async _requireOrg(orgId) {
    const org = await this.orgRepository.getOrg(orgId);
    if (!org) throw new OrgNotFoundError(orgId);
    return org;
  }

  async _requireOrgAdmin(orgId, userId) {
    const member = await this.orgRepository.getMember(orgId, userId);
    if (!member || member.role !== 'org-admin') throw new NotOrgAdminError(userId, orgId);
    return member;
  }

  async _requireMember(orgId, userId) {
    const member = await this.orgRepository.getMember(orgId, userId);
    if (!member) throw new NotMemberError(userId, orgId);
    return member;
  }

  async _countAdmins(orgId) {
    const members = await this.orgRepository.getOrgMembers(orgId);
    return members.filter((m) => m.role === 'org-admin').length;
  }

  // ── public API ────────────────────────────────────────────────────────────

  /**
   * Create a new organisation.  Caller automatically becomes org-admin.
   *
   * @param {string} callerUserId
   * @param {string} name
   * @returns {Promise<{ org: Object, membership: Object }>}
   */
  async createOrg(callerUserId, name) {
    const orgId = randomUUID();
    const org   = await this.orgRepository.createOrg(orgId, name, callerUserId);
    const membership = await this.orgRepository.createMember(orgId, callerUserId, 'org-admin');
    this.logger?.info?.(`[OrgService] createOrg orgId=${orgId} name="${name}" creator=${callerUserId}`);
    return { org, membership };
  }

  /**
   * Add a user to an organisation.
   *
   * @param {string} callerUserId  — must be org-admin
   * @param {string} orgId
   * @param {string} targetUserId
   * @param {'org-admin'|'member'} [role='member']
   * @returns {Promise<Object>} created member record
   * @throws {OrgNotFoundError | NotOrgAdminError | AlreadyMemberError}
   */
  async addMember(callerUserId, orgId, targetUserId, role = 'member') {
    await this._requireOrg(orgId);
    await this._requireOrgAdmin(orgId, callerUserId);

    // Verify target user exists
    const targetUser = await this.userRepository.getUser(targetUserId);
    if (!targetUser) throw new Error(`User not found: ${targetUserId}`);

    // Reject duplicate membership
    const existing = await this.orgRepository.getMember(orgId, targetUserId);
    if (existing) throw new AlreadyMemberError(targetUserId, orgId);

    const member = await this.orgRepository.createMember(orgId, targetUserId, role);
    this.logger?.info?.(`[OrgService] addMember orgId=${orgId} userId=${targetUserId} role=${role} by=${callerUserId}`);
    return member;
  }

  /**
   * Remove a member from an organisation.
   *
   * @param {string} callerUserId  — must be org-admin
   * @param {string} orgId
   * @param {string} targetUserId
   * @returns {Promise<void>}
   * @throws {OrgNotFoundError | NotOrgAdminError | NotMemberError | LastAdminError}
   */
  async removeMember(callerUserId, orgId, targetUserId) {
    await this._requireOrg(orgId);
    await this._requireOrgAdmin(orgId, callerUserId);
    const target = await this._requireMember(orgId, targetUserId);

    // Last-admin guard: if target is org-admin, ensure at least one other admin remains
    if (target.role === 'org-admin') {
      const adminCount = await this._countAdmins(orgId);
      if (adminCount <= 1) throw new LastAdminError(orgId);
    }

    await this.orgRepository.removeMember(orgId, targetUserId);
    this.logger?.info?.(`[OrgService] removeMember orgId=${orgId} userId=${targetUserId} by=${callerUserId}`);
  }

  /**
   * Change a member's role.
   *
   * @param {string} callerUserId  — must be org-admin
   * @param {string} orgId
   * @param {string} targetUserId
   * @param {'org-admin'|'member'} role
   * @returns {Promise<Object>} updated member record
   * @throws {OrgNotFoundError | NotOrgAdminError | NotMemberError | LastAdminError}
   */
  async setMemberRole(callerUserId, orgId, targetUserId, role) {
    await this._requireOrg(orgId);
    await this._requireOrgAdmin(orgId, callerUserId);
    const target = await this._requireMember(orgId, targetUserId);

    // Last-admin guard: reject demotion if target is the only org-admin
    if (role === 'member' && target.role === 'org-admin') {
      const adminCount = await this._countAdmins(orgId);
      if (adminCount <= 1) throw new LastAdminError(orgId);
    }

    const updated = await this.orgRepository.setMemberRole(orgId, targetUserId, role);
    this.logger?.info?.(`[OrgService] setMemberRole orgId=${orgId} userId=${targetUserId} role=${role} by=${callerUserId}`);
    return updated;
  }

  /**
   * List all orgs the caller belongs to.
   *
   * @param {string} callerUserId
   * @returns {Promise<Object[]>} array of membership records
   */
  async listUserOrgs(callerUserId) {
    return this.orgRepository.findOrgsByUser(callerUserId);
  }

  /**
   * List all members of an organisation.  Caller must be a member.
   *
   * @param {string} callerUserId
   * @param {string} orgId
   * @returns {Promise<Object[]>} array of member records
   * @throws {OrgNotFoundError | NotMemberError}
   */
  async listOrgMembers(callerUserId, orgId) {
    await this._requireOrg(orgId);
    await this._requireMember(orgId, callerUserId);
    return this.orgRepository.getOrgMembers(orgId);
  }

  /**
   * Check whether a user is a member of an org.
   * Used by AppSyncController for the X-Org-Id header membership check.
   *
   * @param {string} userId
   * @param {string} orgId
   * @returns {Promise<boolean>}
   */
  async isMember(userId, orgId) {
    const member = await this.orgRepository.getMember(orgId, userId);
    return member != null;
  }
}
