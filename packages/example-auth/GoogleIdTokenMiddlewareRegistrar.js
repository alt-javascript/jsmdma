// packages/example-auth/GoogleIdTokenMiddlewareRegistrar.js
/**
 * GoogleIdTokenMiddlewareRegistrar — verifies Google OIDC ID tokens for local POC.
 *
 * Replaces AuthMiddlewareRegistrar in the local server. Accepts a raw Google
 * ID token as the Bearer credential and verifies it against Google's JWKS.
 *
 * Sets c.set('user', { sub: 'google:' + claims.sub }) — AppSyncController reads
 * honoCtx.get('user').sub as the userId for storage namespacing.
 *
 * CDI property injection:
 *   this.googleClientId — audience for token verification (required)
 *   this.logger         — optional logger
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUER   = 'https://accounts.google.com';

export default class GoogleIdTokenMiddlewareRegistrar {
  // No __routes — uses the imperative routes() hook only

  constructor() {
    this.googleClientId = null; // CDI property-injected from config
    this.logger         = null; // CDI autowired (optional)
  }

  /**
   * Register Google ID token verification middleware on the sync route.
   * @param {import('hono').Hono} app
   */
  routes(app) {
    const clientId = this.googleClientId;
    const logger   = this.logger;

    if (!clientId) {
      logger?.warn?.('[GoogleIdTokenMiddlewareRegistrar] googleClientId not configured — sync will return 401');
      return;
    }

    const JWKS = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

    const mw = async (c, next) => {
      const authHeader = c.req.header('Authorization');

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        logger?.debug?.('[GoogleIdTokenMiddlewareRegistrar] missing Authorization header');
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const token = authHeader.slice(7); // strip 'Bearer '

      try {
        const { payload: claims } = await jwtVerify(token, JWKS, {
          issuer:   GOOGLE_ISSUER,
          audience: clientId,
        });

        // Set the user identity on the Hono context — AppSyncController reads this.
        // 'google:' prefix keeps userIds provider-namespaced for the local POC.
        c.set('user', { sub: `google:${claims.sub}` });
        logger?.debug?.(`[GoogleIdTokenMiddlewareRegistrar] verified Google user sub=${claims.sub}`);
        await next();
      } catch (err) {
        logger?.debug?.(`[GoogleIdTokenMiddlewareRegistrar] invalid token: ${err.message}`);
        return c.json({ error: 'Unauthorized' }, 401);
      }
    };

    app.use('/:application/sync', mw);
    logger?.debug?.('[GoogleIdTokenMiddlewareRegistrar] Google OIDC middleware applied to /:application/sync');
  }
}
