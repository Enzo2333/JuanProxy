import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loginAndCreateSiteKey,
  loginAndFetchSiteSync,
  loginAndSwitchSiteGroup,
  parseMultiplierFromText
} from '../src/proxy/site-sync-service.js';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: {
      get() {
        return null;
      },
      getSetCookie() {
        return [];
      }
    },
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    }
  };
}

function createFetch(routes) {
  const calls = [];
  const fetchMock = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({
      url,
      pathname: parsed.pathname,
      search: parsed.search,
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      body: options.body ? JSON.parse(options.body) : null
    });
    const method = options.method ?? 'GET';
    const exactKey = `${method} ${parsed.origin}${parsed.pathname}`;
    const key = `${method} ${parsed.pathname}`;
    const route = routes[exactKey] ?? routes[key];
    if (!route) {
      throw new Error(`Unexpected request ${exactKey}`);
    }
    const result = typeof route === 'function' ? route({ url, options, parsed }) : route;
    if (result && typeof result === 'object' && Object.hasOwn(result, 'body')) {
      const response = jsonResponse(result.body, {
        ok: result.ok ?? true,
        status: result.status ?? 200
      });
      response.headers = {
        get(name) {
          return String(name).toLowerCase() === 'set-cookie' ? (result.setCookie ?? null) : null;
        },
        getSetCookie() {
          return result.setCookie ? [result.setCookie] : [];
        }
      };
      return response;
    }
    return jsonResponse(result);
  };
  fetchMock.calls = calls;
  return fetchMock;
}

test('parses multipliers from remote group text', () => {
  assert.equal(parseMultiplierFromText('Example Team 0.001x'), 0.001);
  assert.equal(parseMultiplierFromText('AAA.限时白嫖GPT 0.003x'), 0.003);
  assert.equal(parseMultiplierFromText('其他模型 1x'), 1);
  assert.equal(parseMultiplierFromText('no multiplier'), null);
});

