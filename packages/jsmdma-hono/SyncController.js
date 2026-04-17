/**
 * SyncController.js — Hono controller for the jsmdma sync endpoint.
 *
 * Exposes two routes:
 *   GET  /health — liveness check
 *   POST /sync   — accept a client changeset, apply merge, return server changes
 *
 * Uses the boot-hono static __routes convention:
 *   - handler methods receive { body, params, query, user }
 *   - returning a plain object → 200 JSON
 *   - returning { statusCode, body } → custom status code
 *
 * CDI autowiring (by name):
 *   this.syncService — SyncService instance
 *   this.logger      — optional logger
 *
 * Request body for POST /sync:
 *   {
 *     collection:  string,    — required: which collection to sync
 *     clientClock: string,    — required: HLC hex string (highest clock client has seen)
 *     changes:     Change[]   — optional: client's local changes since clientClock
 *   }
 *
 *   Change shape:
 *   {
 *     key:       string,    — document key
 *     doc:       Object,    — current local document
 *     fieldRevs: Object,    — per-field HLC revisions { fieldName: hlcString }
 *     baseClock: string     — HLC of the base document this change was made against
 *   }
 *
 * Response for POST /sync (200):
 *   {
 *     serverClock:   string,    — server's updated HLC
 *     serverChanges: Doc[],     — docs the client hasn't seen yet
 *     conflicts:     Conflict[] — any fields where both sides changed
 *   }
 */
export default class SyncController {
  static __routes = [
    { method: 'GET',  path: '/health', handler: 'health' },
    { method: 'POST', path: '/sync',   handler: 'sync'   },
  ];

  constructor() {
    this.syncService = null; // CDI autowired
    this.logger      = null; // CDI autowired
  }

  /**
   * GET /health
   */
  health() {
    return { status: 'ok' };
  }

  /**
   * POST /sync
   * @param {{ body: Object }} request
   */
  async sync(request) {
    const body = request.body;

    if (!body || typeof body !== 'object') {
      return { statusCode: 400, body: { error: 'Request body is required' } };
    }

    const { collection, clientClock, changes = [] } = body;

    if (!collection || typeof collection !== 'string') {
      return { statusCode: 400, body: { error: 'Missing required field: collection' } };
    }
    if (!clientClock || typeof clientClock !== 'string') {
      return { statusCode: 400, body: { error: 'Missing required field: clientClock' } };
    }

    this.logger?.debug?.(`[SyncController] POST /sync collection=${collection} clientClock=${clientClock} changes=${changes.length}`);

    const result = await this.syncService.sync(collection, clientClock, changes);
    return result;
  }
}
