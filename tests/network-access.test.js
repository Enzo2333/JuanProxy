import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProxyAccessUrls } from '../src/proxy/network-access.js';

test('builds a loopback-only URL when LAN access is disabled', () => {
  assert.deepEqual(buildProxyAccessUrls({
    port: 8787,
    allowLanAccess: false,
    interfaces: {
      WiFi: [{ address: '10.0.0.20', family: 'IPv4', internal: false }]
    }
  }), ['http://127.0.0.1:8787/v1']);
});

test('prefers physical private IPv4 addresses when LAN access is enabled', () => {
  assert.deepEqual(buildProxyAccessUrls({
    port: 10730,
    allowLanAccess: true,
    interfaces: {
      'VMware Network Adapter VMnet8': [
        { address: '172.16.0.20', family: 'IPv4', internal: false }
      ],
      'WLAN 2': [
        { address: '10.0.0.20', family: 'IPv4', internal: false }
      ],
      Loopback: [
        { address: '127.0.0.1', family: 'IPv4', internal: true }
      ]
    }
  }), [
    'http://10.0.0.20:10730/v1',
    'http://172.16.0.20:10730/v1',
    'http://127.0.0.1:10730/v1'
  ]);
});
