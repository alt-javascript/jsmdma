/**
 * index.js — Public exports for @alt-javascript/jsmdma-hono
 */

export { default as AppSyncController }  from './AppSyncController.js';
export { default as DocIndexController } from './DocIndexController.js';
export { default as SearchController }   from './SearchController.js';
export { default as ExportController }   from './ExportController.js';
export { default as DeletionController } from './DeletionController.js';
export { jsmdmaHonoStarter } from './jsmdmaHonoStarter.js';

// SyncController is retained for reference but no longer registered in the CDI context.
// Use AppSyncController for all new deployments.
export { default as SyncController } from './SyncController.js';
