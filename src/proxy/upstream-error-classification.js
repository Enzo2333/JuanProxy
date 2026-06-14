export function classifyUpstreamHttpError({ statusCode }) {
  const status = Number(statusCode);

  if (!Number.isFinite(status) || status <= 0) {
    return siteHealth('upstream did not return an HTTP status');
  }

  if (status >= 400 && status < 600) {
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
    statusCode: result.statusCode
  }).affectsSiteHealth;
}

function siteHealth(reason) {
  return {
    retryable: true,
    affectsSiteHealth: true,
    reason
  };
}
