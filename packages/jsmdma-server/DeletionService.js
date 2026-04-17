/**
 * DeletionService.js — Hard-delete cascade for user accounts and organisations.
 *
 * Provides two public methods:
 *
 *   deleteUser(userId)  — removes all docs, docIndex entries, memberships,
 *                         and the user identity record for a given user
 *   deleteOrg(orgId)    — removes all org-scoped docs, all members, the name
 *                         reservation, and the org record
 *
 * Both methods are idempotent: calling them on an already-deleted entity
 * performs no harmful operations (deleteUser delegates to userRepository.deleteUser
 * which is idempotent; deleteOrg guards with an early return if org is null).
 *
 * Dependencies (CDI autowired by name):
 *   this.userRepository          — UserRepository instance
 *   this.orgRepository           — OrgRepository instance
 *   this.documentIndexRepository — DocumentIndexRepository instance
 *   this.syncRepository          — SyncRepository instance
 *   this.applicationRegistry     — ApplicationRegistry instance
 *   this.logger                  — optional logger
 */
import { HLC } from 'packages/jsmdma-core';
import { namespaceKey } from './namespaceKey.js';

export default class DeletionService {
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
   * Hard-delete a user account and all associated data.
   *
   * Steps:
   *   1. For each configured app: delete all synced docs and docIndex entries
   *   2. Remove user from all orgs (findOrgsByUser + removeMember)
   *   3. Delete the user identity record (idempotent)
   *
   * @param {string} userId
   * @returns {Promise<void>}
   */
  async deleteUser(userId) {
    const apps = this.applicationRegistry.getApplications();
    let docsDeleted = 0;

    // ── 1. Delete docs and docIndex entries per app ────────────────────────
    for (const app of apps) {
      const entries = await this.documentIndexRepository.listByUser(userId, app);
      const collections = [...new Set(entries.map((e) => e.collection))];

      for (const col of collections) {
        const nsKey = namespaceKey(userId, app, col);
        const docs  = await this.syncRepository.changesSince(nsKey, HLC.zero());
        for (const doc of docs) {
          await this.syncRepository.delete(nsKey, doc._key);
          docsDeleted++;
        }
      }

      for (const entry of entries) {
        await this.documentIndexRepository.delete(entry._key);
      }
    }

    // ── 2. Remove org memberships ──────────────────────────────────────────
    const memberships = await this.orgRepository.findOrgsByUser(userId);
    for (const m of memberships) {
      await this.orgRepository.removeMember(m.orgId, userId);
    }

    // ── 3. Delete user identity record ────────────────────────────────────
    await this.userRepository.deleteUser(userId);

    this.logger?.info?.(
      `[DeletionService] deleteUser userId=${userId} apps=${apps.length} docsDeleted=${docsDeleted}`,
    );
  }

  /**
   * Hard-delete an organisation and all associated data.
   *
   * Steps:
   *   1. Guard: return early if org does not exist (idempotent)
   *   2. For each configured app: delete all org-scoped synced docs
   *   3. Remove all members from the org
   *   4. Release the org name reservation
   *   5. Delete the org record
   *
   * @param {string} orgId
   * @returns {Promise<void>}
   */
  async deleteOrg(orgId) {
    // ── 1. Guard: idempotent if org already gone ───────────────────────────
    const org = await this.orgRepository.getOrg(orgId);
    if (org == null) return;

    const apps = this.applicationRegistry.getApplications();
    let docsDeleted = 0;

    // ── 2. Delete org-scoped docs per app+collection ──────────────────────
    for (const app of apps) {
      const appConfig    = this.applicationRegistry.getConfig(app);
      const collections  = appConfig?.collections ? Object.keys(appConfig.collections) : [];

      for (const col of collections) {
        const nsKey = `org:${orgId}:${app}:${col}`;
        const docs  = await this.syncRepository.changesSince(nsKey, HLC.zero());
        for (const doc of docs) {
          await this.syncRepository.delete(nsKey, doc._key);
          docsDeleted++;
        }
      }
    }

    // ── 3. Remove all members ─────────────────────────────────────────────
    const members = await this.orgRepository.getOrgMembers(orgId);
    for (const m of members) {
      await this.orgRepository.removeMember(orgId, m.userId);
    }

    // ── 4. Release org name reservation ───────────────────────────────────
    await this.orgRepository.releaseName(org.name);

    // ── 5. Delete org record ───────────────────────────────────────────────
    await this.orgRepository.deleteOrg(orgId);

    this.logger?.info?.(
      `[DeletionService] deleteOrg orgId=${orgId} docsDeleted=${docsDeleted} membersDeleted=${members.length}`,
    );
  }
}
