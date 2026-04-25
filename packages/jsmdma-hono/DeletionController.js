/**
 * DeletionController.js — Hono controller for hard-delete operations.
 *
 * Routes:
 *   DELETE /account         — hard-delete the authenticated user account
 *   DELETE /orgs/:orgId     — hard-delete an organisation (org-admin only)
 *
 * Authentication is required on both routes. OAuthSessionMiddleware must be
 * registered before this controller in the CDI context.
 *
 * DELETE /account:
 *   Cascades through all synced docs, docIndex entries, org memberships, and
 *   the user identity record via DeletionService.deleteUser(userId).
 *   Returns 204 on success.
 *
 * DELETE /orgs/:orgId:
 *   Only an org-admin may delete an org.
 *   Returns 404 if the org does not exist.
 *   Returns 403 if the caller is not an org-admin.
 *   Cascades through all org-scoped docs, members, name reservation, and the
 *   org record via DeletionService.deleteOrg(orgId).
 *   Returns 204 on success.
 *
 * CDI autowiring (by name):
 *   this.deletionService — DeletionService instance
 *   this.orgRepository   — OrgRepository instance
 *   this.logger          — optional logger
 */
export default class DeletionController {
  static __routes = [
    { method: 'DELETE', path: '/account',     handler: 'deleteAccount' },
    { method: 'DELETE', path: '/orgs/:orgId', handler: 'deleteOrg' },
  ];

  constructor() {
    this.deletionService = null; // CDI autowired
    this.orgRepository   = null; // CDI autowired
    this.logger          = null; // CDI autowired
  }

  /**
   * DELETE /account — hard-delete the authenticated user and all their data.
   * Returns null (→ 204) on success.
   */
  async deleteAccount(request) {
    const identity = request.identity;
    if (!identity?.userId) {
      this.logger?.debug?.('[DeletionController] 401 — missing identity on DELETE /account');
      return { statusCode: 401, body: { error: 'Authentication required' } };
    }
    const userId = identity.userId;

    await this.deletionService.deleteUser(userId);
    this.logger?.info?.(`[DeletionController] deleteUser userId=${userId}`);

    return null; // dispatch converts to { statusCode: 204 }
  }

  /**
   * DELETE /orgs/:orgId — hard-delete an organisation (org-admin only).
   * Returns null (→ 204) on success.
   */
  async deleteOrg(request) {
    const identity = request.identity;
    if (!identity?.userId) {
      this.logger?.debug?.('[DeletionController] 401 — missing identity on DELETE /orgs/:orgId');
      return { statusCode: 401, body: { error: 'Authentication required' } };
    }
    const userId = identity.userId;
    const orgId  = request.params?.orgId;

    const org = await this.orgRepository.getOrg(orgId);
    if (!org) {
      this.logger?.debug?.(`[DeletionController] 404 — orgId=${orgId} not found`);
      return { statusCode: 404, body: { error: `Organisation not found: ${orgId}` } };
    }

    const member = await this.orgRepository.getMember(orgId, userId);
    if (!member || member.role !== 'org-admin') {
      this.logger?.debug?.(`[DeletionController] 403 — userId=${userId} is not org-admin of orgId=${orgId}`);
      return { statusCode: 403, body: { error: 'Forbidden: org-admin role required' } };
    }

    await this.deletionService.deleteOrg(orgId);
    this.logger?.info?.(`[DeletionController] deleteOrg orgId=${orgId} by userId=${userId}`);

    return null; // dispatch converts to { statusCode: 204 }
  }
}
