import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyUpstreamHttpError,
  isRequestScopedAvailabilityFailure
} from '../src/proxy/upstream-error-classification.js';

test('treats every upstream 4xx and 5xx response as a site health failure', () => {
  for (let statusCode = 400; statusCode < 600; statusCode += 1) {
    const classification = classifyUpstreamHttpError({
      statusCode,
      bodyText: JSON.stringify({
        error: {
          code: statusCode % 2 === 0 ? 'invalid_request_error' : 'model_not_found',
          message: 'upstream HTTP failure'
        }
      })
    });

    assert.equal(classification.retryable, true);
    assert.equal(classification.affectsSiteHealth, true);
  }
});

test('availability tests treat every HTTP 4xx and 5xx failure as a site health failure', () => {
  for (let statusCode = 400; statusCode < 600; statusCode += 1) {
    const requestScoped = isRequestScopedAvailabilityFailure({
      ok: false,
      statusCode,
      detail: JSON.stringify({
        error: {
          code: 'invalid_responses_request',
          message: 'invalid codex request'
        }
      })
    });

    assert.equal(requestScoped, false);
  }
});
