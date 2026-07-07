import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyUpstreamHttpError,
  isRequestScopedAvailabilityFailure
} from '../src/proxy/upstream-error-classification.js';

test('treats generic upstream 4xx and 5xx responses as site health failures', () => {
  for (let statusCode = 400; statusCode < 600; statusCode += 1) {
    const classification = classifyUpstreamHttpError({
      statusCode,
      bodyText: JSON.stringify({
        error: {
          message: 'upstream HTTP failure'
        }
      })
    });

    assert.equal(classification.retryable, true);
    assert.equal(classification.affectsSiteHealth, true);
  }
});

test('classifies request payload and capability errors without site health penalty', () => {
  const cases = [
    {
      statusCode: 500,
      bodyText: JSON.stringify({
        error: {
          code: 'sensitive_words_detected',
          message: 'sensitive_words_detected'
        }
      }),
      retryable: true,
      requestLocalRetry: true
    },
    {
      statusCode: 503,
      bodyText: JSON.stringify({
        error: {
          code: 'model_not_found',
          message: 'No available channel for model gpt-5.5 under group default'
        }
      }),
      retryable: true
    },
    {
      statusCode: 404,
      bodyText: JSON.stringify({
        error: {
          type: 'invalid_request_error',
          message: 'Invalid URL (POST /v1/responses)'
        }
      }),
      retryable: true
    },
    {
      statusCode: 403,
      bodyText: JSON.stringify({
        error: {
          type: 'permission_error',
          message: 'Image generation is not enabled for this group'
        }
      }),
      retryable: true
    }
  ];

  for (const entry of cases) {
    const classification = classifyUpstreamHttpError(entry);

    assert.equal(classification.affectsSiteHealth, false);
    assert.equal(classification.retryable, entry.retryable);
    assert.equal(Boolean(classification.requestLocalRetry), Boolean(entry.requestLocalRetry));
  }
});

test('keeps account and key failures as site health failures', () => {
  const cases = [
    {
      statusCode: 403,
      bodyText: JSON.stringify({
        code: 'GROUP_DELETED',
        message: 'API Key group was deleted'
      })
    },
    {
      statusCode: 403,
      bodyText: JSON.stringify({
        code: 'INSUFFICIENT_BALANCE',
        message: 'Insufficient account balance'
      })
    },
    {
      statusCode: 403,
      bodyText: JSON.stringify({
        error: {
          message: 'User has been banned',
          type: 'new_api_error'
        }
      })
    },
    {
      statusCode: 401,
      bodyText: JSON.stringify({
        error: {
          code: 'token_invalidated',
          message: 'Your authentication token has been invalidated'
        }
      })
    }
  ];

  for (const entry of cases) {
    const classification = classifyUpstreamHttpError(entry);

    assert.equal(classification.retryable, true);
    assert.equal(classification.affectsSiteHealth, true);
  }
});

test('availability tests treat request-scoped HTTP failures as non-health failures', () => {
  for (const { statusCode, detail } of [
    {
      statusCode: 400,
      detail: JSON.stringify({
        error: {
          code: 'invalid_responses_request',
          message: 'invalid codex request'
        }
      })
    },
    {
      statusCode: 503,
      detail: JSON.stringify({
        error: {
          code: 'model_not_found',
          message: 'No available channel for model gpt-5.5 under group default'
        }
      })
    }
  ]) {
    const requestScoped = isRequestScopedAvailabilityFailure({
      ok: false,
      statusCode,
      detail
    });

    assert.equal(requestScoped, true);
  }
});
