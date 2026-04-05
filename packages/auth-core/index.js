/**
 * index.js — Public exports for @alt-javascript/jsmdma-auth-core
 */

export { default as JwtSession } from './JwtSession.js';

export {
  InvalidTokenError,
  IdleExpiredError,
  HardExpiredError,
  InvalidStateError,
  ProviderError,
} from './errors.js';

export { default as GoogleProvider }    from './providers/google.js';
export { default as GitHubProvider }    from './providers/github.js';
export { default as MicrosoftProvider } from './providers/microsoft.js';
export { default as AppleProvider }     from './providers/apple.js';
