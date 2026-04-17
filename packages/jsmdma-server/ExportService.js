/**
 * ExportService.js — Full-data export for user accounts and organisations.
 *
 * Provides two public methods:
 *
 *   exportUser(userId)  — returns all documents and docIndex entries for a user
 *   exportOrg(orgId)    — returns org record, members, and all org-scoped docs
 *
 * Both methods use changesSince(key, HLC.zero()) to retrieve every document
 * in a given collection namespace (since HLC.zero() is less than any real HLC,
 * the filter returns all docs).
 *
 * Dependencies (CDI autowired by name):
 *   this.userRepository          — UserRepository instance
 *   this.orgRepository           — OrgRepository instance
 *   this.documentIndexRepository — DocumentIndexRepository instance
 *   this.syncRepository          — SyncRepository instance
 *   this.applicationRegistry     — ApplicationRegistry instance
 *   this.logger                  — optional logger
 */
import { HLC } from '@alt-javascript/jsmdma-core';
import { namespaceKey } from './namespaceKey.js';

export default class ExportService {
  constructor() {
    // CDI will autowire these; direct injection used in tests
    this.userRepository          = null;
    this.orgRepository           = null;
    this.documentIndexRepository = null;
    this.syncRepository          = null;
    this.applicationRegistry     = null;
    this.logger                  = null;
  }

  /**
   * Export all data for a single user account.
   *
   * @param {string} userId
   * @returns {Promise<{ user: Object|null, docs: Object, docIndex: Object[] }>}
   *   user     — full user record from UserRepository, or null if not found
   *   docs     — { [app]: { [collection]: Object[] } } — sparse, empty keys pruned
   *   docIndex — all docIndex entries owned by this user across all apps
   */
  async exportUser(userId) {
    const apps = this.applicationRegistry.getApplications();

    // ── Fetch user record ──────────────────────────────────────────────────
    const user = await this.userRepository.getUser(userId);

    // ── Collect docIndex entries and docs per app ──────────────────────────
    const docs      = {};
    const allEntries = [];

    for (const app of apps) {
      // Fetch docIndex entries for this user+app
      const entries = await this.documentIndexRepository.listByUser(userId, app);
      allEntries.push(...entries);

      // Derive the unique collections touched by this user in this app
      const collections = [...new Set(entries.map((e) => e.collection))];

      for (const col of collections) {
        const nsKey = namespaceKey(userId, app, col);
        const colDocs = await this.syncRepository.changesSince(nsKey, HLC.zero());

        if (colDocs.length === 0) continue; // prune empty collections

        if (!docs[app]) docs[app] = {};
        docs[app][col] = colDocs;
      }
    }

    this.logger?.info?.(
      `[ExportService] exportUser userId=${userId} apps=${apps.length} docIndexCount=${allEntries.length}`,
    );

    return { user, docs, docIndex: allEntries };
  }

  /**
   * Export all data for an organisation.
   *
   * @param {string} orgId
   * @returns {Promise<{ org: Object|null, members: Object[], docs: Object }>}
   *   org     — org record from OrgRepository, or null if not found
   *   members — array of membership records for the org
   *   docs    — { [app]: { [collection]: Object[] } } — sparse, empty keys pruned
   */
  async exportOrg(orgId) {
    const apps = this.applicationRegistry.getApplications();

    // ── Fetch org and members ──────────────────────────────────────────────
    const org     = await this.orgRepository.getOrg(orgId);
    const members = org != null
      ? await this.orgRepository.getOrgMembers(orgId)
      : [];

    // ── Collect org-scoped docs per app ────────────────────────────────────
    const docs = {};

    if (org != null) {
      for (const app of apps) {
        const appConfig  = this.applicationRegistry.getConfig(app);
        const collections = appConfig?.collections
          ? Object.keys(appConfig.collections)
          : [];

        for (const col of collections) {
          // Org-scoped key: 'org:{orgId}:{app}:{col}' — NOT namespaceKey()
          const nsKey  = `org:${orgId}:${app}:${col}`;
          const colDocs = await this.syncRepository.changesSince(nsKey, HLC.zero());

          if (colDocs.length === 0) continue; // prune empty collections

          if (!docs[app]) docs[app] = {};
          docs[app][col] = colDocs;
        }
      }
    }

    this.logger?.info?.(
      `[ExportService] exportOrg orgId=${orgId} found=${org != null} members=${members.length}`,
    );

    return { org, members, docs };
  }
}
