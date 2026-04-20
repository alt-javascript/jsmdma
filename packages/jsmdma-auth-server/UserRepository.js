/**
 * UserRepository.js — jsnosqlc-backed user profile store.
 *
 * User records remain the profile source of truth:
 *   key = userId (UUID)
 *   { userId, email, providers: [{ provider, providerUserId }], createdAt, updatedAt }
 *
 * Provider ownership is resolved by oauthIdentityLinkStore. The providers array
 * here is projection state that should be synchronized from store reads.
 */
const USERS_COL = 'users';

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertUserId(userId, operation) {
  if (!hasNonEmptyString(userId)) {
    throw new TypeError(`UserRepository.${operation} requires a non-empty userId string.`);
  }
  return userId;
}

function normalizeProviderProjectionEntry(entry, index, operation) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError(`UserRepository.${operation} provider entry at index ${index} must be an object.`);
  }

  const provider = hasNonEmptyString(entry.provider) ? entry.provider.trim() : null;
  const providerUserId = hasNonEmptyString(entry.providerUserId) ? entry.providerUserId.trim() : null;

  if (!provider || !providerUserId) {
    throw new TypeError(`UserRepository.${operation} provider entry at index ${index} must include provider and providerUserId.`);
  }

  return { provider, providerUserId };
}

function normalizeProvidersProjection(providers, operation) {
  if (providers == null) return [];
  if (!Array.isArray(providers)) {
    throw new TypeError(`UserRepository.${operation} providers must be an array.`);
  }

  const normalized = providers.map((entry, index) => (
    normalizeProviderProjectionEntry(entry, index, operation)
  ));

  const seenProviders = new Set();
  for (const entry of normalized) {
    if (seenProviders.has(entry.provider)) {
      throw new TypeError(`UserRepository.${operation} providers must not contain duplicate provider values.`);
    }
    seenProviders.add(entry.provider);
  }

  return normalized;
}

export default class UserRepository {
  constructor(nosqlClient, logger) {
    this.nosqlClient = nosqlClient;
    this.logger = logger ?? null;
  }

  _users() {
    return this.nosqlClient.getCollection(USERS_COL);
  }

  /**
   * Create a new user profile document.
   * @param {string} userId
   * @param {string|null} email
   * @param {Array<{provider:string,providerUserId:string}>} providers
   * @returns {Promise<Object>} created user
   */
  async create(userId, email, providers = []) {
    const normalizedUserId = assertUserId(userId, 'create');
    const normalizedProviders = normalizeProvidersProjection(providers, 'create');
    const now = new Date().toISOString();

    const user = {
      userId: normalizedUserId,
      email: hasNonEmptyString(email) ? email.trim() : null,
      providers: normalizedProviders,
      createdAt: now,
      updatedAt: now,
    };

    await this._users().store(normalizedUserId, user);
    this.logger?.info?.(`[UserRepository] create userId=${normalizedUserId}`);

    return user;
  }

  /**
   * Synchronize the projected providers array from oauth identity-link store data.
   * @param {string} userId
   * @param {Array<{provider:string,providerUserId:string}>} providers
   * @returns {Promise<Object>} updated user
   */
  async syncProvidersProjection(userId, providers) {
    const normalizedUserId = assertUserId(userId, 'syncProvidersProjection');
    const existing = await this._users().get(normalizedUserId);
    if (!existing) throw new Error(`User not found: ${normalizedUserId}`);

    const normalizedProviders = normalizeProvidersProjection(providers, 'syncProvidersProjection');
    const updated = {
      ...existing,
      providers: normalizedProviders,
      updatedAt: new Date().toISOString(),
    };

    await this._users().store(normalizedUserId, updated);
    this.logger?.debug?.(`[UserRepository] syncProvidersProjection userId=${normalizedUserId} providers=${normalizedProviders.length}`);

    return updated;
  }

  /**
   * Update a user's email address.
   * Used when a provider supplies email only on initial login.
   * @param {string} userId
   * @param {string} email
   * @returns {Promise<Object>} updated user
   */
  async updateEmail(userId, email) {
    const normalizedUserId = assertUserId(userId, 'updateEmail');
    if (!hasNonEmptyString(email)) {
      throw new TypeError('UserRepository.updateEmail requires a non-empty email string.');
    }

    const existing = await this._users().get(normalizedUserId);
    if (!existing) throw new Error(`User not found: ${normalizedUserId}`);

    const updated = {
      ...existing,
      email: email.trim(),
      updatedAt: new Date().toISOString(),
    };

    await this._users().store(normalizedUserId, updated);
    this.logger?.debug?.(`[UserRepository] updateEmail userId=${normalizedUserId}`);

    return updated;
  }

  /**
   * Hard-delete a user profile.
   * Idempotent — no-op when user does not exist.
   * @param {string} userId
   * @returns {Promise<void>}
   */
  async deleteUser(userId) {
    const normalizedUserId = assertUserId(userId, 'deleteUser');
    const user = await this._users().get(normalizedUserId);
    if (user == null) return;

    await this._users().delete(normalizedUserId);
    this.logger?.info?.(`[UserRepository] deleteUser userId=${normalizedUserId}`);
  }

  /**
   * Get a user by userId.
   * @param {string} userId
   * @returns {Promise<Object|null>}
   */
  async getUser(userId) {
    const normalizedUserId = assertUserId(userId, 'getUser');
    return this._users().get(normalizedUserId) ?? null;
  }
}
