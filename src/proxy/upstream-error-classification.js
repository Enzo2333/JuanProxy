const REQUEST_ERROR_CODES = new Set([
  'invalid_request',
  'invalid_request_error',
  'invalid_responses_request',
  'model_not_found',
  'context_length_exceeded',
  'unsupported_model'
]);

const SITE_HEALTH_ERROR_CODES = new Set([
  'invalid_api_key',
  'invalid_api_key_error',
  'unauthorized',
  'forbidden'
]);

const REQUEST_ERROR_TYPES = new Set([
  'invalid_request_error'
]);

const SITE_HEALTH_ERROR_TYPES = new Set([
  'authentication_error',
  'permission_error'
]);

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const SITE_HEALTH_STATUS_CODES = new Set([401, 403, ...RETRYABLE_STATUS_CODES]);

export function classifyUpstreamHttpError({ statusCode, bodyText = '' }) {
  const status = Number(statusCode);
  const parsed = parseErrorPayload(bodyText);
  const codes = collectPayloadValues(parsed, 'code');
  const types = collectPayloadValues(parsed, 'type');
  const messages = collectPayloadValues(parsed, 'message');

  if (!Number.isFinite(status) || status <= 0) {
    return siteHealth('upstream did not return an HTTP status');
  }

  if (
    codes.some((code) => SITE_HEALTH_ERROR_CODES.has(normalizeErrorToken(code))) ||
    types.some((type) => SITE_HEALTH_ERROR_TYPES.has(normalizeErrorToken(type))) ||
    messages.some(isSiteHealthMessage)
  ) {
    return siteHealth(`HTTP ${status} reported a site credential or permission failure`);
  }

  if (codes.some((code) => REQUEST_ERROR_CODES.has(normalizeErrorToken(code)))) {
    return requestScoped('upstream reported a request-scoped error code');
  }

  if (types.some((type) => REQUEST_ERROR_TYPES.has(normalizeErrorToken(type)))) {
    return requestScoped('upstream reported a request-scoped error type');
  }

  if (messages.some(isRequestScopedMessage)) {
    return requestScoped('upstream reported a request-scoped error message');
  }

  if ([400, 404, 422].includes(status)) {
    return requestScoped(`HTTP ${status} is not a site health failure`);
  }

  return {
    retryable: SITE_HEALTH_STATUS_CODES.has(status),
    affectsSiteHealth: SITE_HEALTH_STATUS_CODES.has(status),
    reason: SITE_HEALTH_STATUS_CODES.has(status)
      ? `HTTP ${status} is retryable`
      : `HTTP ${status} is not retryable`
  };
}

export function isRequestScopedAvailabilityFailure(result = {}) {
  if (result.ok) {
    return false;
  }

  return !classifyUpstreamHttpError({
    statusCode: result.statusCode,
    bodyText: result.detail ?? ''
  }).affectsSiteHealth;
}

function requestScoped(reason) {
  return {
    retryable: false,
    affectsSiteHealth: false,
    reason
  };
}

function siteHealth(reason) {
  return {
    retryable: true,
    affectsSiteHealth: true,
    reason
  };
}

function parseErrorPayload(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectPayloadValues(value, key, values = []) {
  if (!value || typeof value !== 'object') {
    return values;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPayloadValues(item, key, values);
    }
    return values;
  }

  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key && entryValue !== null && entryValue !== undefined) {
      values.push(String(entryValue));
      continue;
    }
    collectPayloadValues(entryValue, key, values);
  }
  return values;
}

function normalizeErrorToken(value) {
  return String(value).trim().toLowerCase();
}

function isRequestScopedMessage(value) {
  const message = normalizeErrorToken(value);
  return (
    message.includes('model_not_found') ||
    message.includes('no available channel for model') ||
    message.includes('invalid codex request') ||
    message.includes('invalid url (post /v1/responses)')
  );
}

function isSiteHealthMessage(value) {
  const message = normalizeErrorToken(value);
  return message.includes('invalid api key');
}
