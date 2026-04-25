/**
 * AppSyncService.js — Service-layer orchestration for application-scoped sync.
 *
 * This class extracts orchestration concerns out of the HTTP adapter so they
 * can be tested without transport noise:
 *   - auth guard extraction from identity (request.identity)
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

const ERROR_CODE_BY_STATUS = Object.freeze({
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  500: 'internal_error',
});

function errorCodeForStatus(statusCode) {
  if (ERROR_CODE_BY_STATUS[statusCode]) {
    return ERROR_CODE_BY_STATUS[statusCode];
  }
  if (statusCode >= 500) return 'internal_error';
  if (statusCode >= 400) return 'request_error';
  return 'unknown_error';
}

function failure(statusCode, error, extras = {}) {
  return {
    statusCode,
    body: {
      error,
      code: errorCodeForStatus(statusCode),
      ...extras,
    },
  };
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
   * @param {{ body: Object, params: Object, headers: Object, identity: Object }} request
   * @returns {Promise<{ statusCode: number, body: object }>}
   */
  async sync(request) {
    const { body, params, headers, identity } = request ?? {};

    // ── Auth guard ──────────────────────────────────────────────────────────
    if (!identity || !identity.userId) {
      return failure(401, 'Authentication required');
    }
    const userId = identity.userId;

    // ── Application allowlist ──────────────────────────────────────────────
    const application = params?.application;
    if (!application) {
      return failure(400, 'Missing application in path');
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
      return failure(404, `Unknown application: ${application}`);
    }

    // ── Request body validation ─────────────────────────────────────────────
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return failure(400, 'Request body is required');
    }

    const collection = body.collection;
    const clientClock = body.clientClock;
    const changes = body.changes ?? [];

    if (!collection || typeof collection !== 'string') {
      return failure(400, 'Missing required field: collection');
    }
    if (!clientClock || typeof clientClock !== 'string') {
      return failure(400, 'Missing required field: clientClock');
    }
    if (!Array.isArray(changes)) {
      return failure(400, 'Invalid field: changes must be an array');
    }

    // ── Org-scope resolution ────────────────────────────────────────────────
    const orgId = headers?.['x-org-id'] ?? headers?.['X-Org-Id'] ?? null;
    let storageCollection;

    if (orgId) {
      if (!this.orgService || typeof this.orgService.isMember !== 'function') {
        this.logger?.error?.('[AppSyncService] x-org-id header present but orgService not wired');
        return failure(500, 'Org-scoped sync is not configured');
      }

      let isMember = false;
      try {
        isMember = await this.orgService.isMember(userId, orgId);
      } catch (error) {
        this.logger?.error?.(
          `[AppSyncService] orgService.isMember failed orgId=${orgId} userId=${userId}: ${error?.message ?? error}`,
        );
        return failure(500, 'Failed to verify organisation membership');
      }

      if (isMember !== true) {
        this.logger?.debug?.(`[AppSyncService] org membership denied orgId=${orgId} userId=${userId}`);
        return failure(403, `Not a member of organisation: ${orgId}`);
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
        return failure(400, 'Schema validation failed', { details: validationErrors });
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
      return failure(500, 'Sync failed');
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
      return failure(500, 'Malformed sync response');
    }

    // ── Document ownership index side-effects ───────────────────────────────
    if (this.documentIndexRepository != null && changes.length > 0) {
      if (typeof this.documentIndexRepository.upsertOwnership !== 'function') {
        this.logger?.error?.('[AppSyncService] documentIndexRepository missing upsertOwnership');
        return failure(500, 'Document index repository is misconfigured');
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
          return failure(500, 'Document ownership index update failed');
        }
      }
    }

    return { statusCode: 200, body: syncResult };
  }
}
