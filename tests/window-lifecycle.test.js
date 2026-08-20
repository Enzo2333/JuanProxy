import assert from 'node:assert/strict';
import test from 'node:test';

async function loadWindowLifecycle() {
  try {
    return await import('../src/window-lifecycle.js');
  } catch (error) {
    assert.fail(`窗口生命周期模块尚未实现: ${error?.message ?? error}`);
  }
}

test('closing the main window hides it while the app keeps running', async () => {
  const { hideMainWindowOnClose } = await loadWindowLifecycle();
  const calls = [];
  const event = {
    preventDefault() {
      calls.push('preventDefault');
    }
  };
  const window = {
    hide() {
      calls.push('hide');
    }
  };

  const hidden = hideMainWindowOnClose({ event, window, quitting: false });

  assert.equal(hidden, true);
  assert.deepEqual(calls, ['preventDefault', 'hide']);
});

test('closing the main window proceeds normally during explicit app shutdown', async () => {
  const { hideMainWindowOnClose } = await loadWindowLifecycle();
  let prevented = false;
  let hidden = false;

  const intercepted = hideMainWindowOnClose({
    event: {
      preventDefault() {
        prevented = true;
      }
    },
    window: {
      hide() {
        hidden = true;
      }
    },
    quitting: true
  });

  assert.equal(intercepted, false);
  assert.equal(prevented, false);
  assert.equal(hidden, false);
});

test('showing the main window restores, shows, and focuses it', async () => {
  const { showMainWindow } = await loadWindowLifecycle();
  const calls = [];
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus')
  };

  const shown = showMainWindow(window);

  assert.equal(shown, true);
  assert.deepEqual(calls, ['restore', 'show', 'focus']);
});

test('showing a missing or destroyed main window is a no-op', async () => {
  const { showMainWindow } = await loadWindowLifecycle();

  assert.equal(showMainWindow(null), false);
  assert.equal(showMainWindow({ isDestroyed: () => true }), false);
});
