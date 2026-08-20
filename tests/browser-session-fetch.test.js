import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBrowserSessionFetch,
  normalizeSameOriginUrl
} from '../src/proxy/browser-session-fetch.js';

test('browser session fetch merges verification cookies with account cookies', async () => {
  let request = null;
  const browserSession = {
    cookies: {
      get: async ({ url }) => {
        assert.equal(url, 'https://relay.example.com/api/user/self');
        return [
          { name: 'cf_clearance', value: 'waf-cookie' },
          { name: 'session', value: 'stale-browser-session' }
        ];
      }
    },
    fetch: async (url, options) => {
      request = { url, options };
      return { ok: true };
    }
  };

  const fetch = createBrowserSessionFetch(browserSession);
  await fetch('https://relay.example.com/api/user/self', {
    method: 'GET',
    headers: {
      Cookie: 'session=account-session; account_id=42',
      Authorization: 'Bearer account-token'
    }
  });

  assert.equal(request.url, 'https://relay.example.com/api/user/self');
  assert.equal(request.options.credentials, 'include');
  assert.equal(request.options.headers.get('Authorization'), 'Bearer account-token');
  assert.equal(
    request.options.headers.get('Cookie'),
    'cf_clearance=waf-cookie; session=account-session; account_id=42'
  );
});

test('browser session fetch still works when cookie inspection is unavailable', async () => {
  let requestOptions = null;
  const fetch = createBrowserSessionFetch({
    fetch: async (_url, options) => {
      requestOptions = options;
      return { ok: true };
    }
  });

  await fetch('https://relay.example.com/api/status', {
    headers: { Accept: 'application/json' }
  });

  assert.equal(requestOptions.credentials, 'include');
  assert.equal(requestOptions.headers.get('Accept'), 'application/json');
  assert.equal(requestOptions.headers.has('Cookie'), false);
});

test('challenge URL normalization accepts only URLs from the expected origin', () => {
  assert.equal(
    normalizeSameOriginUrl('https://relay.example.com/api/user/self?challenge=1', 'https://relay.example.com'),
    'https://relay.example.com/api/user/self?challenge=1'
  );
  assert.equal(
    normalizeSameOriginUrl('https://attacker.example/api/user/self', 'https://relay.example.com'),
    ''
  );
  assert.equal(normalizeSameOriginUrl('not-a-url', 'https://relay.example.com'), '');
});
