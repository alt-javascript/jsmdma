/**
 * jsmdmaHonoStarter.js — Canonical CDI registration bundle for jsmdma sync+auth on Hono.
 *
 * Usage:
 *   import { jsmdmaHonoStarter } from '@alt-javascript/jsmdma-hono';
 *   const context = new Context([...jsmdmaHonoStarter()]);
 *
 * Composition order is intentional:
 *   1) Hono + jsnosql boot infrastructure
 *   2) sync services and application/schema wiring
 *   3) auth-hono starter (includes AuthMiddlewareRegistrar)
 *   4) AppSyncController (must come after auth middleware registration)
 */
import { honoStarter } from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration } from '@alt-javascript/boot-jsnosqlc';
import {
  SyncRepository,
  SyncService,
  ApplicationRegistry,
  SchemaValidator,
} from '@alt-javascript/jsmdma-server';
import { authHonoStarter } from '@alt-javascript/jsmdma-auth-hono';
import AppSyncController from './AppSyncController.js';

class JsmdmaHonoStarterConfigValidator {
  constructor() {
    this.jwtSecret    = null; // property-injected from auth.jwt.secret
    this.applications = null; // property-injected from applications
  }

  // Imperative routes() hook is invoked during Hono route registration at startup.
  // We use it as a fail-fast config guard before runtime traffic can hit endpoints.
  routes() {
    if (typeof this.jwtSecret !== 'string' || this.jwtSecret.length < 32) {
      throw new Error('[jsmdmaHonoStarter] Missing or invalid config at auth.jwt.secret (expected string length >= 32)');
    }

    if (!this.applications || typeof this.applications !== 'object' || Array.isArray(this.applications)) {
      throw new Error('[jsmdmaHonoStarter] Missing or invalid config at applications (expected object map of app configs)');
    }
  }
}

/**
 * Build the canonical registration list for jsmdma sync+auth on Hono.
 *
 * @param {object} [options] - Reserved for future advanced composition options.
 * @returns {Array<object>} CDI registration descriptors
 */
export function jsmdmaHonoStarter(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('[jsmdmaHonoStarter] options must be an object when provided');
  }

  const unsupported = Object.keys(options);
  if (unsupported.length > 0) {
    throw new Error(`[jsmdmaHonoStarter] Unsupported options: ${unsupported.join(', ')}`);
  }

  return [
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),

    // Fail fast on missing required config to keep startup diagnostics explicit.
    {
      Reference: JsmdmaHonoStarterConfigValidator,
      name:      'jsmdmaHonoStarterConfigValidator',
      scope:     'singleton',
      properties: [
        { name: 'jwtSecret',    path: 'auth.jwt.secret' },
        { name: 'applications', path: 'applications' },
      ],
    },

    // Sync stack
    { Reference: SyncRepository, name: 'syncRepository', scope: 'singleton' },
    { Reference: SyncService,    name: 'syncService',    scope: 'singleton' },
    {
      Reference:  ApplicationRegistry,
      name:       'applicationRegistry',
      scope:      'singleton',
      properties: [{ name: 'applications', path: 'applications' }],
    },
    {
      Reference:  SchemaValidator,
      name:       'schemaValidator',
      scope:      'singleton',
      properties: [{ name: 'applications', path: 'applications' }],
    },

    // Auth stack (includes authMiddlewareRegistrar before auth controllers)
    ...authHonoStarter(),

    // Protected sync route controller (must remain after auth middleware registration)
    { Reference: AppSyncController, name: 'appSyncController', scope: 'singleton' },
  ];
}
