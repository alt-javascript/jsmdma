/**
 * index.js — Public exports for @alt-javascript/jsmdma-auth-hono
 */

export { authMiddleware, getUser } from './authMiddleware.js';
export {
  defaultErrorCodeForStatus,
  defaultErrorMessageForStatus,
  normalizeFrameworkErrorBody,
} from './frameworkErrorContract.js';
export {
  default as FrameworkErrorContractMiddleware,
  frameworkErrorContractMiddleware,
} from './FrameworkErrorContractMiddleware.js';
export { default as AuthController } from './AuthController.js';
export { default as AuthMiddlewareRegistrar } from './AuthMiddlewareRegistrar.js';
export {
  createSessionModeError,
  normalizeSessionModeLiteral,
  resolveSessionMode,
  sessionModeAliases,
} from './sessionModeContract.js';
export { default as OrgController } from './OrgController.js';
export { authHonoStarter } from './authHonoStarter.js';
