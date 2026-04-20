const SESSION_MODE_ALIASES = Object.freeze({
  session: 'cookie',
  stateless: 'bearer',
});

const CANONICAL_SESSION_MODES = new Set(['cookie', 'bearer']);

function hasNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

export function createSessionModeError(reason, message, details = {}, status = 400) {
  const err = new Error(message);
  err.name = 'OAuthSessionModeError';
  err.code = 'invalid_state';
  err.reason = reason;
  err.status = status;
  err.details = details;
  err.diagnostics = {
    reason,
    ...details,
  };
  return err;
}

export function normalizeSessionModeLiteral(mode, { allowMissing = false, field = 'mode' } = {}) {
  if (mode === undefined || mode === null) {
    if (allowMissing) return null;
    throw createSessionModeError(
      'non_empty_string_required',
      `Session mode requires non-empty ${field}.`,
      { field },
    );
  }

  if (!hasNonEmptyString(mode)) {
    throw createSessionModeError(
      'non_empty_string_required',
      `Session mode requires non-empty ${field}.`,
      { field },
    );
  }

  const literal = mode.trim().toLowerCase();
  const canonical = SESSION_MODE_ALIASES[literal] ?? literal;

  if (!CANONICAL_SESSION_MODES.has(canonical)) {
    throw createSessionModeError(
      'unsupported_session_mode',
      `Unsupported session mode literal: ${mode}`,
      { field, mode },
    );
  }

  return canonical;
}

export function resolveSessionMode({
  explicitMode,
  queryMode,
  bodyMode,
  defaultMode,
  bearerToken,
  cookieToken,
} = {}) {
  const hasBearerToken = hasNonEmptyString(bearerToken);
  const hasCookieToken = hasNonEmptyString(cookieToken);

  const modeCandidate = firstDefined(explicitMode, queryMode, bodyMode);
  const modeSource = explicitMode !== undefined
    ? 'explicit'
    : (queryMode !== undefined ? 'query' : (bodyMode !== undefined ? 'body' : null));

  if (modeCandidate !== undefined) {
    const mode = normalizeSessionModeLiteral(modeCandidate, { field: 'mode' });

    if (mode === 'bearer' && !hasBearerToken) {
      if (hasCookieToken) {
        throw createSessionModeError(
          'session_mode_mismatch',
          'Requested bearer session mode does not match available credentials.',
          { expected: 'bearer', available: 'cookie' },
        );
      }

      throw createSessionModeError(
        'session_not_found',
        'Requested bearer session mode but no bearer token was provided.',
        { expected: 'bearer' },
      );
    }

    if (mode === 'cookie' && !hasCookieToken) {
      if (hasBearerToken) {
        throw createSessionModeError(
          'session_mode_mismatch',
          'Requested cookie session mode does not match available credentials.',
          { expected: 'cookie', available: 'bearer' },
        );
      }

      throw createSessionModeError(
        'session_not_found',
        'Requested cookie session mode but no cookie session token was provided.',
        { expected: 'cookie' },
      );
    }

    return {
      mode,
      source: modeSource ?? 'inferred',
      explicit: modeSource === 'explicit',
    };
  }

  if (hasBearerToken && hasCookieToken) {
    throw createSessionModeError(
      'session_mode_mismatch',
      'Both bearer and cookie credentials were provided without explicit mode.',
      { available: ['bearer', 'cookie'] },
    );
  }

  if (hasBearerToken) {
    return {
      mode: 'bearer',
      source: 'bearer-token',
      explicit: false,
    };
  }

  if (hasCookieToken) {
    return {
      mode: 'cookie',
      source: 'cookie-token',
      explicit: false,
    };
  }

  if (defaultMode !== undefined) {
    return {
      mode: normalizeSessionModeLiteral(defaultMode, { field: 'defaultMode' }),
      source: 'default',
      explicit: false,
    };
  }

  throw createSessionModeError(
    'session_required',
    'No session credentials were provided.',
  );
}

export function sessionModeAliases() {
  return { ...SESSION_MODE_ALIASES };
}
