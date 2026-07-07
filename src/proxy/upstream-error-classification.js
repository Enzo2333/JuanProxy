export function classifyUpstreamHttpError({ statusCode, bodyText } = {}) {
  const status = Number(statusCode);

  if (!Number.isFinite(status) || status <= 0) {
    return siteHealth('upstream did not return an HTTP status');
  }

  if (status >= 400 && status < 600) {
    const details = extractErrorDetails(bodyText);
    const siteHealthOverride = classifyAccountOrKeyFailure(status, details);
    if (siteHealthOverride) {
      return siteHealth(siteHealthOverride);
    }

    const requestScoped = classifyRequestScopedFailure(status, details);
    if (requestScoped) {
      return requestScoped;
    }

    return siteHealth(`HTTP ${status} is a site health failure`);
  }

  return {
    retryable: false,
    affectsSiteHealth: false,
    reason: `HTTP ${status} is not an error response`
  };
}

export function isRequestScopedAvailabilityFailure(result = {}) {
  if (result.ok) {
    return false;
  }

  return !classifyUpstreamHttpError({
    statusCode: result.statusCode,
    bodyText: result.detail
  }).affectsSiteHealth;
}

function siteHealth(reason) {
  return {
    retryable: true,
    affectsSiteHealth: true,
    reason
  };
}

function requestScoped({ retryable, requestLocalRetry = false, reason }) {
  return {
    retryable,
    ...(requestLocalRetry ? { requestLocalRetry: true } : {}),
    affectsSiteHealth: false,
    reason
  };
}

function classifyAccountOrKeyFailure(status, details) {
  if (status === 401 || status === 402) {
    return `HTTP ${status} is an account or key failure`;
  }

  if (matches(details, [
    /\btoken[_ -]?invalidated\b/i,
    /\binvalid(?:\s+|-|_)?api(?:\s+|-|_)?key\b/i,
    /\bapi(?:\s+|-|_)?key(?:\s+|-|_)?(?:is\s+)?invalid\b/i,
    /\b(?:auth|authentication|credential)s?\s+(?:failed|required|invalid|expired)\b/i,
    /\bunauthorized\b/i,
    /\buser\s+has\s+been\s+banned\b/i,
    /\bbanned\b/i,
    /\bin\s+debt\b/i,
    /\bgroup[_ -]?deleted\b/i,
    /\bapi\s+key\s+所属分组已删除\b/i,
    /所属分组已删除/i,
    /分组已删除/i,
    /\binsufficient[_ -]?balance\b/i,
    /\binsufficient\s+account\s+balance\b/i,
    /\bbalance\s+insufficient\b/i,
    /余额不足/i,
    /欠费/i,
    /被封/i,
    /封禁/i
  ])) {
    return 'upstream reports an account, key, balance, or group failure';
  }

  return null;
}

function classifyRequestScopedFailure(_status, details) {
  if (matches(details, [
    /\bmodel[_ -]?not[_ -]?found\b/i,
    /\bmodel\s+not\s+found\b/i,
    /\bno\s+available\s+channel\s+for\s+model\b/i,
    /\bmodel\s+.+\s+(?:is\s+)?not\s+(?:available|supported|enabled)\b/i
  ])) {
    return requestScoped({
      retryable: true,
      reason: 'requested model is unavailable on this site'
    });
  }

  if (matches(details, [
    /\binvalid\s+url\s+\(\s*post\s+\/v\d+\/responses\s*\)/i,
    /\bunknown\s+(?:url|path|endpoint)\b/i,
    /\bunsupported\s+(?:url|path|endpoint|api)\b/i,
    /\bendpoint\s+(?:not\s+found|unsupported)\b/i
  ])) {
    return requestScoped({
      retryable: true,
      reason: 'requested endpoint is unavailable on this site'
    });
  }

  if (matches(details, [
    /\bnot\s+enabled\s+for\s+this\s+group\b/i,
    /\bnot\s+allowed\s+for\s+this\s+group\b/i,
    /\bfeature\s+(?:is\s+)?(?:not\s+)?(?:enabled|allowed|supported)\b/i,
    /\bpermission_error\b/i
  ])) {
    return requestScoped({
      retryable: true,
      reason: 'requested feature is unavailable on this site'
    });
  }

  if (matches(details, [
    /\bsensitive[_ -]?words?[_ -]?detected\b/i
  ])) {
    return requestScoped({
      retryable: true,
      requestLocalRetry: true,
      reason: 'request content was rejected by upstream sensitive-word policy'
    });
  }

  if (matches(details, [
    /\bcontent[_ -]?policy\b/i,
    /\bcontent\s+(?:filter|filtered|blocked)\b/i,
    /\bmoderation\b/i,
    /\bsafety\b/i
  ])) {
    return requestScoped({
      retryable: false,
      reason: 'request content was rejected by upstream policy'
    });
  }

  if (matches(details, [
    /\binvalid[_ -]?responses?[_ -]?request\b/i,
    /\binvalid[_ -]?request(?:_error)?\b/i,
    /\binvalid\s+codex\s+request\b/i,
    /\binstructions?\s+(?:are\s+)?required\b/i,
    /\bmissing\s+required\s+(?:parameter|field)\b/i,
    /\bcontext[_ -]?length[_ -]?exceeded\b/i
  ])) {
    return requestScoped({
      retryable: false,
      reason: 'upstream rejected the request payload'
    });
  }

  return null;
}

function extractErrorDetails(bodyText) {
  const values = [];
  const text = String(bodyText ?? '').trim();
  if (text) {
    values.push(text);
  }

  const parsed = parseJson(text);
  if (parsed !== null) {
    collectPrimitiveValues(parsed, values);
  }

  return values.join('\n');
}

function parseJson(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectPrimitiveValues(value, values, depth = 0) {
  if (depth > 6 || value === null || value === undefined) {
    return;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    values.push(String(value));
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPrimitiveValues(entry, values, depth + 1);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      values.push(key);
      collectPrimitiveValues(entry, values, depth + 1);
    }
  }
}

function matches(details, patterns) {
  return patterns.some((pattern) => pattern.test(details));
}