test('modern api v1 sync logs in and maps profile, key, group and multiplier metadata', async () => {
  const fetchMock = createFetch({
    'POST /api/v1/auth/login': {
      data: {
        auth_token: 'auth-token',
        refresh_token: 'refresh-token'
      }
    },
    'GET /api/v1/user/profile': {
      data: {
        email: 'user@example.com',
        quota: 1.47,
        balance: '$1.47'
      }
    },
    'GET /api/v1/keys': {
      data: {
        items: [
          {
            id: 18,
            name: 'n',
            group: 'Example Team',
            endpoint: 'https://api-us.example.com/'
          }
        ]
      }
    },
    'GET /api/v1/groups/available': {
      data: [
        {
          name: 'Example Team'
        }
      ]
    },
    'GET /api/v1/groups/rates': {
      data: {
        'Example Team': 0.001
      }
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      enabled: true,
      dashboardUrl: 'https://sync.example.com/keys',
      username: 'user@example.com',
      password: 'secret',
      providerType: 'modern-v1'
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.multiplier, 0.001);
  assert.deepEqual(result.syncPatch, {
    lastSyncAt: '2026-06-09T08:00:00.000Z',
    lastSyncStatus: 'success',
    lastSyncError: null,
    remote: {
      providerType: 'modern-v1',
      authType: 'Bearer auth_token (/api/v1)',
      accountName: 'user@example.com',
      balance: '$1.47',
      apiEndpoint: 'https://api-us.example.com/',
      keyName: 'n',
      remoteKeyId: '18',
      keyGroup: 'Example Team',
      groupId: '',
      groupMultiplier: 0.001,
      groups: [
        {
          id: '',
          name: 'Example Team',
          multiplier: 0.001,
          selected: true
        }
      ]
    }
  });

  const loginCall = fetchMock.calls.find((call) => call.pathname === '/api/v1/auth/login');
  const profileCall = fetchMock.calls.find((call) => call.pathname === '/api/v1/user/profile');

  assert.equal(loginCall.method, 'POST');
  assert.deepEqual(loginCall.body, {
    email: 'user@example.com',
    password: 'secret'
  });
  assert.equal(profileCall.headers.Authorization, 'Bearer auth-token');
});

test('modern api v1 sync maps object-shaped group fields without object string leakage', async () => {
  const fetchMock = createFetch({
    'POST /api/v1/auth/login': {
      data: {
        auth_token: 'auth-token'
      }
    },
    'GET /api/v1/user/profile': {
      data: {
        email: 'user@example.com',
        balance: '$1.44'
      }
    },
    'GET /api/v1/keys': {
      data: {
        items: [
          {
            name: 'n',
            group: {
              name: 'Example Team'
            },
            endpoint: 'https://api-us.example.com/'
          }
        ]
      }
    },
    'GET /api/v1/groups/available': {
      data: [
        {
          name: 'Example Team'
        }
      ]
    },
    'GET /api/v1/groups/rates': {
      data: {
        'Example Team': 0.001
      }
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      enabled: true,
      dashboardUrl: 'https://sync.example.com/keys',
      username: 'user@example.com',
      password: 'secret',
      providerType: 'modern-v1'
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.syncPatch.remote.keyGroup, 'Example Team');
  assert.equal(result.syncPatch.remote.groupMultiplier, 0.001);
});

test('modern api v1 sync collects all available groups with multipliers', async () => {
  const fetchMock = createFetch({
    'POST /api/v1/auth/login': {
      data: {
        auth_token: 'auth-token'
      }
    },
    'GET /api/v1/user/profile': {
      data: {
        email: 'user@example.com',
        balance: '$1.44'
      }
    },
    'GET /api/v1/keys': {
      data: {
        items: [
          {
            name: 'n',
            group: 'Example Team',
            endpoint: 'https://api-us.example.com/'
          }
        ]
      }
    },
    'GET /api/v1/groups/available': {
      data: [
        {
          id: 18,
          name: 'Example Team'
        },
        {
          id: 22,
          name: 'GPT Plus',
          rate_multiplier: 0.045
        },
        {
          id: 30,
          name: '文本 1x'
        }
      ]
    },
    'GET /api/v1/groups/rates': {
      data: {
        'Example Team': 0.001,
        '文本 1x': 1
      }
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      enabled: true,
      dashboardUrl: 'https://sync.example.com/keys',
      username: 'user@example.com',
      password: 'secret',
      providerType: 'modern-v1'
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.syncPatch.remote.groups, [
    {
      id: '18',
      name: 'Example Team',
      multiplier: 0.001,
      selected: true
    },
    {
      id: '22',
      name: 'GPT Plus',
      multiplier: 0.045,
      selected: false
    },
    {
      id: '30',
      name: '文本 1x',
      multiplier: 1,
      selected: false
    }
  ]);
});

test('modern api v1 sync matches the current configured api key by masked key', async () => {
  const fetchMock = createFetch({
    'POST /api/v1/auth/login': {
      data: {
        auth_token: 'auth-token'
      }
    },
    'GET /api/v1/user/profile': {
      data: {
        email: 'user@example.com',
        balance: '$1.44'
      }
    },
    'GET /api/v1/keys': {
      data: {
        items: [
          {
            id: 18,
            name: 'wrong',
            key: 'sk-wro...0000',
            group: 'expensive',
            endpoint: 'https://api-us.example.com/'
          },
          {
            id: 22,
            name: 'current',
            key: 'sk-demo...f021',
            group: 'Example Team',
            endpoint: 'https://api-us.example.com/'
          }
        ]
      }
    },
    'GET /api/v1/groups/available': {
      data: [
        {
          name: 'expensive',
          rate_multiplier: 1
        },
        {
          name: 'Example Team',
          rate_multiplier: 0.001
        }
      ]
    },
    'GET /api/v1/groups/rates': {
      data: {
        expensive: 1,
        'Example Team': 0.001
      }
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      enabled: true,
      dashboardUrl: 'https://sync.example.com/keys',
      username: 'user@example.com',
      password: 'secret',
      providerType: 'modern-v1'
    },
    apiKey: 'sk-demo-f021',
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.syncPatch.remote.keyName, 'current');
  assert.equal(result.syncPatch.remote.remoteKeyId, '22');
  assert.equal(result.syncPatch.remote.keyGroup, 'Example Team');
  assert.equal(result.syncPatch.remote.groupMultiplier, 0.001);
  assert.equal(result.multiplier, 0.001);
});

test('modern api v1 sync fails when the current configured api key is missing from the account', async () => {
  const fetchMock = createFetch({
    'POST /api/v1/auth/login': {
      data: {
        auth_token: 'auth-token'
      }
    },
    'GET /api/v1/user/profile': {
      data: {
        email: 'user@example.com',
        balance: '$1.44'
      }
    },
    'GET /api/v1/keys': {
      data: {
        items: [
          {
            id: 18,
            name: 'wrong',
            key: 'sk-wro...0000',
            group: 'expensive'
          }
        ]
      }
    },
    'GET /api/v1/groups/available': {
      data: []
    },
    'GET /api/v1/groups/rates': {
      data: {}
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      enabled: true,
      dashboardUrl: 'https://sync.example.com/keys',
      username: 'user@example.com',
      password: 'secret',
      providerType: 'modern-v1'
    },
    apiKey: 'sk-demo-f021',
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, false);
  assert.equal(result.multiplier, null);
  assert.equal(
    result.syncPatch.lastSyncError,
    'Configured API key was not found in the remote account'
  );
});

test('modern api v1 sync fails when the remote account has no key matching the current configured api key', async () => {
  const fetchMock = createFetch({
    'POST /api/v1/auth/login': {
      data: {
        auth_token: 'auth-token'
      }
    },
    'GET /api/v1/user/profile': {
      data: {
        email: 'user@example.com',
        balance: '$0.00'
      }
    },
    'GET /api/v1/keys': {
      data: {
        items: []
      }
    },
    'GET /api/v1/groups/available': {
      data: []
    },
    'GET /api/v1/groups/rates': {
      data: {}
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      enabled: true,
      dashboardUrl: 'https://sync.example.com/keys',
      username: 'user@example.com',
      password: 'secret',
      providerType: 'modern-v1'
    },
    apiKey: 'sk-demo-f021',
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.syncPatch.lastSyncError,
    'Configured API key was not found in the remote account'
  );
});

test('modern api v1 group switch updates the remote key group without reading full keys', async () => {
  const fetchMock = createFetch({
    'POST /api/v1/auth/login': {
      data: {
        auth_token: 'auth-token'
      }
    },
    'GET /api/v1/keys': {
      data: {
        items: [
          {
            id: 18,
            name: 'n',
            group_id: 1,
            group: {
              id: 1,
              name: 'Example Team',
              rate_multiplier: 0.001
            },
            status: 'active',
            ip_whitelist: [],
            ip_blacklist: [],
            quota: 0,
            rate_limit_5h: 0,
            rate_limit_1d: 0,
            rate_limit_7d: 0
          }
        ]
      }
    },
    'PUT /api/v1/keys/18': ({ options }) => {
      assert.equal(options.headers.Authorization, 'Bearer auth-token');
      assert.deepEqual(JSON.parse(options.body), {
        group_id: 22
      });
      return {
        data: {
          id: 18,
          name: 'n',
          group_id: 22,
          group: {
            id: 22,
            name: 'GPT Plus',
            rate_multiplier: 0.045
          }
        }
      };
    },
    'GET /api/v1/user/profile': {
      data: {
        email: 'user@example.com',
        balance: '$1.44'
      }
    },
    'GET /api/v1/groups/available': {
      data: [
        {
          id: 1,
          name: 'Example Team',
          rate_multiplier: 0.001
        },
        {
          id: 22,
          name: 'GPT Plus',
          rate_multiplier: 0.045
        }
      ]
    },
    'GET /api/v1/groups/rates': {
      data: {
        'Example Team': 0.001,
        'GPT Plus': 0.045
      }
    }
  });

  const result = await loginAndSwitchSiteGroup({
    sync: {
      dashboardUrl: 'https://sync.example.com/keys',
      username: 'user@example.com',
      password: 'secret',
      providerType: 'modern-v1',
      remote: {
        remoteKeyId: '18'
      }
    },
    group: {
      id: '22',
      name: 'GPT Plus',
      multiplier: 0.045
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:10:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.syncPatch.remote.keyName, 'n');
  assert.equal(result.syncPatch.remote.remoteKeyId, '18');
  assert.equal(result.syncPatch.remote.keyGroup, 'GPT Plus');
  assert.equal(result.syncPatch.remote.groupId, '22');
  assert.equal(result.syncPatch.remote.groupMultiplier, 0.045);
  assert.equal(
    fetchMock.calls.some((call) => call.pathname === '/api/v1/keys/18' && call.method === 'GET'),
    false
  );
});

test('modern api v1 group switch targets the current configured api key instead of a stale cached key id', async () => {
  const fetchMock = createFetch({
    'POST /api/v1/auth/login': {
      data: {
        auth_token: 'auth-token'
      }
    },
    'GET /api/v1/keys': {
      data: {
        items: [
          {
            id: 18,
            name: 'stale',
            key: 'sk-old...1111',
            group_id: 1,
            group: 'old'
          },
          {
            id: 22,
            name: 'current',
            key: 'sk-demo...f021',
            group_id: 1,
            group: 'Example Team'
          }
        ]
      }
    },
    'PUT /api/v1/keys/22': ({ options }) => {
      assert.equal(options.headers.Authorization, 'Bearer auth-token');
      assert.deepEqual(JSON.parse(options.body), {
        group_id: 30
      });
      return {
        data: {
          id: 22,
          name: 'current',
          group_id: 30,
          group: 'GPT Plus'
        }
      };
    },
    'GET /api/v1/user/profile': {
      data: {
        email: 'user@example.com',
        balance: '$1.44'
      }
    },
    'GET /api/v1/groups/available': {
      data: [
        {
          id: 1,
          name: 'Example Team',
          rate_multiplier: 0.001
        },
        {
          id: 30,
          name: 'GPT Plus',
          rate_multiplier: 0.045
        }
      ]
    },
    'GET /api/v1/groups/rates': {
      data: {
        'Example Team': 0.001,
        'GPT Plus': 0.045
      }
    }
  });

  const result = await loginAndSwitchSiteGroup({
    sync: {
      dashboardUrl: 'https://sync.example.com/keys',
      username: 'user@example.com',
      password: 'secret',
      providerType: 'modern-v1',
      remote: {
        remoteKeyId: '18'
      }
    },
    apiKey: 'sk-demo-f021',
    group: {
      id: '30',
      name: 'GPT Plus',
      multiplier: 0.045
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:10:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.syncPatch.remote.keyName, 'current');
  assert.equal(result.syncPatch.remote.remoteKeyId, '22');
  assert.equal(result.syncPatch.remote.keyGroup, 'GPT Plus');
  assert.equal(result.syncPatch.remote.groupMultiplier, 0.045);
  assert.equal(
    fetchMock.calls.some((call) => call.pathname === '/api/v1/keys/18' && call.method === 'PUT'),
    false
  );
});

test('modern api v1 group switch requires the target remote group id', async () => {
  const fetchMock = createFetch({
    'POST /api/v1/auth/login': {
      data: {
        auth_token: 'auth-token'
      }
    }
  });

  const result = await loginAndSwitchSiteGroup({
    sync: {
      dashboardUrl: 'https://sync.example.com/keys',
      username: 'user@example.com',
      password: 'secret',
      providerType: 'modern-v1',
      remote: {
        remoteKeyId: '18',
        groupId: '1'
      }
    },
    group: {
      id: '',
      name: 'GPT Plus',
      multiplier: 0.045
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:10:00.000Z')
  });

  assert.equal(result.ok, false);
  assert.equal(result.syncPatch.lastSyncError, 'Remote group id is missing; refresh this site before switching groups');
  assert.equal(
    fetchMock.calls.some((call) => call.method === 'PUT'),
    false
  );
});

test('modern api v1 sync reads rate_multiplier from the key group', async () => {
  const fetchMock = createFetch({
    'POST /api/v1/auth/login': {
      data: {
        auth_token: 'auth-token'
      }
    },
    'GET /api/v1/user/profile': {
      data: {
        email: 'user@example.com',
        balance: '$1.44'
      }
    },
    'GET /api/v1/keys': {
      data: {
        items: [
          {
            name: 'n',
            group_id: 18,
            group: {
              id: 18,
              name: 'Example Team',
              rate_multiplier: 0.001,
              daily_limit_usd: 0,
              rpm_limit: 0
            },
            endpoint: 'https://api-us.example.com/'
          }
        ]
      }
    },
    'GET /api/v1/groups/available': {
      data: [
        {
          id: 18,
          name: 'Example Team',
          rate_multiplier: 0.001,
          daily_limit_usd: 0,
          rpm_limit: 0
        }
      ]
    },
    'GET /api/v1/groups/rates': {
      data: {}
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      enabled: true,
      dashboardUrl: 'https://sync.example.com/keys',
      username: 'user@example.com',
      password: 'secret',
      providerType: 'modern-v1'
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.multiplier, 0.001);
  assert.equal(result.syncPatch.remote.keyGroup, 'Example Team');
  assert.equal(result.syncPatch.remote.groupMultiplier, 0.001);
});

test('modern api v1 sync maps api_base_url from public settings when key has no endpoint', async () => {
  const fetchMock = createFetch({
    'GET /api/v1/settings/public': {
      data: {
        api_base_url: 'https://api-us.example.com/',
        custom_endpoints: [
          { name: 'hk', endpoint: 'https://api-hk.example.com/' }
        ]
      }
    },
    'POST /api/v1/auth/login': {
      data: {
        auth_token: 'auth-token'
      }
    },
    'GET /api/v1/user/profile': {
      data: {
        email: 'user@example.com',
        balance: '$1.44'
      }
    },
    'GET /api/v1/keys': {
      data: {
        items: [
          {
            name: 'n',
            group: {
              name: 'Example Team',
              rate_multiplier: 0.001
            }
          }
        ]
      }
    },
    'GET /api/v1/groups/available': {
      data: []
    },
    'GET /api/v1/groups/rates': {
      data: {}
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      dashboardUrl: 'https://sync.example.com/keys',
      username: 'user@example.com',
      password: 'secret',
      providerType: 'modern-v1'
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.syncPatch.remote.apiEndpoint, 'https://api-us.example.com/');
});

test('modern api v1 sync does not infer group multiplier when key list is empty', async () => {
  const fetchMock = createFetch({
    'GET /api/v1/settings/public': {
      data: {
        api_base_url: 'https://api.example.com/'
      }
    },
    'POST /api/v1/auth/login': {
      data: {
        auth_token: 'auth-token'
      }
    },
    'GET /api/v1/user/profile': {
      data: {
        email: 'user@example.com',
        balance: '$0.00'
      }
    },
    'GET /api/v1/keys': {
      data: {
        items: []
      }
    },
    'GET /api/v1/groups/available': {
      data: [
        {
          name: 'GPT Plus',
          rate_multiplier: 0.045
        }
      ]
    },
    'GET /api/v1/groups/rates': {
      data: {
        'GPT Plus': 0.045
      }
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      dashboardUrl: 'https://api.example.com/keys',
      username: 'user@example.com',
      password: 'secret',
      providerType: 'modern-v1'
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.multiplier, null);
  assert.equal(result.syncPatch.remote.apiEndpoint, 'https://api.example.com/');
  assert.equal(result.syncPatch.remote.keyName, '');
  assert.equal(result.syncPatch.remote.keyGroup, '');
  assert.equal(result.syncPatch.remote.groupMultiplier, null);
});

test('modern api v1 sync discovers absolute api base from dashboard assets', async () => {
  const fetchMock = createFetch({
    'GET https://dashboard.example.com/api/v1/settings/public': '<!doctype html><title>app</title>',
    'GET https://dashboard.example.com/keys': '<!doctype html><script type="module" src="/assets/index.js"></script>',
    'GET https://dashboard.example.com/assets/index.js': 'const apiBase = "https://cf-api.example.com/api/v1";',
    'GET https://cf-api.example.com/api/v1/settings/public': {
      data: {
        api_base_url: 'https://cf-api.example.com',
        custom_endpoints: [
          { name: 'CF', endpoint: 'https://cf-api.example.com' },
          { name: 'image', endpoint: 'https://cf-img.example.com' }
        ]
      }
    },
    'POST https://cf-api.example.com/api/v1/auth/login': {
      data: {
        auth_token: 'auth-token'
      }
    },
    'GET https://cf-api.example.com/api/v1/user/profile': {
      data: {
        email: 'user@example.com',
        balance: '$1.79'
      }
    },
    'GET https://cf-api.example.com/api/v1/keys': {
      data: {
        items: []
      }
    },
    'GET https://cf-api.example.com/api/v1/groups/available': {
      data: []
    },
    'GET https://cf-api.example.com/api/v1/groups/rates': {
      data: {}
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      dashboardUrl: 'https://dashboard.example.com/keys',
      username: 'user@example.com',
      password: 'secret',
      providerType: 'modern-v1'
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.syncPatch.remote.apiEndpoint, 'https://cf-api.example.com');
  assert.equal(fetchMock.calls.some((call) => call.url === 'https://cf-api.example.com/api/v1/auth/login'), true);
});

test('new api sync logs in and maps token, group and multiplier metadata', async () => {
  const fetchMock = createFetch({
    'POST /api/user/login': {
      data: {
        token: 'new-api-token'
      }
    },
    'GET /api/user/self': {
      data: {
        username: 'sync-user',
        quota: 0,
        used_quota: 0
      }
    },
    'GET /api/token/': {
      data: [
        {
          name: 'qa',
          id: 101,
          group: 'AAA.限时白嫖GPT 0.003x'
        }
      ]
    },
    'GET /api/user/self/groups': {
      data: [
        {
          name: 'AAA.限时白嫖GPT 0.003x'
        }
      ]
    },
    'GET /api/status': {
      data: {
        version: 'new-api'
      }
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      enabled: true,
      dashboardUrl: 'https://relay.example.com/console/token',
      username: 'sync-user',
      password: 'secret',
      providerType: 'new-api'
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.multiplier, 0.003);
  assert.equal(result.syncPatch.remote.providerType, 'new-api');
  assert.equal(result.syncPatch.remote.authType, 'Bearer token (/api)');
  assert.equal(result.syncPatch.remote.accountName, 'sync-user');
  assert.equal(result.syncPatch.remote.keyName, 'qa');
  assert.equal(result.syncPatch.remote.remoteKeyId, '101');
  assert.equal(result.syncPatch.remote.keyGroup, 'AAA.限时白嫖GPT 0.003x');
  assert.equal(result.syncPatch.remote.groupMultiplier, 0.003);
  assert.equal(fetchMock.calls[0].url, 'https://relay.example.com/api/user/login');
  assert.equal(fetchMock.calls[1].headers.Authorization, 'Bearer new-api-token');
  assert.equal(
    fetchMock.calls.some((call) => call.pathname.includes('/key') && call.method === 'GET'),
    false
  );
});

test('new api sync keeps local-only key groups out of the available group list', async () => {
  const fetchMock = createFetch({
    'POST /api/user/login': {
      data: {
        token: 'new-api-token'
      }
    },
    'GET /api/user/self': {
      data: {
        username: 'sync-user',
        quota: 0
      }
    },
    'GET /api/token/': {
      data: [
        {
          name: 'qa',
          group: 'Local low 0.00001x'
        }
      ]
    },
    'GET /api/user/self/groups': {
      data: {
        plus: {
          desc: 'GPT Plus 0.045x',
          ratio: 0.045
        }
      }
    },
    'GET /api/status': {
      data: {
        version: 'new-api'
      }
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      dashboardUrl: 'https://relay.example.com/console/token',
      username: 'sync-user',
      password: 'secret',
      providerType: 'new-api'
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.syncPatch.remote.keyGroup, 'Local low 0.00001x');
  assert.equal(result.syncPatch.remote.groupMultiplier, 0.00001);
  assert.deepEqual(result.syncPatch.remote.groups, [
    {
      id: 'plus',
      name: 'GPT Plus 0.045x',
      multiplier: 0.045,
      selected: false
    }
  ]);
});

test('new api sync matches the current configured api key by masked token key', async () => {
  const fetchMock = createFetch({
    'POST /api/user/login': {
      data: {
        token: 'new-api-token'
      }
    },
    'GET /api/user/self': {
      data: {
        username: 'sync-user',
        quota: 0
      }
    },
    'GET /api/token/': {
      data: [
        {
          id: 101,
          name: 'wrong',
          key: 'sk-wro...0000',
          group: 'plus'
        },
        {
          id: 202,
          name: 'current',
          key: 'sk-demo...f021',
          group: 'default'
        }
      ]
    },
    'GET /api/user/self/groups': {
      data: {
        default: {
          desc: 'AAA.闄愭椂鐧藉珫GPT 0.003x',
          ratio: 0.003
        },
        plus: {
          desc: 'GPT Plus 0.045x',
          ratio: 0.045
        }
      }
    },
    'GET /api/status': {
      data: {
        server_address: 'https://relay.example.com'
      }
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      enabled: true,
      dashboardUrl: 'https://relay.example.com/console/token',
      username: 'sync-user',
      password: 'secret',
      providerType: 'new-api'
    },
    apiKey: 'sk-demo-f021',
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.syncPatch.remote.keyName, 'current');
  assert.equal(result.syncPatch.remote.remoteKeyId, '202');
  assert.equal(result.syncPatch.remote.keyGroup, 'AAA.闄愭椂鐧藉珫GPT 0.003x');
  assert.equal(result.syncPatch.remote.groupMultiplier, 0.003);
  assert.equal(result.multiplier, 0.003);
  assert.equal(
    fetchMock.calls.some((call) => call.url.includes('/api/token/202/key')),
    false
  );
  assert.equal(
    fetchMock.calls.some((call) => call.url.includes('/api/token/batch/keys')),
    false
  );
});

test('new api sync matches masked token keys that omit the sk prefix', async () => {
  const fetchMock = createFetch({
    'POST /api/user/login': {
      data: {
        token: 'new-api-token'
      }
    },
    'GET /api/user/self': {
      data: {
        username: 'sync-user',
        quota: 0
      }
    },
    'GET /api/token/': {
      data: [
        {
          id: 175,
          name: 'qa',
          key: 't6Ab**...daR2',
          group: 'default'
        }
      ]
    },
    'GET /api/user/self/groups': {
      data: {
        default: {
          desc: 'AAA.限时白嫖GPT',
          ratio: 0.00001
        }
      }
    },
    'GET /api/status': {
      data: {
        server_address: 'https://relay.example.com'
      }
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      enabled: true,
      dashboardUrl: 'https://relay.example.com/console/token',
      username: 'sync-user',
      password: 'secret',
      providerType: 'new-api'
    },
    apiKey: 'sk-t6Ab-demo-daR2',
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.syncPatch.remote.keyName, 'qa');
  assert.equal(result.syncPatch.remote.remoteKeyId, '175');
  assert.equal(result.syncPatch.remote.groupMultiplier, 0.00001);
});

test('new api sync fails when the current configured api key is missing from the account', async () => {
  const fetchMock = createFetch({
    'POST /api/user/login': {
      data: {
        token: 'new-api-token'
      }
    },
    'GET /api/user/self': {
      data: {
        username: 'sync-user',
        quota: 0
      }
    },
    'GET /api/token/': {
      data: [
        {
          id: 101,
          name: 'wrong',
          key: 'sk-wro...0000',
          group: 'plus'
        }
      ]
    },
    'GET /api/user/self/groups': {
      data: {
        plus: {
          desc: 'GPT Plus 0.045x',
          ratio: 0.045
        }
      }
    },
    'GET /api/status': {
      data: {
        server_address: 'https://relay.example.com'
      }
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      enabled: true,
      dashboardUrl: 'https://relay.example.com/console/token',
      username: 'sync-user',
      password: 'secret',
      providerType: 'new-api'
    },
    apiKey: 'sk-demo-f021',
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, false);
  assert.equal(result.multiplier, null);
  assert.equal(
    result.syncPatch.lastSyncError,
    'Configured API key was not found in the remote account'
  );
});

test('new api sync fails when the remote account has no token matching the current configured api key', async () => {
  const fetchMock = createFetch({
    'POST /api/user/login': {
      data: {
        token: 'new-api-token'
      }
    },
    'GET /api/user/self': {
      data: {
        username: 'sync-user',
        quota: 0
      }
    },
    'GET /api/token/': {
      data: []
    },
    'GET /api/user/self/groups': {
      data: {}
    },
    'GET /api/status': {
      data: {
        server_address: 'https://relay.example.com'
      }
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      enabled: true,
      dashboardUrl: 'https://relay.example.com/console/token',
      username: 'sync-user',
      password: 'secret',
      providerType: 'new-api'
    },
    apiKey: 'sk-demo-f021',
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.syncPatch.lastSyncError,
    'Configured API key was not found in the remote account'
  );
});

test('new api group switch updates the remote token group without reading full token keys', async () => {
  const fetchMock = createFetch({
    'POST /api/user/login': {
      data: {
        token: 'new-api-token'
      }
    },
    'GET /api/token/101': {
      data: {
        id: 101,
        name: 'qa',
        status: 1,
        expired_time: -1,
        remain_quota: 0,
        unlimited_quota: true,
        model_limits_enabled: false,
        model_limits: '',
        allow_ips: '',
        group: 'default',
        cross_group_retry: false
      }
    },
    'PUT /api/token/': ({ options }) => {
      assert.equal(options.headers.Authorization, 'Bearer new-api-token');
      assert.equal(options.headers['New-Api-User'], undefined);
      assert.deepEqual(JSON.parse(options.body), {
        id: 101,
        name: 'qa',
        status: 1,
        expired_time: -1,
        remain_quota: 0,
        unlimited_quota: true,
        model_limits_enabled: false,
        model_limits: '',
        allow_ips: '',
        group: 'plus',
        cross_group_retry: false
      });
      return {
        data: {
          id: 101,
          name: 'qa',
          group: 'plus'
        }
      };
    },
    'GET /api/user/self': {
      data: {
        username: 'sync-user',
        quota: 0
      }
    },
    'GET /api/token/': {
      data: [
        {
          id: 101,
          name: 'qa',
          group: 'plus'
        }
      ]
    },
    'GET /api/user/self/groups': {
      data: {
        default: {
          desc: 'AAA.限时白嫖GPT 0.003x',
          ratio: 0.003
        },
        plus: {
          desc: 'GPT Plus 0.045x',
          ratio: 0.045
        }
      }
    },
    'GET /api/status': {
      data: {
        server_address: 'https://relay.example.com',
        quota_per_unit: 500000
      }
    }
  });

  const result = await loginAndSwitchSiteGroup({
    sync: {
      dashboardUrl: 'https://relay.example.com/console/token',
      username: 'sync-user',
      password: 'secret',
      providerType: 'new-api',
      remote: {
        remoteKeyId: '101'
      }
    },
    group: {
      id: 'plus',
      name: 'GPT Plus 0.045x',
      multiplier: 0.045
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:10:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.syncPatch.remote.keyName, 'qa');
  assert.equal(result.syncPatch.remote.remoteKeyId, '101');
  assert.equal(result.syncPatch.remote.keyGroup, 'GPT Plus 0.045x');
  assert.equal(result.syncPatch.remote.groupId, 'plus');
  assert.equal(result.syncPatch.remote.groupMultiplier, 0.045);
  assert.equal(
    fetchMock.calls.some((call) => call.url.includes('/api/token/101/key')),
    false
  );
  assert.equal(
    fetchMock.calls.some((call) => call.url.includes('/api/token/batch/keys')),
    false
  );
});

test('new api sync reads auth token from nested user payloads', async () => {
  const fetchMock = createFetch({
    'POST /api/user/login': {
      success: true,
      data: {
        user: {
          username: 'sync-user',
          token: 'nested-user-token'
        }
      }
    },
    'GET /api/user/self': {
      data: {
        username: 'sync-user',
        quota: 0
      }
    },
    'GET /api/token/': {
      data: [
        {
          name: 'qa',
          group: 'default'
        }
      ]
    },
    'GET /api/user/self/groups': {
      data: {
        default: {
          desc: 'AAA.限时白嫖GPT 0.00001x',
          ratio: 0.00001
        }
      }
    },
    'GET /api/status': {
      data: {
        server_address: 'https://relay.example.com',
        quota_per_unit: 500000
      }
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      dashboardUrl: 'https://relay.example.com/',
      username: 'sync-user',
      password: 'secret',
      providerType: 'new-api'
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.syncPatch.remote.groupMultiplier, 0.00001);
  assert.equal(fetchMock.calls[1].headers.Authorization, 'Bearer nested-user-token');
});

test('new api sync collects object-map groups with ratios', async () => {
  const fetchMock = createFetch({
    'POST /api/user/login': {
      data: {
        token: 'new-api-token'
      }
    },
    'GET /api/user/self': {
      data: {
        username: 'sync-user',
        quota: 0
      }
    },
    'GET /api/token/': {
      data: [
        {
          name: 'qa',
          group: 'default'
        }
      ]
    },
    'GET /api/user/self/groups': {
      data: {
        default: {
          desc: 'AAA.限时白嫖GPT 0.00001x',
          ratio: 0.00001
        },
        plus: {
          desc: 'GPT Plus 0.045x',
          ratio: 0.045
        }
      }
    },
    'GET /api/status': {
      data: {
        server_address: 'https://relay.example.com',
        quota_per_unit: 500000
      }
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      dashboardUrl: 'https://relay.example.com/',
      username: 'sync-user',
      password: 'secret',
      providerType: 'new-api'
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.syncPatch.remote.groups, [
    {
      id: 'default',
      name: 'AAA.限时白嫖GPT 0.00001x',
      multiplier: 0.00001,
      selected: true
    },
    {
      id: 'plus',
      name: 'GPT Plus 0.045x',
      multiplier: 0.045,
      selected: false
    }
  ]);
});

test('new api sync can authenticate subsequent requests with login cookies', async () => {
  const fetchMock = createFetch({
    'POST /api/user/login': {
      setCookie: 'session=relay-session; Path=/; HttpOnly',
      body: {
        success: true,
        data: {
          id: 174,
          username: 'sync-user',
          role: 1
        }
      }
    },
    'GET /api/user/self': ({ options }) => {
      assert.equal(options.headers.Cookie, 'session=relay-session');
      assert.equal(options.headers['New-Api-User'], '174');
      return {
        data: {
          username: 'sync-user',
          quota: 0
        }
      };
    },
    'GET /api/token/': ({ options }) => {
      assert.equal(options.headers.Cookie, 'session=relay-session');
      assert.equal(options.headers['New-Api-User'], '174');
      return {
        data: [
          {
            name: 'qa',
            group: 'default'
          }
        ]
      };
    },
    'GET /api/user/self/groups': ({ options }) => {
      assert.equal(options.headers.Cookie, 'session=relay-session');
      assert.equal(options.headers['New-Api-User'], '174');
      return {
        data: {
          default: {
            desc: 'AAA.限时白嫖GPT 0.00001x',
            ratio: 0.00001
          }
        }
      };
    },
    'GET /api/status': {
      data: {
        server_address: 'https://relay.example.com',
        quota_per_unit: 500000
      }
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      dashboardUrl: 'https://relay.example.com/',
      username: 'sync-user',
      password: 'secret',
      providerType: 'new-api'
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.syncPatch.remote.authType, 'Cookie session + New-Api-User (/api)');
  assert.equal(result.syncPatch.remote.keyName, 'qa');
  assert.equal(result.syncPatch.remote.groupMultiplier, 0.00001);
});

test('new api sync reports login failure messages from success false payloads', async () => {
  const fetchMock = createFetch({
    'POST /api/user/login': {
      success: false,
      message: 'Username or password is incorrect, or user has been banned'
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      dashboardUrl: 'https://relay.example.com/',
      username: 'sync-user',
      password: 'wrong',
      providerType: 'new-api'
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.syncPatch.lastSyncError,
    'Remote login failed: Username or password is incorrect, or user has been banned'
  );
  assert.equal(fetchMock.calls.length, 1);
});

test('new api sync reports two-factor authentication requirements', async () => {
  const fetchMock = createFetch({
    'POST /api/user/login': {
      success: true,
      data: {
        require_2fa: true
      }
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      dashboardUrl: 'https://relay.example.com/',
      username: 'sync-user',
      password: 'secret',
      providerType: 'new-api'
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, false);
  assert.equal(result.syncPatch.lastSyncError, 'Remote login requires two-factor authentication');
  assert.equal(fetchMock.calls.length, 1);
});

test('auto provider detection treats a new-api root dashboard URL as new-api', async () => {
  const fetchMock = createFetch({
    'GET /api/status': {
      data: {
        version: 'v1.0.0-rc.10',
        server_address: 'https://relay.example.com',
        api_info: [
          {
            route: 'global',
            url: 'https://relay.example.com'
          }
        ],
        quota_display_type: 'USD',
        quota_per_unit: 500000,
        password_login_enabled: true
      }
    },
    'POST /api/user/login': {
      data: {
        token: 'new-api-token'
      }
    },
    'GET /api/user/self': {
      data: {
        username: 'sync-user',
        quota: 0
      }
    },
    'GET /api/token/': {
      data: [
        {
          name: 'qa',
          group: 'default'
        }
      ]
    },
    'GET /api/user/self/groups': {
      data: {
        default: {
          desc: 'AAA.限时白嫖GPT 0.003x',
          ratio: 0.003
        }
      }
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      dashboardUrl: 'https://relay.example.com/',
      username: 'sync-user',
      password: 'secret',
      providerType: 'auto'
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.syncPatch.remote.providerType, 'new-api');
  assert.equal(result.syncPatch.remote.apiEndpoint, 'https://relay.example.com');
  assert.equal(result.syncPatch.remote.groupMultiplier, 0.003);
  assert.equal(
    fetchMock.calls.some((call) => call.url === 'https://relay.example.com/api/user/login'),
    true
  );
  assert.equal(
    fetchMock.calls.some((call) => call.url === 'https://relay.example.com/api/v1/auth/login'),
    false
  );
});

test('new api sync maps status endpoint, object group ratio and quota-unit balance', async () => {
  const fetchMock = createFetch({
    'POST /api/user/login': {
      data: {
        token: 'new-api-token'
      }
    },
    'GET /api/user/self': {
      data: {
        username: 'relay-two-user',
        quota: 598985000
      }
    },
    'GET /api/token/': {
      data: [
        {
          name: 'n',
          group: 'default'
        }
      ]
    },
    'GET /api/user/self/groups': {
      data: {
        default: {
          desc: '其他模型 1x',
          ratio: 1
        }
      }
    },
    'GET /api/status': {
      data: {
        server_address: 'https://relay-two.example.com',
        api_info: [],
        quota_display_type: 'USD',
        quota_per_unit: 500000
      }
    }
  });

  const result = await loginAndFetchSiteSync({
    sync: {
      dashboardUrl: 'https://relay-two.example.com/console/personal',
      username: 'relay-two-user',
      password: 'secret',
      providerType: 'new-api'
    },
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.multiplier, 1);
  assert.equal(result.syncPatch.remote.balance, '$1197.97');
  assert.equal(result.syncPatch.remote.apiEndpoint, 'https://relay-two.example.com');
  assert.equal(result.syncPatch.remote.keyName, 'n');
  assert.equal(result.syncPatch.remote.keyGroup, '其他模型 1x');
  assert.equal(result.syncPatch.remote.groupMultiplier, 1);
});

test('modern api v1 creates a key and returns metadata for local import', async () => {
  const fetchMock = createFetch({
    'POST /api/v1/auth/login': {
      data: {
        auth_token: 'auth-token'
      }
    },
    'POST /api/v1/keys': {
      data: {
        id: 37,
        name: 'JuanProxy sync',
        key: 'sk-created-modern',
        group: {
          id: 18,
          name: 'Example Team',
          rate_multiplier: 0.001
        },
        endpoint: 'https://api-us.example.com/'
      }
    },
    'GET /api/v1/user/profile': {
      data: {
        email: 'user@example.com',
        balance: '$1.47'
      }
    },
    'GET /api/v1/keys': {
      data: {
        items: [
          {
            id: 37,
            name: 'JuanProxy sync',
            key: 'sk-created-modern',
            group: 'Example Team',
            endpoint: 'https://api-us.example.com/'
          }
        ]
      }
    },
    'GET /api/v1/groups/available': {
      data: [
        {
          id: 18,
          name: 'Example Team',
          rate_multiplier: 0.001
        }
      ]
    },
    'GET /api/v1/groups/rates': {
      data: {
        'Example Team': 0.001
      }
    }
  });

  const result = await loginAndCreateSiteKey({
    sync: {
      dashboardUrl: 'https://sync.example.com/keys',
      username: 'user@example.com',
      password: 'secret',
      providerType: 'modern-v1',
      remote: {
        groupId: '18',
        keyGroup: 'Example Team'
      }
    },
    name: 'JuanProxy sync',
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.apiKey, 'sk-created-modern');
  assert.equal(result.multiplier, 0.001);
  assert.equal(result.syncPatch.remote.providerType, 'modern-v1');
  assert.equal(result.syncPatch.remote.keyName, 'JuanProxy sync');
  assert.equal(result.syncPatch.remote.remoteKeyId, '37');

  const createCall = fetchMock.calls.find((call) => call.pathname === '/api/v1/keys' && call.method === 'POST');
  assert.deepEqual(createCall.body, {
    name: 'JuanProxy sync',
    group_id: 18
  });
  assert.equal(createCall.headers.Authorization, 'Bearer auth-token');
});

test('new api creates a token and fetches the generated key for local import', async () => {
  const fetchMock = createFetch({
    'POST /api/user/login': {
      data: {
        token: 'new-api-token'
      }
    },
    'POST /api/token/': {
      success: true,
      data: {
        id: 42,
        name: 'JuanProxy sync',
        group: 'default',
        status: 1
      }
    },
    'POST /api/token/42/key': {
      success: true,
      data: {
        key: 'created-new-api'
      }
    },
    'GET /api/user/self': {
      data: {
        username: 'sync-user',
        quota: 0
      }
    },
    'GET /api/token/': {
      data: [
        {
          id: 42,
          name: 'JuanProxy sync',
          key: 'sk-cre...api',
          group: 'default'
        }
      ]
    },
    'GET /api/user/self/groups': {
      data: {
        default: {
          desc: 'Default 0.003x',
          ratio: 0.003
        }
      }
    },
    'GET /api/status': {
      data: {
        server_address: 'https://relay.example.com',
        quota_per_unit: 500000
      }
    }
  });

  const result = await loginAndCreateSiteKey({
    sync: {
      dashboardUrl: 'https://relay.example.com/console/token',
      username: 'sync-user',
      password: 'secret',
      providerType: 'new-api',
      remote: {
        groupId: 'default',
        keyGroup: 'Default 0.003x'
      }
    },
    name: 'JuanProxy sync',
    fetch: fetchMock,
    now: new Date('2026-06-09T08:00:00.000Z')
  });

  assert.equal(result.ok, true);
  assert.equal(result.apiKey, 'sk-created-new-api');
  assert.equal(result.multiplier, 0.003);
  assert.equal(result.syncPatch.remote.providerType, 'new-api');
  assert.equal(result.syncPatch.remote.keyName, 'JuanProxy sync');
  assert.equal(result.syncPatch.remote.remoteKeyId, '42');

  const createCall = fetchMock.calls.find((call) => call.pathname === '/api/token/' && call.method === 'POST');
  assert.deepEqual(createCall.body, {
    name: 'JuanProxy sync',
    remain_quota: 0,
    expired_time: -1,
    unlimited_quota: true,
    model_limits_enabled: false,
    model_limits: '',
    allow_ips: '',
    group: 'default',
    cross_group_retry: false
  });
  assert.equal(createCall.headers.Authorization, 'Bearer new-api-token');

  const keyCall = fetchMock.calls.find((call) => call.pathname === '/api/token/42/key');
  assert.equal(keyCall.method, 'POST');
  assert.equal(keyCall.headers.Authorization, 'Bearer new-api-token');
});
