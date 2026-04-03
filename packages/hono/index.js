/**
 * index.js — Public exports for @alt-javascript/data-api-hono
 */

export { default as AppSyncController }  from './AppSyncController.js';
export { default as DocIndexController } from './DocIndexController.js';

// SyncController is retained for reference but no longer registered in the CDI context.
// Use AppSyncController for all new deployments.
export { default as SyncController } from './SyncController.js';
