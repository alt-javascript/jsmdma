/**
 * SearchService.js — ACL-gated search over the sync document store.
 *
 * Accepts a filter AST and returns all documents matching that filter that the
 * requesting user is authorised to see.  ACL rules mirror the SyncService
 * fan-out pattern:
 *
 *   1. Own documents — all docs in the user's own namespace that match the
 *      filter are returned unconditionally.
 *   2. Cross-namespace documents — documentIndexRepository.listAccessibleDocs
 *      determines which foreign docs the user may see (public, shared, org).
 *      For each accessible foreign doc we run findByFilter against the owner's
 *      namespace and keep only the docs whose _key appears in the accessible set.
 *
 * If documentIndexRepository is null (backward-compat / no-index deployments),
 * only own documents are returned.
 *
 * Dependencies (CDI autowired by name):
 *   this.syncRepository          — SyncRepository instance
 *   this.documentIndexRepository — DocumentIndexRepository instance (nullable)
 *   this.logger                  — optional logger
 */
import { namespaceKey } from './namespaceKey.js';

export default class SearchService {
  constructor() {
    // CDI will autowire these; direct injection used in tests
    this.syncRepository = null;
    this.documentIndexRepository = null;
    this.logger = null;
  }

  /**
   * Search for documents matching filterAst that are accessible to userId.
   *
   * @param {string}   collection  — logical collection name (e.g. 'planners')
   * @param {Object}   filterAst   — pre-built filter AST (do NOT call .build() again)
   * @param {string}   userId      — identity of the requesting user (JWT sub)
   * @param {string}   application — application name from URL path
   * @param {string[]} [orgIds=[]] — org IDs the user belongs to (reserved for future use)
   * @returns {Promise<Object[]>}  — flat array of matching, accessible documents
   */
  async search(collection, filterAst, userId, application, orgIds = []) {
    // ── Step 1: own documents ─────────────────────────────────────────────────
    const ownCollection = namespaceKey(userId, application, collection);
    const ownResults = await this.syncRepository.findByFilter(ownCollection, filterAst);

    // ── Null-guard: if no docIndex, return only own docs ──────────────────────
    if (this.documentIndexRepository == null) {
      this.logger?.info?.(
        `[SearchService] search userId=${userId} app=${application} collection=${collection} results=${ownResults.length}`,
      );
      return ownResults;
    }

    // ── Step 2: cross-namespace fan-out ───────────────────────────────────────
    const accessibleEntries = await this.documentIndexRepository.listAccessibleDocs(
      userId, application, orgIds,
    );

    // Group entries from OTHER users by (userId, collection)
    const byOwnerCollection = new Map();
    for (const entry of accessibleEntries) {
      if (entry.userId === userId) continue; // own docs already fetched above
      const mapKey = `${entry.userId}\0${entry.collection}`;
      if (!byOwnerCollection.has(mapKey)) byOwnerCollection.set(mapKey, []);
      byOwnerCollection.get(mapKey).push(entry);
    }

    const crossResults = [];

    for (const [, colEntries] of byOwnerCollection) {
      const { userId: ownerId, collection: col } = colEntries[0];
      const crossNamespaceKey = namespaceKey(ownerId, application, col);

      // Find all docs in the owner's namespace matching the filter
      const candidates = await this.syncRepository.findByFilter(crossNamespaceKey, filterAst);

      // ACL gate: keep only docs whose _key is in the accessible set for this group
      const accessibleKeys = new Set(colEntries.map((e) => e.docKey));
      for (const doc of candidates) {
        if (accessibleKeys.has(doc._key)) {
          crossResults.push(doc);
        }
      }
    }

    const results = [...ownResults, ...crossResults];

    this.logger?.info?.(
      `[SearchService] search userId=${userId} app=${application} collection=${collection} results=${results.length}`,
    );

    return results;
  }
}
