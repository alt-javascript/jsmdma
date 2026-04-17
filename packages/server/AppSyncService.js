/**
 * AppSyncService.js — Service-layer orchestration for application-scoped sync.
 *
 * This class extracts orchestration concerns out of the HTTP adapter so they
 * can be tested without transport noise:
 *   - auth guard extraction from honoCtx
 *   - application allowlist checks
 *   - org-membership enforcement for x-org-id scope
 *   - schema validation fan-out over incoming changes
 *   - personal vs org syncService.sync() call-shape selection
 *   - document ownership index upsert side-effects
 *
 * Contract:
 *   sync(request) -> { statusCode: number, body: object }
 */
import { namespaceKey } from './namespaceKey.js';

function normalizeSchemaError(error) {
  if (!error || typeof error !== 'object') {
    return { field: '(validator)', message: 'Malformed schema validation response' };
  }

  const field = typeof error.field === 'string' && error.field.length > 0
    ? error.field
    : '(validator)';

  const message = typeof error.message === 'string' && error.message.length > 0
    ? error.message
    : 'validation error';

  return { field, message };
}

export default class AppSyncService {
  constructor() {
    this.syncService = null;             // CDI autowired
    this.applicationRegistry = null;     // CDI autowired
    this.schemaValidator = null;         // CDI autowired
    this.orgService = null;              // CDI autowired (required when x-org-id is present)
    this.documentIndexRepository = null; // CDI autowired (optional)
    this.logger = null;                  // CDI autowired
  }

  /**
   * @param {{ body: Object, params: Object, headers: Object, honoCtx: import('hono').Context }} request
   * @returns {Promise<{ statusCode: number, body: object }>}
   */
  async sync(request) {
    const { body, params, headers, honoCtx } = request ?? {};

    // ── Auth guard ──────────────────────────────────────────────────────────
    const userPayload = honoCtx?.get?.('user') ?? null;
    if (!userPayload || !userPayload.sub) {
      return { statusCode: 401, body: { error: 'Authentication required' } };
    }
    const userId = userPayload.sub;

    // ── Application allowlist ──────────────────────────────────────────────
    const application = params?.application;
    if (!application) {
      return { statusCode: 400, body: { error: 'Missing application in path' } };
    }

    let isAllowed = false;
    try {
      isAllowed = this.applicationRegistry?.isAllowed?.(application) === true;
    } catch (error) {
      this.logger?.warn?.(
        `[AppSyncService] applicationRegistry.isAllowed threw for app=${application}: ${error?.message ?? error}`,
      );
      isAllowed = false;
    }

    if (!isAllowed) {
      this.logger?.debug?.(`[AppSyncService] unknown application: ${application}`);
      return { statusCode: 404, body: { error: `Unknown application: ${application}` } };
    }

    // ── Request body validation ─────────────────────────────────────────────
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { statusCode: 400, body: { error: 'Request body is required' } };
    }

    const collection = body.collection;
    const clientClock = body.clientClock;
    const changes = body.changes ?? [];

    if (!collection || typeof collection !== 'string') {
      return { statusCode: 400, body: { error: 'Missing required field: collection' } };
    }
    if (!clientClock || typeof clientClock !== 'string') {
      return { statusCode: 400, body: { error: 'Missing required field: clientClock' } };
    }
    if (!Array.isArray(changes)) {
      return { statusCode: 400, body: { error: 'Invalid field: changes must be an array' } };
    }

    // ── Org-scope resolution ────────────────────────────────────────────────
    const orgId = headers?.['x-org-id'] ?? headers?.['X-Org-Id'] ?? null;
    let storageCollection;

