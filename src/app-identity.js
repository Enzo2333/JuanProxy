import { join } from 'node:path';

export const APP_DISPLAY_NAME = 'JuanProxy';
export const APP_ID = 'zone.huawei.juanproxy';

export function selectUserDataPath({
  appDataPath
} = {}) {
  if (!appDataPath) {
    throw new Error('appDataPath is required');
  }

  return join(appDataPath, APP_DISPLAY_NAME);
}
