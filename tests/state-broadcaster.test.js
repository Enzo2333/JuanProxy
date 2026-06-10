import assert from 'node:assert/strict';
import test from 'node:test';

import { createCoalescedStateBroadcaster } from '../src/state-broadcaster.js';

test('coalesces repeated state broadcasts into one send per delay window', () => {
  const timers = [];
  let sendCount = 0;
  const broadcaster = createCoalescedStateBroadcaster({
    send: () => {
      sendCount += 1;
    },
    delayMs: 100,
    setTimer(callback, delay) {
      timers.push({ callback, delay, cleared: false });
      return timers.at(-1);
    },
    clearTimer(timer) {
      timer.cleared = true;
    }
  });

  broadcaster.schedule();
  broadcaster.schedule();
  broadcaster.schedule();

  assert.equal(sendCount, 0);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 100);

  timers[0].callback();

  assert.equal(sendCount, 1);
});

test('flush sends a pending broadcast immediately and clears its timer', () => {
  const timers = [];
  let sendCount = 0;
  const broadcaster = createCoalescedStateBroadcaster({
    send: () => {
      sendCount += 1;
    },
    setTimer(callback) {
      timers.push({ callback, cleared: false });
      return timers.at(-1);
    },
    clearTimer(timer) {
      timer.cleared = true;
    }
  });

  broadcaster.schedule();
  broadcaster.flush();

  assert.equal(sendCount, 1);
  assert.equal(timers[0].cleared, true);

  timers[0].callback();

  assert.equal(sendCount, 1);
});
