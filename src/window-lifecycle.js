export function hideMainWindowOnClose({ event, window, quitting = false } = {}) {
  if (quitting || !event || !window || window.isDestroyed?.()) {
    return false;
  }

  event.preventDefault();
  window.hide();
  return true;
}

export function showMainWindow(window) {
  if (!window || window.isDestroyed?.()) {
    return false;
  }

  if (window.isMinimized?.()) {
    window.restore();
  }
  window.show();
  window.focus();
  return true;
}
