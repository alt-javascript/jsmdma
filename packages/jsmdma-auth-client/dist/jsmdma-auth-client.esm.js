// DeviceSession.js
var DeviceSession = class {
  static getDeviceId() {
    let id = localStorage.getItem("dev");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("dev", id);
    }
    return id;
  }
  static getOrCreateAnonUid() {
    let uid = localStorage.getItem("anon_uid");
    if (!uid) {
      uid = crypto.randomUUID();
      localStorage.setItem("anon_uid", uid);
    }
    return uid;
  }
  static clear() {
    localStorage.removeItem("dev");
    localStorage.removeItem("anon_uid");
  }
};

// node_modules/jose/dist/browser/lib/buffer_utils.js
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var MAX_INT32 = 2 ** 32;

// node_modules/jose/dist/browser/runtime/base64url.js
var decodeBase64 = (encoded) => {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};
var decode = (input) => {
  let encoded = input;
  if (encoded instanceof Uint8Array) {
    encoded = decoder.decode(encoded);
  }
  encoded = encoded.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  try {
    return decodeBase64(encoded);
  } catch {
    throw new TypeError("The input to be decoded is not correctly encoded.");
  }
};

// node_modules/jose/dist/browser/util/errors.js
var JOSEError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.code = "ERR_JOSE_GENERIC";
    this.name = this.constructor.name;
    Error.captureStackTrace?.(this, this.constructor);
  }
};
JOSEError.code = "ERR_JOSE_GENERIC";
var JWTClaimValidationFailed = class extends JOSEError {
  constructor(message, payload, claim = "unspecified", reason = "unspecified") {
    super(message, { cause: { claim, reason, payload } });
    this.code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
    this.claim = claim;
    this.reason = reason;
    this.payload = payload;
  }
};
JWTClaimValidationFailed.code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
var JWTExpired = class extends JOSEError {
  constructor(message, payload, claim = "unspecified", reason = "unspecified") {
    super(message, { cause: { claim, reason, payload } });
    this.code = "ERR_JWT_EXPIRED";
    this.claim = claim;
    this.reason = reason;
    this.payload = payload;
  }
};
JWTExpired.code = "ERR_JWT_EXPIRED";
var JOSEAlgNotAllowed = class extends JOSEError {
  constructor() {
    super(...arguments);
    this.code = "ERR_JOSE_ALG_NOT_ALLOWED";
  }
};
JOSEAlgNotAllowed.code = "ERR_JOSE_ALG_NOT_ALLOWED";
var JOSENotSupported = class extends JOSEError {
  constructor() {
    super(...arguments);
    this.code = "ERR_JOSE_NOT_SUPPORTED";
  }
};
JOSENotSupported.code = "ERR_JOSE_NOT_SUPPORTED";
var JWEDecryptionFailed = class extends JOSEError {
  constructor(message = "decryption operation failed", options) {
    super(message, options);
    this.code = "ERR_JWE_DECRYPTION_FAILED";
  }
};
JWEDecryptionFailed.code = "ERR_JWE_DECRYPTION_FAILED";
var JWEInvalid = class extends JOSEError {
  constructor() {
    super(...arguments);
    this.code = "ERR_JWE_INVALID";
  }
};
JWEInvalid.code = "ERR_JWE_INVALID";
var JWSInvalid = class extends JOSEError {
  constructor() {
    super(...arguments);
    this.code = "ERR_JWS_INVALID";
  }
};
JWSInvalid.code = "ERR_JWS_INVALID";
var JWTInvalid = class extends JOSEError {
  constructor() {
    super(...arguments);
    this.code = "ERR_JWT_INVALID";
  }
};
JWTInvalid.code = "ERR_JWT_INVALID";
var JWKInvalid = class extends JOSEError {
  constructor() {
    super(...arguments);
    this.code = "ERR_JWK_INVALID";
  }
};
JWKInvalid.code = "ERR_JWK_INVALID";
var JWKSInvalid = class extends JOSEError {
  constructor() {
    super(...arguments);
    this.code = "ERR_JWKS_INVALID";
  }
};
JWKSInvalid.code = "ERR_JWKS_INVALID";
var JWKSNoMatchingKey = class extends JOSEError {
  constructor(message = "no applicable key found in the JSON Web Key Set", options) {
    super(message, options);
    this.code = "ERR_JWKS_NO_MATCHING_KEY";
  }
};
JWKSNoMatchingKey.code = "ERR_JWKS_NO_MATCHING_KEY";
var JWKSMultipleMatchingKeys = class extends JOSEError {
  constructor(message = "multiple matching keys found in the JSON Web Key Set", options) {
    super(message, options);
    this.code = "ERR_JWKS_MULTIPLE_MATCHING_KEYS";
  }
};
JWKSMultipleMatchingKeys.code = "ERR_JWKS_MULTIPLE_MATCHING_KEYS";
var JWKSTimeout = class extends JOSEError {
  constructor(message = "request timed out", options) {
    super(message, options);
    this.code = "ERR_JWKS_TIMEOUT";
  }
};
JWKSTimeout.code = "ERR_JWKS_TIMEOUT";
var JWSSignatureVerificationFailed = class extends JOSEError {
  constructor(message = "signature verification failed", options) {
    super(message, options);
    this.code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  }
};
JWSSignatureVerificationFailed.code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";

// node_modules/jose/dist/browser/lib/is_object.js
function isObjectLike(value) {
  return typeof value === "object" && value !== null;
}
function isObject(input) {
  if (!isObjectLike(input) || Object.prototype.toString.call(input) !== "[object Object]") {
    return false;
  }
  if (Object.getPrototypeOf(input) === null) {
    return true;
  }
  let proto = input;
  while (Object.getPrototypeOf(proto) !== null) {
    proto = Object.getPrototypeOf(proto);
  }
  return Object.getPrototypeOf(input) === proto;
}

