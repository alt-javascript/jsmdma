/**
 * UserRepository.js — jsnosqlc-backed user identity store.
 *
 * Two collections:
 *
 *   users:
 *     key = userId (UUID)
 *     { userId, email, providers: [{ provider, providerUserId }], createdAt, updatedAt }
 *
 *   providerIndex:
 *     key = '{provider}:{providerUserId}'
 *     { userId, provider, providerUserId }
 *
 * The providerIndex is a lookup table: given a provider + providerUserId,
 * find the application userId (UUID) without scanning all users.
 *
 * nosqlClient injected directly (tests) or CDI-autowired (production).
 */
const USERS_COL    = 'users';
const PROVIDER_COL = 'providerIndex';

export default class UserRepository {
  constructor(nosqlClient, logger) {
    this.nosqlClient = nosqlClient;
    this.logger      = logger ?? null;
  }

  _users()    { return this.nosqlClient.getCollection(USERS_COL);    }
  _providers() { return this.nosqlClient.getCollection(PROVIDER_COL); }

  /**
   * Find a user by OAuth provider + providerUserId.
   * @param {string} provider
   * @param {string} providerUserId
   * @returns {Promise<Object|null>}
   */
  async findByProvider(provider, providerUserId) {
    const indexKey = `${provider}:${providerUserId}`;
    const entry    = await this._providers().get(indexKey);
    if (!entry) return null;
    return this._users().get(entry.userId);
  }

  /**
   * Create a new user with their first provider.
   * @param {string} userId
   * @param {string|null} email
   * @param {string} provider
   * @param {string} providerUserId
   * @returns {Promise<Object>} created user
   */
  async create(userId, email, provider, providerUserId) {
    const now  = new Date().toISOString();
    const user = {
      userId,
      email:     email ?? null,
      providers: [{ provider, providerUserId }],
      createdAt: now,
      updatedAt: now,
    };

    const indexKey = `${provider}:${providerUserId}`;
    await this._providers().store(indexKey, { userId, provider, providerUserId });
    await this._users().store(userId, user);

    this.logger?.info?.(`[UserRepository] create userId=${userId} provider=${provider}`);
    return user;
  }

  /**
   * Add a new provider to an existing user's identity.
   * @param {string} userId
   * @param {string} provider
   * @param {string} providerUserId
   * @returns {Promise<Object>} updated user
   */
  async addProvider(userId, provider, providerUserId) {
    const existing = await this._users().get(userId);
    if (!existing) throw new Error(`User not found: ${userId}`);

    const updatedProviders = [...existing.providers, { provider, providerUserId }];
    const updated = { ...existing, providers: updatedProviders, updatedAt: new Date().toISOString() };

    const indexKey = `${provider}:${providerUserId}`;
    await this._providers().store(indexKey, { userId, provider, providerUserId });
    await this._users().store(userId, updated);

    this.logger?.info?.(`[UserRepository] addProvider userId=${userId} provider=${provider}`);
    return updated;
  }

  /**
   * Update a user's email address.
   * Used when Apple (or another provider) sends email only on first login.
   * @param {string} userId
   * @param {string} email
   * @returns {Promise<Object>} updated user
   */
  async updateEmail(userId, email) {
    const existing = await this._users().get(userId);
    if (!existing) throw new Error(`User not found: ${userId}`);

    const updated = { ...existing, email, updatedAt: new Date().toISOString() };
    await this._users().store(userId, updated);

    this.logger?.debug?.(`[UserRepository] updateEmail userId=${userId}`);
    return updated;
  }

  /**
   * Remove a provider from a user's identity.
   * Caller must ensure the user has at least 2 providers before calling.
   * @param {string} userId
   * @param {string} provider
   * @returns {Promise<Object>} updated user
   */
  async removeProvider(userId, provider) {
    const existing = await this._users().get(userId);
    if (!existing) throw new Error(`User not found: ${userId}`);

    const entry = existing.providers.find((p) => p.provider === provider);
    if (!entry) throw new Error(`Provider ${provider} not found on user ${userId}`);

    // Remove from providerIndex
    const indexKey = `${provider}:${entry.providerUserId}`;
    await this._providers().delete(indexKey);

    const updatedProviders = existing.providers.filter((p) => p.provider !== provider);
    const updated = { ...existing, providers: updatedProviders, updatedAt: new Date().toISOString() };
    await this._users().store(userId, updated);

    this.logger?.info?.(`[UserRepository] removeProvider userId=${userId} provider=${provider}`);
    return updated;
  }

  /**
   * Get a user by userId.
   * @param {string} userId
   * @returns {Promise<Object|null>}
   */
  async getUser(userId) {
    return this._users().get(userId) ?? null;
  }
}
