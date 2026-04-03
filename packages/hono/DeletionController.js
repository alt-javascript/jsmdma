/**
 * DeletionController.js — Hono controller for hard-delete operations.
 *
 * Routes:
 *   DELETE /account         — hard-delete the authenticated user account
 *   DELETE /orgs/:orgId     — hard-delete an organisation (org-admin only)
 *
 * Authentication is required on both routes.  The auth middleware
 * (AuthMiddlewareRegistrar) must be registered before this controller in the
 * CDI context.
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
 * Uses the imperative routes() hook (instead of static __routes) because the
 * boot-hono HonoControllerRegistrar cannot produce a valid 204 No Content
 * response via the __routes + return-value path: the dispatch wrapper converts
 * null to { statusCode: 204 } and the outer code then calls c.json('', 204),
 * which the Fetch API Response constructor rejects for bodyless status codes.
 * The imperative hook calls c.body(null, 204) directly, which is correct.
 *
 * CDI autowiring (by name):
 *   this.deletionService — DeletionService instance
 *   this.orgRepository   — OrgRepository instance
 *   this.logger          — optional logger
 */
export default class DeletionController {
  // No static __routes — uses the imperative routes() hook for 204 support.

  constructor() {
    this.deletionService = null; // CDI autowired
    this.orgRepository   = null; // CDI autowired
    this.logger          = null; // CDI autowired
  }

  /**
   * Register DELETE /account and DELETE /orgs/:orgId directly on the Hono app.
   * Called by HonoControllerRegistrar for components without __routes.
   *
   * @param {import('hono').Hono} app
   */
  routes(app) {
    const ctrl = this;

    // ── DELETE /account ────────────────────────────────────────────────────
    app.delete('/account', async (c) => {
      const userPayload = c.get('user') ?? null;
      if (!userPayload || !userPayload.sub) {
        ctrl.logger?.debug?.('[DeletionController] 401 — missing or invalid user payload on DELETE /account');
        return c.json({ error: 'Authentication required' }, 401);
      }
      const userId = userPayload.sub;

      await ctrl.deletionService.deleteUser(userId);
      ctrl.logger?.info?.(`[DeletionController] deleteUser userId=${userId}`);

      return c.body(null, 204);
    });

    // ── DELETE /orgs/:orgId ────────────────────────────────────────────────
    app.delete('/orgs/:orgId', async (c) => {
      const userPayload = c.get('user') ?? null;
      if (!userPayload || !userPayload.sub) {
        ctrl.logger?.debug?.('[DeletionController] 401 — missing or invalid user payload on DELETE /orgs/:orgId');
        return c.json({ error: 'Authentication required' }, 401);
      }
      const userId = userPayload.sub;
      const orgId  = c.req.param('orgId');

      const org = await ctrl.orgRepository.getOrg(orgId);
      if (!org) {
        ctrl.logger?.debug?.(`[DeletionController] 404 — orgId=${orgId} not found`);
        return c.json({ error: `Organisation not found: ${orgId}` }, 404);
      }

      const member = await ctrl.orgRepository.getMember(orgId, userId);
      if (!member || member.role !== 'org-admin') {
        ctrl.logger?.debug?.(`[DeletionController] 403 — userId=${userId} is not org-admin of orgId=${orgId}`);
        return c.json({ error: 'Forbidden: org-admin role required' }, 403);
      }

      await ctrl.deletionService.deleteOrg(orgId);
      ctrl.logger?.info?.(`[DeletionController] deleteOrg orgId=${orgId} by userId=${userId}`);

      return c.body(null, 204);
    });
  }
}