    if (orgId) {
      if (!this.orgService || typeof this.orgService.isMember !== 'function') {
        this.logger?.error?.('[AppSyncService] x-org-id header present but orgService not wired');
        return { statusCode: 500, body: { error: 'Org-scoped sync is not configured' } };
      }

      let isMember = false;
      try {
        isMember = await this.orgService.isMember(userId, orgId);
      } catch (error) {
        this.logger?.error?.(
          `[AppSyncService] orgService.isMember failed orgId=${orgId} userId=${userId}: ${error?.message ?? error}`,
        );
        return { statusCode: 500, body: { error: 'Failed to verify organisation membership' } };
      }

      if (isMember !== true) {
        this.logger?.debug?.(`[AppSyncService] org membership denied orgId=${orgId} userId=${userId}`);
        return { statusCode: 403, body: { error: `Not a member of organisation: ${orgId}` } };
      }

      storageCollection = `org:${orgId}:${application}:${collection}`;
    } else {
      storageCollection = namespaceKey(userId, application, collection);
    }

    this.logger?.debug?.(
      `[AppSyncService] sync userId=${userId} app=${application} collection=${collection} storage=${storageCollection} changes=${changes.length}`,
    );

    // ── Schema validation ───────────────────────────────────────────────────
    if (this.schemaValidator && changes.length > 0) {
      const validationErrors = [];

      for (const change of changes) {
        let result;
        try {
          result = this.schemaValidator.validate(application, collection, change?.doc ?? {});
        } catch (error) {
          validationErrors.push({
            key: change?.key,
            field: '(validator)',
            message: `validator threw: ${error?.message ?? error}`,
          });
          continue;
        }

        if (result?.valid === true) continue;

        const errors = Array.isArray(result?.errors) && result.errors.length > 0
          ? result.errors
          : [{ field: '(validator)', message: 'Malformed schema validation response' }];

        for (const error of errors) {
          validationErrors.push({ key: change?.key, ...normalizeSchemaError(error) });
        }
      }

      if (validationErrors.length > 0) {
        this.logger?.warn?.(
          `[AppSyncService] schema validation failed app=${application} collection=${collection} userId=${userId} errors=${JSON.stringify(validationErrors)}`,
        );
        return {
          statusCode: 400,
          body: { error: 'Schema validation failed', details: validationErrors },
        };
      }
    }

    // ── Sync delegation ─────────────────────────────────────────────────────
    let syncResult;
    try {
      syncResult = orgId
        ? await this.syncService.sync(storageCollection, clientClock, changes)
        : await this.syncService.sync(collection, clientClock, changes, userId, application);
    } catch (error) {
      this.logger?.error?.(`[AppSyncService] syncService.sync failed: ${error?.message ?? error}`);
      return { statusCode: 500, body: { error: 'Sync failed' } };
    }

    const validSyncShape = (
      syncResult
      && typeof syncResult === 'object'
      && typeof syncResult.serverClock === 'string'
      && Array.isArray(syncResult.serverChanges)
      && Array.isArray(syncResult.conflicts)
    );

    if (!validSyncShape) {
      this.logger?.error?.('[AppSyncService] syncService.sync returned malformed response');
      return { statusCode: 500, body: { error: 'Malformed sync response' } };
    }

    // ── Document ownership index side-effects ───────────────────────────────
    if (this.documentIndexRepository != null && changes.length > 0) {
      if (typeof this.documentIndexRepository.upsertOwnership !== 'function') {
        this.logger?.error?.('[AppSyncService] documentIndexRepository missing upsertOwnership');
        return { statusCode: 500, body: { error: 'Document index repository is misconfigured' } };
      }

      for (const change of changes) {
        try {
          await this.documentIndexRepository.upsertOwnership(userId, application, change?.key, collection);
          this.logger?.info?.(
            `[AppSyncService] docIndex upsert userId=${userId} app=${application} key=${change?.key} collection=${collection}`,
          );
        } catch (error) {
          this.logger?.error?.(
            `[AppSyncService] docIndex upsert failed userId=${userId} app=${application} key=${change?.key}: ${error?.message ?? error}`,
          );
          return { statusCode: 500, body: { error: 'Document ownership index update failed' } };
        }
      }
    }

    return { statusCode: 200, body: syncResult };
  }
}
