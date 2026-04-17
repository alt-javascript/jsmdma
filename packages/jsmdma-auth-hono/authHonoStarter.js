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
  from 'packages/jsmdma-auth-server';
import FrameworkErrorContractMiddleware from './FrameworkErrorContractMiddleware.js';
import AuthMiddlewareRegistrar from './AuthMiddlewareRegistrar.js';
import AuthController          from './AuthController.js';
import OrgController           from './OrgController.js';

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
    { Reference: AuthController, name: 'authController', scope: 'singleton' },
    {
      Reference: OrgController,
      name:      'orgController',
      scope:     'singleton',
      properties: [{ name: 'registerable', path: 'orgs.registerable' }],
    },
  ];
}
