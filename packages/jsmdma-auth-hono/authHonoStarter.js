/**
 * authHonoStarter.js — CDI registration bundle for the jsmdma auth stack.
 *
 * Usage:
 *   import { authHonoStarter } from '@alt-javascript/jsmdma-auth-hono';
 *
 *   const context = new Context([
 *     ...honoStarter(),
 *     ...jsnosqlcAutoConfiguration(),
 *     ...authHonoStarter(),
 *     // sync controllers after auth:
 *     { Reference: AppSyncController, name: 'appSyncController', scope: 'singleton' },
 *   ]);
 *
 * After appCtx.start(), set OAuth provider instances on authController:
 *   appCtx.get('authController').providers = {
 *     google: new GoogleProvider({ clientId, clientSecret, redirectUri }),
 *   };
 *
 * Required config paths:
 *   auth.jwt.secret  — JWT signing secret (min 32 chars)
 *
 * Optional config paths:
 *   orgs.registerable — true to allow org creation (default: false)
 *
 * Registration order is significant: AuthMiddlewareRegistrar MUST appear before
 * AppSyncController and AuthController so Hono's app.use() is registered before
 * route handlers.
 */
import { UserRepository, AuthService, OrgRepository, OrgService }
  from '@alt-javascript/jsmdma-auth-server';
import FrameworkErrorContractMiddleware from './FrameworkErrorContractMiddleware.js';
import AuthMiddlewareRegistrar from './AuthMiddlewareRegistrar.js';
import AuthController          from './AuthController.js';
import OrgController           from './OrgController.js';

export const legacyAuthHonoControllerNames = Object.freeze(['authController', 'orgController']);

const requiredAuthHonoInfrastructureNames = Object.freeze([
  'frameworkErrorContractMiddleware',
  'authMiddlewareRegistrar',
]);

const legacyAuthHonoControllerNameSet = new Set(legacyAuthHonoControllerNames);

export function authHonoStarter() {
  return [
    // Repositories — no CDI dependencies, only jsnosqlc client injected
    { Reference: UserRepository, name: 'userRepository', scope: 'singleton' },
    { Reference: OrgRepository,  name: 'orgRepository',  scope: 'singleton' },

    // Services — autowired: userRepository, orgRepository, jwtSecret
    {
      Reference: AuthService,
      name:      'authService',
      scope:     'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }],
    },
    { Reference: OrgService, name: 'orgService', scope: 'singleton' },

    // Error normalizer — MUST run before route handlers so starter-driven
    // failures produce one deterministic typed envelope.
    {
      Reference: FrameworkErrorContractMiddleware,
      name:      'frameworkErrorContractMiddleware',
      scope:     'singleton',
    },

    // Middleware registrar — MUST come before AppSyncController in Context array
    // so app.use('/:application/sync', mw) fires before the route handler
    {
      Reference: AuthMiddlewareRegistrar,
      name:      'authMiddlewareRegistrar',
      scope:     'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }],
    },

    // Controllers — route handlers registered after middleware
    {
      Reference: AuthController,
      name: 'authController',
      scope: 'singleton',
      properties: [{ name: 'jwtSecret', path: 'auth.jwt.secret' }],
    },
    {
      Reference: OrgController,
      name:      'orgController',
      scope:     'singleton',
      properties: [{ name: 'registerable', path: 'orgs.registerable' }],
    },
  ];
}

export function splitAuthHonoStarterRegistrations(registrations = authHonoStarter()) {
  if (!Array.isArray(registrations)) {
    throw new TypeError('[authHonoStarter] splitAuthHonoStarterRegistrations(registrations) expects an array');
  }

  const seenNames = new Set();
  const duplicateNames = new Set();
  const infrastructureRegistrations = [];
  const legacyControllerRegistrations = [];

  registrations.forEach((registration, idx) => {
    if (!registration || typeof registration !== 'object' || Array.isArray(registration)) {
      throw new TypeError(
        `[authHonoStarter] registrations[${idx}] must be a registration object with a string name`,
      );
    }

    const { name } = registration;
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new TypeError(
        `[authHonoStarter] registrations[${idx}] must include a non-empty string name`,
      );
    }

    if (seenNames.has(name)) {
      duplicateNames.add(name);
    } else {
      seenNames.add(name);
    }

    if (legacyAuthHonoControllerNameSet.has(name)) {
      legacyControllerRegistrations.push(registration);
      return;
    }

    infrastructureRegistrations.push(registration);
  });

  if (duplicateNames.size > 0) {
    throw new Error(
      `[authHonoStarter] Duplicate registration name(s) detected: ${[...duplicateNames].join(', ')}`,
    );
  }

  const missingLegacyControllers = legacyAuthHonoControllerNames.filter((name) => !seenNames.has(name));
  if (missingLegacyControllers.length > 0) {
    throw new Error(
      `[authHonoStarter] Missing required legacy auth controller registration(s): ${missingLegacyControllers.join(', ')}`,
    );
  }

  const missingInfrastructureRegistrations = requiredAuthHonoInfrastructureNames
    .filter((name) => !infrastructureRegistrations.some((registration) => registration.name === name));
  if (missingInfrastructureRegistrations.length > 0) {
    throw new Error(
      `[authHonoStarter] Missing required infrastructure registration(s): ${missingInfrastructureRegistrations.join(', ')}`,
    );
  }

  if (infrastructureRegistrations.length === 0) {
    throw new Error('[authHonoStarter] Infrastructure registration group is empty');
  }

  return {
    infrastructureRegistrations,
    legacyControllerRegistrations,
  };
}
