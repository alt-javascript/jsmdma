import DocumentStore from './DocumentStore.js';

/**
 * SyncDocumentStore — ownership-aware wrapper around DocumentStore.
 *
 * Adds device/user ownership tiers:
 *   - listSyncable(userId) — docs where meta.userKey === userId (sync-eligible)
 *   - listLocal()          — all docs (device + user)
 *   - takeOwnership(uuid, userId) — re-keys a device doc to a user doc
 *
 * All CRUD operations delegate to the underlying DocumentStore.
 */
export default class SyncDocumentStore {
  constructor({ namespace } = {}) {
    this._store = new DocumentStore({ namespace });
  }

  get(uuid)         { return this._store.get(uuid); }
  set(uuid, doc)    { this._store.set(uuid, doc); }
  delete(uuid)      { this._store.delete(uuid); }
  list()            { return this._store.list(); }
  find(predicate)   { return this._store.find(predicate); }

  listSyncable(userId) {
    return this._store.list().filter(({ doc }) => doc.meta?.userKey === userId);
  }

  listLocal() {
    return this._store.list();
  }

  takeOwnership(uuid, userId) {
    const doc = this._store.get(uuid);
    if (!doc) return;
    doc.meta = { ...doc.meta, userKey: userId };
    this._store.set(uuid, doc);
  }
}

export { SyncDocumentStore };
