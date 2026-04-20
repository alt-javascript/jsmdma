/**
 * jsmdmaHonoStarter.js — Canonical CDI registration bundle for jsmdma sync+auth on Hono.
 *
 * Usage:
 *   import { jsmdmaHonoStarter } from '@alt-javascript/jsmdma-hono';
 *   const context = new Context([...jsmdmaHonoStarter()]);
 *
 * Composition order is intentional:
 *   1) Hono + jsnosql boot infrastructure
 *   2) (optional) sync services and application/schema wiring
 *   3) (optional) auth stack foundation: auth-hono middleware + boot oauth registrations
 *   4) (optional) AppSyncController (must stay after auth middleware)
 *
 * Advanced options are constrained to prevent impossible/wiring-unsafe combinations:
 *   - feature toggles are boolean-only and dependency-validated
 *   - hook insertion points are stage-scoped and validated
 */
import { honoStarter } from '@alt-javascript/boot-hono';
import { jsnosqlcAutoConfiguration } from '@alt-javascript/boot-jsnosqlc';
import { oauthStarter } from '@alt-javascript/boot-oauth';
import { oauthJsnosqlcStarter } from '@alt-javascript/boot-oauth-jsnosqlc';
import {
  SyncRepository,
  SyncService,
  AppSyncService,
  ApplicationRegistry,
  SchemaValidator,
} from '@alt-javascript/jsmdma-server';
import {
  splitAuthHonoStarterRegistrations,
} from '@alt-javascript/jsmdma-auth-hono';
import AppSyncController from './AppSyncController.js';

const ALLOWED_OPTION_KEYS = ['features', 'hooks'];
const FEATURE_DEFAULTS = Object.freeze({
  configValidation: true,
  sync:             true,
  auth:             true,
  appSyncController: true,
});
const ALLOWED_FEATURE_KEYS = Object.keys(FEATURE_DEFAULTS);
const HOOK_STAGES = Object.freeze([
  'beforeSync',
  'beforeAuth',
  'beforeAppSync',
  'afterAppSync',
]);

function asRegistrationName(reference) {
  const name = reference?.name;
  if (!name || typeof name !== 'string') {
    return null;
  }
  return `${name[0].toLowerCase()}${name.slice(1)}`;
}

function cloneRegistrationDescriptor(entry) {
  return {
    ...entry,
    constructorArgs: Array.isArray(entry.constructorArgs) ? [...entry.constructorArgs] : entry.constructorArgs,
    properties:      Array.isArray(entry.properties) ? entry.properties.map((p) => ({ ...p })) : entry.properties,
  };
}

function normalizeHookRegistration(stage, entry, idx) {
  if (typeof entry === 'function') {
    const derivedName = asRegistrationName(entry);
    if (!derivedName) {
      throw new TypeError(
        `[jsmdmaHonoStarter] hooks.${stage}[${idx}] function/class must have a name so a deterministic CDI registration name can be derived`,
      );
    }
    return { Reference: entry, name: derivedName, scope: 'singleton' };
  }

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError(
      `[jsmdmaHonoStarter] hooks.${stage}[${idx}] must be a function/class or a registration object`,
    );
  }

  if (typeof entry.Reference !== 'function') {
    throw new TypeError(
      `[jsmdmaHonoStarter] hooks.${stage}[${idx}] registration object must include Reference (function/class)`,
    );
  }

  if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
    throw new TypeError(
      `[jsmdmaHonoStarter] hooks.${stage}[${idx}] registration object must include a non-empty name`,
    );
  }

  return cloneRegistrationDescriptor(entry);
}

function normalizeHooks(rawHooks = {}) {
  if (!rawHooks || typeof rawHooks !== 'object' || Array.isArray(rawHooks)) {
    throw new TypeError('[jsmdmaHonoStarter] hooks must be an object map keyed by hook stage');
  }

  const unsupportedStages = Object.keys(rawHooks).filter((stage) => !HOOK_STAGES.includes(stage));
  if (unsupportedStages.length > 0) {
    throw new Error(
      `[jsmdmaHonoStarter] Unsupported hook stage(s): ${unsupportedStages.join(', ')}. Allowed stages: ${HOOK_STAGES.join(', ')}`,
    );
  }

  return HOOK_STAGES.reduce((acc, stage) => {
    const rawStageEntries = rawHooks[stage];
    if (rawStageEntries === undefined) {
      acc[stage] = [];
      return acc;
    }

    const stageEntries = Array.isArray(rawStageEntries) ? rawStageEntries : [rawStageEntries];
    acc[stage] = stageEntries.map((entry, idx) => normalizeHookRegistration(stage, entry, idx));
    return acc;
  }, {});
}

