import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  APP_ID,
  APP_DISPLAY_NAME,
  selectUserDataPath
} from '../src/app-identity.js';

test('uses the huawei.zone reverse-domain app id', () => {
  assert.equal(APP_ID, 'zone.huawei.juanproxy');
});

test('keeps the package build appId aligned with the runtime app id', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.build?.appId, APP_ID);
});

test('uses JuanProxy as the display app data directory by default', () => {
  const appDataPath = 'C:\\Users\\Example\\AppData\\Roaming';

  assert.equal(
    selectUserDataPath({ appDataPath }),
    join(appDataPath, APP_DISPLAY_NAME)
  );
});

test('uses JuanProxy even when a legacy config directory exists', () => {
  const appDataPath = 'C:\\Users\\Example\\AppData\\Roaming';
  const legacyConfigPath = join(appDataPath, 'RelayDesk', 'config.json');

  assert.equal(
    selectUserDataPath({
      appDataPath,
      exists: (filePath) => filePath === legacyConfigPath
    }),
    join(appDataPath, APP_DISPLAY_NAME)
  );
});

test('uses JuanProxy when both current and legacy config directories exist', () => {
  const appDataPath = 'C:\\Users\\Example\\AppData\\Roaming';
  const newConfigPath = join(appDataPath, APP_DISPLAY_NAME, 'config.json');
  const legacyConfigPath = join(appDataPath, 'RelayDesk', 'config.json');

  assert.equal(
    selectUserDataPath({
      appDataPath,
      exists: (filePath) => filePath === newConfigPath || filePath === legacyConfigPath
    }),
    join(appDataPath, APP_DISPLAY_NAME)
  );
});
