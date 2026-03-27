/**
 * ApplicationRegistry.js — Config-driven application allowlist.
 *
 * Reads an 'applications' config block (injected via CDI property) and
 * exposes simple allow/list queries.  The applications config is expected
 * to be an object whose keys are the allowed application names:
 *
 *   applications:
 *     todo: { ... }
 *     shopping-list: { ... }
 *
 * CDI property injection:
 *   { name: 'applications', path: 'applications' }
 *
 * The value may be null/undefined if no applications block is configured,
 * in which case all applications are rejected.
 */
export default class ApplicationRegistry {
  constructor() {
    this.applications = null; // CDI property-injected from config
  }

  /**
   * Return true if the given application name is in the configured allowlist.
   * @param {string} name
   * @returns {boolean}
   */
  isAllowed(name) {
    if (!this.applications || typeof this.applications !== 'object') return false;
    return Object.prototype.hasOwnProperty.call(this.applications, name);
  }

  /**
   * Return the list of configured application names.
   * @returns {string[]}
   */
  getApplications() {
    if (!this.applications || typeof this.applications !== 'object') return [];
    return Object.keys(this.applications);
  }

  /**
   * Return the config block for a specific application, or null.
   * @param {string} name
   * @returns {Object|null}
   */
  getConfig(name) {
    if (!this.isAllowed(name)) return null;
    return this.applications[name] ?? null;
  }
}