// node_modules/jose/dist/browser/util/base64url.js
var decode2 = decode;

// node_modules/jose/dist/browser/util/decode_jwt.js
function decodeJwt(jwt) {
  if (typeof jwt !== "string")
    throw new JWTInvalid("JWTs must use Compact JWS serialization, JWT must be a string");
  const { 1: payload, length } = jwt.split(".");
  if (length === 5)
    throw new JWTInvalid("Only JWTs using Compact JWS serialization can be decoded");
  if (length !== 3)
    throw new JWTInvalid("Invalid JWT");
  if (!payload)
    throw new JWTInvalid("JWTs must contain a payload");
  let decoded;
  try {
    decoded = decode2(payload);
  } catch {
    throw new JWTInvalid("Failed to base64url decode the payload");
  }
  let result;
  try {
    result = JSON.parse(decoder.decode(decoded));
  } catch {
    throw new JWTInvalid("Failed to parse the decoded payload as JSON");
  }
  if (!isObject(result))
    throw new JWTInvalid("Invalid JWT Claims Set");
  return result;
}

// ClientAuthSession.js
var IDLE_TTL_SECONDS = 3 * 24 * 60 * 60;
var HARD_TTL_SECONDS = 7 * 24 * 60 * 60;
function isExpired(payload) {
  const now = Math.floor(Date.now() / 1e3);
  const { iat, iat_session } = payload;
  if (typeof iat !== "number" || typeof iat_session !== "number") return true;
  if (now - iat > IDLE_TTL_SECONDS) return true;
  if (now - iat_session > HARD_TTL_SECONDS) return true;
  return false;
}
var ClientAuthSession = class {
  static store(token) {
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_time", String(Date.now()));
  }
  static getToken() {
    const token = localStorage.getItem("auth_token");
    if (!token) return null;
    try {
      const payload = decodeJwt(token);
      if (isExpired(payload)) return null;
      return token;
    } catch {
      return null;
    }
  }
  static getPayload() {
    const token = this.getToken();
    if (!token) return null;
    try {
      return decodeJwt(token);
    } catch {
      return null;
    }
  }
  static isSignedIn() {
    return this.getToken() !== null;
  }
  static getUserUuid() {
    return this.getPayload()?.sub ?? null;
  }
  static clear() {
    localStorage.removeItem("auth_token");
    localStorage.removeItem("auth_provider");
    localStorage.removeItem("auth_time");
  }
};

// IdentityStore.js
var IdentityStore = class {
  static _key = "ids";
  static getAll() {
    try {
      return JSON.parse(localStorage.getItem(this._key) ?? "[]");
    } catch {
      return [];
    }
  }
  static upsert(identity) {
    const all = this.getAll();
    const idx = all.findIndex((i) => i.uuid === identity.uuid);
    if (idx >= 0) all[idx] = identity;
    else all.push(identity);
    localStorage.setItem(this._key, JSON.stringify(all));
  }
  static remove(uuid) {
    const filtered = this.getAll().filter((i) => i.uuid !== uuid);
    localStorage.setItem(this._key, JSON.stringify(filtered));
  }
  static clear() {
    localStorage.removeItem(this._key);
  }
};

// PreferencesStore.js
var PreferencesStore = class {
  static _key(userUuid) {
    return `prefs:${userUuid}`;
  }
  static get(userUuid) {
    try {
      return JSON.parse(localStorage.getItem(this._key(userUuid)) ?? "{}");
    } catch {
      return {};
    }
  }
  static set(userUuid, prefs) {
    const existing = this.get(userUuid);
    localStorage.setItem(this._key(userUuid), JSON.stringify({ ...existing, ...prefs }));
  }
  static clear(userUuid) {
    localStorage.removeItem(this._key(userUuid));
  }
};

// AuthProvider.js
var KNOWN_PROVIDERS = /* @__PURE__ */ new Set(["google", "apple", "microsoft"]);
var AuthProvider = class {
  constructor(config = {}) {
    this._config = config;
    this._apiUrl = config.apiUrl ?? "http://127.0.0.1:8081/";
    if (!this._apiUrl.endsWith("/")) this._apiUrl += "/";
  }
  getAvailableProviders() {
    return Object.keys(this._config).filter((k) => KNOWN_PROVIDERS.has(k));
  }
  isConfigured() {
    return this.getAvailableProviders().length > 0;
  }
  async signIn(provider) {
    if (!this._config[provider]) {
      throw new Error(`AuthProvider: provider '${provider}' is not configured`);
    }
    const res = await fetch(`${this._apiUrl}auth/${provider}`);
    if (!res.ok) {
      throw new Error(`AuthProvider: server returned ${res.status} for /auth/${provider}`);
    }
    const { authorizationURL, state, codeVerifier } = await res.json();
    if (!authorizationURL) {
      throw new Error(`AuthProvider: no authorizationURL from server for provider '${provider}'`);
    }
    sessionStorage.setItem("oauth_state", state);
    sessionStorage.setItem("oauth_code_verifier", codeVerifier);
    (globalThis.window ?? global).location.href = authorizationURL;
    return new Promise(() => {
    });
  }
  signOut() {
    localStorage.removeItem("auth_token");
    localStorage.removeItem("auth_provider");
    localStorage.removeItem("auth_time");
  }
};
export {
  AuthProvider,
  ClientAuthSession,
  DeviceSession,
  IdentityStore,
  PreferencesStore
};
