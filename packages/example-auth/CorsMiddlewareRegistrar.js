// packages/example-auth/CorsMiddlewareRegistrar.js
/**
 * CorsMiddlewareRegistrar — registers CORS middleware for the local POC server.
 *
 * Must be registered BEFORE GoogleIdTokenMiddlewareRegistrar and AppSyncController
 * in the CDI context so CORS headers are added to all responses (including 401s).
 */
import { cors } from 'hono/cors';

export default class CorsMiddlewareRegistrar {
  // No __routes — uses the imperative routes() hook only

  routes(app) {
    app.use('*', cors({
      origin: ['http://localhost:8080', 'http://127.0.0.1:8080'],
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
      maxAge: 300,
    }));
  }
}
