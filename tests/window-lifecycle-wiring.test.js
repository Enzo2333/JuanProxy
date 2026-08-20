import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const paths = {
  main: fileURLToPath(new URL('../src/main.js', import.meta.url)),
  preload: fileURLToPath(new URL('../src/preload.js', import.meta.url)),
  floatingHtml: fileURLToPath(new URL('../src/renderer/floating.html', import.meta.url)),
  floatingJs: fileURLToPath(new URL('../src/renderer/floating.js', import.meta.url)),
  indexHtml: fileURLToPath(new URL('../src/renderer/index.html', import.meta.url)),
  appJs: fileURLToPath(new URL('../src/renderer/app.js', import.meta.url))
};

test('main and renderer expose explicit show-main and quit lifecycle controls', async () => {
  const [main, preload, floatingHtml, floatingJs, indexHtml, appJs] = await Promise.all([
    readFile(paths.main, 'utf8'),
    readFile(paths.preload, 'utf8'),
    readFile(paths.floatingHtml, 'utf8'),
    readFile(paths.floatingJs, 'utf8'),
    readFile(paths.indexHtml, 'utf8'),
    readFile(paths.appJs, 'utf8')
  ]);

  assert.match(main, /from '\.\/window-lifecycle\.js'/);
  assert.match(main, /mainWindow\.on\('close'/);
  assert.match(main, /hideMainWindowOnClose\(\{/);
  assert.match(main, /handleLogged\('app-window:show-main'/);
  assert.match(main, /handleLogged\('app:quit'/);

  assert.match(preload, /showMainWindow:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('app-window:show-main'\)/);
  assert.match(preload, /quitApp:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('app:quit'\)/);

  assert.match(floatingHtml, /id="floating-open-main"/);
  assert.match(floatingHtml, /id="floating-quit-app"/);
  assert.match(floatingJs, /api\.showMainWindow\(\)/);
  assert.match(floatingJs, /api\.quitApp\(\)/);

  assert.match(indexHtml, /id="quit-app"/);
  assert.match(appJs, /quitApp:\s*document\.querySelector\('#quit-app'\)/);
  assert.match(appJs, /api\.quitApp\(\)/);
});