function normalizeFeatures(rawFeatures = {}) {
  if (!rawFeatures || typeof rawFeatures !== 'object' || Array.isArray(rawFeatures)) {
    throw new TypeError('[jsmdmaHonoStarter] features must be an object map of boolean flags');
  }

  const unsupportedFeatures = Object.keys(rawFeatures).filter((key) => !ALLOWED_FEATURE_KEYS.includes(key));
  if (unsupportedFeatures.length > 0) {
    throw new Error(
      `[jsmdmaHonoStarter] Unsupported feature flag(s): ${unsupportedFeatures.join(', ')}. Allowed flags: ${ALLOWED_FEATURE_KEYS.join(', ')}`,
    );
  }

  const normalized = { ...FEATURE_DEFAULTS };
  for (const featureKey of ALLOWED_FEATURE_KEYS) {
    if (rawFeatures[featureKey] === undefined) {
      continue;
    }

    if (typeof rawFeatures[featureKey] !== 'boolean') {
      throw new TypeError(`[jsmdmaHonoStarter] features.${featureKey} must be a boolean`);
    }

    normalized[featureKey] = rawFeatures[featureKey];
  }

  const closureViolations = [];

  if (normalized.sync && !normalized.auth) {
    closureViolations.push('features.sync requires features.auth=true so /:application/sync remains protected by auth middleware');
  }

  if (normalized.appSyncController && !normalized.sync) {
    closureViolations.push('features.appSyncController requires features.sync=true');
  }

  if (normalized.appSyncController && !normalized.auth) {
    closureViolations.push('features.appSyncController requires features.auth=true');
  }

  if (closureViolations.length > 0) {
    throw new Error(`[jsmdmaHonoStarter] Unsupported feature combination:\n- ${closureViolations.join('\n- ')}`);
  }

  return normalized;
}

function createConfigValidatorReference({ requireJwtSecret, requireApplications }) {
  return class JsmdmaHonoStarterConfigValidator {
    constructor() {
      this.jwtSecret    = null; // property-injected from auth.jwt.secret
      this.applications = null; // property-injected from applications
    }

    // Imperative routes() hook is invoked during Hono route registration at startup.
    // We use it as a fail-fast config guard before runtime traffic can hit endpoints.
    routes() {
      if (requireJwtSecret && (typeof this.jwtSecret !== 'string' || this.jwtSecret.length < 32)) {
        throw new Error('[jsmdmaHonoStarter] Missing or invalid config at auth.jwt.secret (expected string length >= 32)');
      }

      if (requireApplications && (!this.applications || typeof this.applications !== 'object' || Array.isArray(this.applications))) {
        throw new Error('[jsmdmaHonoStarter] Missing or invalid config at applications (expected object map of app configs)');
      }
    }
  };
}

function assertUniqueRegistrationNames(registrations) {
  const seen = new Set();
  const duplicateNames = new Set();

  for (const registration of registrations) {
    const name = registration?.name;
    if (!name || typeof name !== 'string') {
      continue;
    }

    if (seen.has(name)) {
      duplicateNames.add(name);
      continue;
    }

    seen.add(name);
  }

  if (duplicateNames.size > 0) {
    throw new Error(
      `[jsmdmaHonoStarter] Duplicate CDI registration name(s) detected: ${[...duplicateNames].join(', ')}`,
    );
  }
}

/**
 * Build the canonical registration list for jsmdma sync+auth on Hono.
 *
 * @param {object} [options]
 * @param {object} [options.features] - boolean feature toggles for advanced composition.
 * @param {object} [options.hooks] - stage-keyed hook registrations inserted around core stages.
 * @returns {Array<object>} CDI registration descriptors
 */
export function jsmdmaHonoStarter(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('[jsmdmaHonoStarter] options must be an object when provided');
  }

  const unsupportedOptions = Object.keys(options).filter((key) => !ALLOWED_OPTION_KEYS.includes(key));
  if (unsupportedOptions.length > 0) {
    throw new Error(
      `[jsmdmaHonoStarter] Unsupported options: ${unsupportedOptions.join(', ')}. Allowed options: ${ALLOWED_OPTION_KEYS.join(', ')}`,
    );
  }

  const features = normalizeFeatures(options.features ?? {});
  const hooks = normalizeHooks(options.hooks ?? {});

  const registrations = [
    ...honoStarter(),
    ...jsnosqlcAutoConfiguration(),
  ];

  if (features.configValidation) {
    const validatorProperties = [];

    if (features.auth) {
      validatorProperties.push({ name: 'jwtSecret', path: 'auth.jwt.secret' });
    }

    if (features.sync || features.appSyncController) {
      validatorProperties.push({ name: 'applications', path: 'applications' });
    }

    registrations.push({
      Reference: createConfigValidatorReference({
        requireJwtSecret:    features.auth,
        requireApplications: features.sync || features.appSyncController,
      }),
      name: 'jsmdmaHonoStarterConfigValidator',
      scope: 'singleton',
      properties: validatorProperties,
    });
  }

  registrations.push(...hooks.beforeSync);

  if (features.sync) {
    registrations.push(
      { Reference: SyncRepository,  name: 'syncRepository',  scope: 'singleton' },
      { Reference: SyncService,     name: 'syncService',     scope: 'singleton' },
      { Reference: AppSyncService,  name: 'appSyncService',  scope: 'singleton' },
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
    );
  }

  registrations.push(...hooks.beforeAuth);

  if (features.auth) {
    const {
      infrastructureRegistrations,
      legacyControllerRegistrations,
    } = splitAuthHonoStarterRegistrations();

    registrations.push(
      ...infrastructureRegistrations,
      ...oauthJsnosqlcStarter(),
      ...oauthStarter(),
      ...legacyControllerRegistrations,
    );
  }

  registrations.push(...hooks.beforeAppSync);

  if (features.appSyncController) {
    registrations.push({ Reference: AppSyncController, name: 'appSyncController', scope: 'singleton' });
  }

  registrations.push(...hooks.afterAppSync);

  assertUniqueRegistrationNames(registrations);

  return registrations;
}
