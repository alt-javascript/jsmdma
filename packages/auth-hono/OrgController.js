/**
 * OrgController.js — Hono controller for organisation management.
 *
 * Routes (all require JWT auth via AuthMiddlewareRegistrar):
 *   POST   /orgs                        — create organisation
 *   GET    /orgs                        — list caller's organisations
 *   GET    /orgs/:orgId/members         — list members (membership required)
 *   POST   /orgs/:orgId/members         — add member (org-admin required)
 *   PATCH  /orgs/:orgId/members/:userId — change member role (org-admin required)
 *   DELETE /orgs/:orgId/members/:userId — remove member (org-admin required)
 *
 * Route ordering: longer/more-specific paths declared before shorter ones to
 * prevent Hono's /:orgId wildcard from swallowing static segments.
 *
 * Error mapping:
 *   OrgNotFoundError   → 404
 *   NotOrgAdminError   → 403
 *   NotMemberError     → 403
 *   LastAdminError     → 409
 *   AlreadyMemberError → 409
 *   (other)            → 500
 *
 * CDI autowires:
 *   this.orgService — OrgService instance
 *   this.logger     — optional logger
 */
import {
  OrgNotFoundError,
  NotOrgAdminError,
  LastAdminError,
  AlreadyMemberError,
  NotMemberError,
  DuplicateOrgNameError,
} from '@alt-javascript/jsmdma-auth-server';

export default class OrgController {
  static __routes = [
    // Member routes — longer paths first to prevent /:orgId eating 'members'
    { method: 'GET',    path: '/orgs/:orgId/members',          handler: 'listMembers'  },
    { method: 'POST',   path: '/orgs/:orgId/members',          handler: 'addMember'    },
    { method: 'PATCH',  path: '/orgs/:orgId/members/:userId',  handler: 'setRole'      },
    { method: 'DELETE', path: '/orgs/:orgId/members/:userId',  handler: 'removeMember' },
    // Org routes
    { method: 'POST',   path: '/orgs',                         handler: 'createOrg'    },
    { method: 'GET',    path: '/orgs',                         handler: 'listOrgs'     },
  ];

  constructor() {
    this.orgService   = null; // CDI autowired
    this.logger       = null; // CDI autowired
    this.registerable = null; // CDI property-injected from config: orgs.registerable
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  _getUser(request) {
    return request.honoCtx?.get?.('user') ?? null;
  }

  _mapError(err) {
    if (err instanceof OrgNotFoundError)   return { statusCode: 404, body: { error: err.message } };
    if (err instanceof NotOrgAdminError)   return { statusCode: 403, body: { error: err.message } };
    if (err instanceof NotMemberError)     return { statusCode: 403, body: { error: err.message } };
    if (err instanceof LastAdminError)     return { statusCode: 409, body: { error: err.message } };
    if (err instanceof AlreadyMemberError) return { statusCode: 409, body: { error: err.message } };
    if (err instanceof DuplicateOrgNameError) return { statusCode: 409, body: { error: err.message } };
    this.logger?.error?.(`[OrgController] unexpected error: ${err.message}`);
    return { statusCode: 500, body: { error: 'Internal server error' } };
  }

  // ── route handlers ────────────────────────────────────────────────────────

  /**
   * POST /orgs
   * Create a new organisation. Body: { name }
   */
  async createOrg(request) {
    const user = this._getUser(request);
    if (!user) return { statusCode: 401, body: { error: 'Authentication required' } };

    if (this.registerable !== true) {
      return { statusCode: 403, body: { error: 'Organisation registration is disabled on this instance.' } };
    }

    const { name } = request.body ?? {};
    if (!name || typeof name !== 'string') {
      return { statusCode: 400, body: { error: 'Missing required field: name' } };
    }

    try {
      const { org, membership } = await this.orgService.createOrg(user.sub, name);
      this.logger?.info?.(`[OrgController] createOrg orgId=${org.orgId} userId=${user.sub}`);
      return { statusCode: 201, body: { orgId: org.orgId, name: org.name, role: membership.role } };
    } catch (err) {
      return this._mapError(err);
    }
  }

  /**
   * GET /orgs
   * List all orgs the caller belongs to.
   */
  async listOrgs(request) {
    const user = this._getUser(request);
    if (!user) return { statusCode: 401, body: { error: 'Authentication required' } };

    const memberships = await this.orgService.listUserOrgs(user.sub);
    return { orgs: memberships };
  }

  /**
   * GET /orgs/:orgId/members
   * List members. Requires caller to be a member of the org.
   */
  async listMembers(request) {
    const user = this._getUser(request);
    if (!user) return { statusCode: 401, body: { error: 'Authentication required' } };

    const { orgId } = request.params;

    try {
      const members = await this.orgService.listOrgMembers(user.sub, orgId);
      return { members };
    } catch (err) {
      return this._mapError(err);
    }
  }

  /**
   * POST /orgs/:orgId/members
   * Add a member. Body: { userId, role? }. Requires org-admin.
   */
  async addMember(request) {
    const user = this._getUser(request);
    if (!user) return { statusCode: 401, body: { error: 'Authentication required' } };

    const { orgId } = request.params;
    const { userId, role = 'member' } = request.body ?? {};

    if (!userId || typeof userId !== 'string') {
      return { statusCode: 400, body: { error: 'Missing required field: userId' } };
    }

    const validRoles = ['org-admin', 'member'];
    if (!validRoles.includes(role)) {
      return { statusCode: 400, body: { error: `Invalid role: ${role}. Must be one of: ${validRoles.join(', ')}` } };
    }

    try {
      const member = await this.orgService.addMember(user.sub, orgId, userId, role);
      this.logger?.info?.(`[OrgController] addMember orgId=${orgId} userId=${userId} by=${user.sub}`);
      return { member };
    } catch (err) {
      return this._mapError(err);
    }
  }

  /**
   * PATCH /orgs/:orgId/members/:userId
   * Change a member's role. Body: { role }. Requires org-admin.
   */
  async setRole(request) {
    const user = this._getUser(request);
    if (!user) return { statusCode: 401, body: { error: 'Authentication required' } };

    const { orgId, userId } = request.params;
    const { role } = request.body ?? {};

    const validRoles = ['org-admin', 'member'];
    if (!role || !validRoles.includes(role)) {
      return { statusCode: 400, body: { error: `Invalid or missing role. Must be one of: ${validRoles.join(', ')}` } };
    }

    try {
      const member = await this.orgService.setMemberRole(user.sub, orgId, userId, role);
      this.logger?.info?.(`[OrgController] setRole orgId=${orgId} userId=${userId} role=${role} by=${user.sub}`);
      return { member };
    } catch (err) {
      return this._mapError(err);
    }
  }

  /**
   * DELETE /orgs/:orgId/members/:userId
   * Remove a member. Requires org-admin. Returns 409 if last admin.
   */
  async removeMember(request) {
    const user = this._getUser(request);
    if (!user) return { statusCode: 401, body: { error: 'Authentication required' } };

    const { orgId, userId } = request.params;

    try {
      await this.orgService.removeMember(user.sub, orgId, userId);
      this.logger?.info?.(`[OrgController] removeMember orgId=${orgId} userId=${userId} by=${user.sub}`);
      return { removed: true };
    } catch (err) {
      return this._mapError(err);
    }
  }
}
