/**
 * DocIndexController.js — Hono controller for document ownership/sharing index.
 *
 * Routes (all require boot session auth via OAuthSessionMiddleware):
 *   GET    /docIndex/:app/:docKey              — read entry (owner only)
 *   PATCH  /docIndex/:app/:docKey              — update visibility and/or sharedWith (owner only)
 *   POST   /docIndex/:app/:docKey/shareToken   — mint UUID token, set shareToken (owner only)
 *   DELETE /docIndex/:app/:docKey/shareToken   — set shareToken to null (owner only)
 *
 * All mutating endpoints enforce ownership: entry.userId must equal user.userId.
 * Returns 401 if unauthenticated, 403 if authenticated but not the owner,
 * 404 if the docIndex entry does not exist.
 *
 * CDI autowires:
 *   this.documentIndexRepository — DocumentIndexRepository instance
 *   this.logger                  — optional logger
 */
import { randomUUID } from 'node:crypto';

const VALID_VISIBILITY = ['private', 'shared', 'org', 'public'];

export default class DocIndexController {
  static __routes = [
    // shareToken routes — longer paths first to prevent /:docKey eating 'shareToken'
    { method: 'POST',   path: '/docIndex/:app/:docKey/shareToken', handler: 'mintToken'   },
    { method: 'DELETE', path: '/docIndex/:app/:docKey/shareToken', handler: 'revokeToken' },
    // Entry routes
    { method: 'GET',    path: '/docIndex/:app/:docKey',            handler: 'getEntry'    },
    { method: 'PATCH',  path: '/docIndex/:app/:docKey',            handler: 'patchEntry'  },
  ];

  constructor() {
    this.documentIndexRepository = null; // CDI autowired
    this.logger                  = null; // CDI autowired
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  _getUser(request) {
    return request.identity ?? null;
  }

  // ── route handlers ────────────────────────────────────────────────────────

  /**
   * GET /docIndex/:app/:docKey
   * Return the docIndex entry for the authenticated owner.
   */
  async getEntry(request) {
    const user = this._getUser(request);
    if (!user) return { statusCode: 401, body: { error: 'Authentication required' } };

    const { app, docKey } = request.params;
    const entry = await this.documentIndexRepository.get(user.userId, app, docKey);

    if (!entry) {
      return { statusCode: 404, body: { error: `docIndex entry not found: ${app}/${docKey}` } };
    }

    if (entry.userId !== user.userId) {
      return { statusCode: 403, body: { error: 'Forbidden' } };
    }

    this.logger?.info?.(`[DocIndexController] getEntry userId=${user.userId} app=${app} docKey=${docKey}`);
    return { statusCode: 200, body: entry };
  }

  /**
   * PATCH /docIndex/:app/:docKey
   * Update visibility and/or sharedWith. Owner only.
   * Body: { visibility?: string, sharedWith?: Array<{ userId, app }> }
   */
  async patchEntry(request) {
    const user = this._getUser(request);
    if (!user) return { statusCode: 401, body: { error: 'Authentication required' } };

    const { app, docKey } = request.params;
    const entry = await this.documentIndexRepository.get(user.userId, app, docKey);

    if (!entry) {
      return { statusCode: 404, body: { error: `docIndex entry not found: ${app}/${docKey}` } };
    }

    if (entry.userId !== user.userId) {
      return { statusCode: 403, body: { error: 'Forbidden' } };
    }

    const { visibility, sharedWith } = request.body ?? {};

    // Validate and apply visibility
    if (visibility !== undefined) {
      if (!VALID_VISIBILITY.includes(visibility)) {
        return {
          statusCode: 400,
          body: { error: `Invalid visibility: ${visibility}. Must be one of: ${VALID_VISIBILITY.join(', ')}` },
        };
      }
      await this.documentIndexRepository.setVisibility(user.userId, app, docKey, visibility);
    }

    // Validate and apply sharedWith
    if (sharedWith !== undefined) {
      if (!Array.isArray(sharedWith)) {
        return { statusCode: 400, body: { error: 'sharedWith must be an array' } };
      }
      for (const share of sharedWith) {
        if (!share.userId || !share.app) {
          return { statusCode: 400, body: { error: 'Each sharedWith entry must have userId and app' } };
        }
        await this.documentIndexRepository.addSharedWith(user.userId, app, docKey, share.userId, share.app);
      }
    }

    const updated = await this.documentIndexRepository.get(user.userId, app, docKey);
    this.logger?.info?.(`[DocIndexController] patchEntry userId=${user.userId} app=${app} docKey=${docKey}`);
    return { statusCode: 200, body: updated };
  }

  /**
   * POST /docIndex/:app/:docKey/shareToken
   * Mint a UUID share token. Owner only.
   */
  async mintToken(request) {
    const user = this._getUser(request);
    if (!user) return { statusCode: 401, body: { error: 'Authentication required' } };

    const { app, docKey } = request.params;
    const entry = await this.documentIndexRepository.get(user.userId, app, docKey);

    if (!entry) {
      return { statusCode: 404, body: { error: `docIndex entry not found: ${app}/${docKey}` } };
    }

    if (entry.userId !== user.userId) {
      return { statusCode: 403, body: { error: 'Forbidden' } };
    }

    const token = randomUUID();
    await this.documentIndexRepository.setShareToken(user.userId, app, docKey, token);
    this.logger?.info?.(`[DocIndexController] mintToken userId=${user.userId} app=${app} docKey=${docKey}`);
    return { statusCode: 200, body: { shareToken: token } };
  }

  /**
   * DELETE /docIndex/:app/:docKey/shareToken
   * Revoke the share token (set to null). Owner only.
   */
  async revokeToken(request) {
    const user = this._getUser(request);
    if (!user) return { statusCode: 401, body: { error: 'Authentication required' } };

    const { app, docKey } = request.params;
    const entry = await this.documentIndexRepository.get(user.userId, app, docKey);

    if (!entry) {
      return { statusCode: 404, body: { error: `docIndex entry not found: ${app}/${docKey}` } };
    }

    if (entry.userId !== user.userId) {
      return { statusCode: 403, body: { error: 'Forbidden' } };
    }

    await this.documentIndexRepository.setShareToken(user.userId, app, docKey, null);
    this.logger?.info?.(`[DocIndexController] revokeToken userId=${user.userId} app=${app} docKey=${docKey}`);
    return { statusCode: 200, body: { shareToken: null } };
  }
}
