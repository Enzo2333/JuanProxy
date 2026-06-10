export function createCoalescedStateBroadcaster({
  send,
  delayMs = 250,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let timer = null;

  const run = () => {
    if (!timer) {
      return;
    }
    timer = null;
    send();
  };

  return {
    schedule() {
      if (timer) {
        return;
      }
      timer = setTimer(run, delayMs);
      timer.unref?.();
    },
    flush() {
      if (!timer) {
        return;
      }
      const pending = timer;
      timer = null;
      clearTimer(pending);
      send();
    }
  };
}
