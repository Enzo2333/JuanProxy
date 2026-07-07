const api = window.openApiProxy;

let state = null;
let expanded = false;
let drag = null;
let suppressClick = false;
let pointerDown = false;
let hovering = false;
let hoverExpandTimer = null;
let hoverCollapseTimer = null;

const elements = {
  shell: document.querySelector('#floating-shell'),
  handle: document.querySelector('#floating-handle'),
  initial: document.querySelector('#floating-initial'),
  name: document.querySelector('#floating-name'),
  meta: document.querySelector('#floating-meta'),
  panel: document.querySelector('#floating-panel'),
  panelName: document.querySelector('#floating-panel-name'),
  status: document.querySelector('#floating-status'),
  main: document.querySelector('#floating-main'),
  details: document.querySelector('#floating-details'),
  alwaysOnTop: document.querySelector('#floating-always-on-top'),
  collapse: document.querySelector('#floating-collapse')
};

async function init() {
  state = await api.getState();
  render();
  api.onStateChanged((nextState) => {
    state = nextState;
    render();
  });
  api.onSiteChanged?.((patch) => {
    applySitePatch(patch);
    render();
  });
}

function applySitePatch(patch = {}) {
  if (!state || !patch.site?.id) {
    return;
  }
  state = {
    ...state,
    ...(patch.proxyStatus ? { proxyStatus: patch.proxyStatus } : {}),
    ...(Object.hasOwn(patch, 'activeSiteId') ? { activeSiteId: patch.activeSiteId } : {}),
    sites: state.sites.map((site) => site.id === patch.site.id ? patch.site : site)
  };
}

function render() {
  const site = getActiveSite();
  elements.alwaysOnTop.checked = Boolean(state?.appSettings?.floatingWindow?.alwaysOnTop);
  elements.shell.className = ['floating-shell', expanded ? 'is-expanded' : '', drag ? 'is-dragging' : '']
    .filter(Boolean)
    .join(' ');
  elements.handle.setAttribute('aria-expanded', String(expanded));
  elements.panel.hidden = !expanded;

  if (!site) {
    elements.initial.textContent = '-';
    elements.name.textContent = '暂无站点';
    elements.meta.textContent = '-';
    elements.panelName.textContent = '暂无当前站点';
    elements.status.textContent = '-';
    elements.status.className = 'status-pill idle';
    elements.main.innerHTML = '<span>未选择可用站点</span>';
    elements.details.innerHTML = '<dt>状态</dt><dd>等待选择可用站点</dd>';
    return;
  }

  const successRate = calculateSuccessRate(site.successCount, site.errorCount);
  elements.initial.textContent = formatInitial(site.name);
  elements.name.textContent = site.name;
  elements.meta.textContent = formatCompactMeta(site);
  elements.panelName.textContent = site.name;
  elements.status.textContent = formatAvailabilityLabel(site);
  elements.status.className = `status-pill ${availabilityClass(site)}`;
  elements.main.innerHTML = [
    renderBalanceBadge(site),
    renderMultiplierBadge(site),
    `<span>${escapeHtml(`优先级 ${site.priority ?? 100}`)}</span>`,
    `<span>${escapeHtml(`请求 ${site.requestCount ?? 0}`)}</span>`,
    `<span>${escapeHtml(`成功率 ${formatSuccessRate(successRate)}`)}</span>`,
    `<span>${escapeHtml(`上次 ${formatLastRequestText(site.lastRequestAt)}`)}</span>`
  ].join('');
  elements.details.innerHTML = [
    ['Base URL', site.baseUrl || '-'],
    ['远端分组', site.sync?.remote?.keyGroup || '-'],
    ['同步时间', formatLocalDateTime(site.sync?.lastSyncAt)],
    ['速率限制', formatRateLimitSummary(site)],
    ['下次自检', formatLocalDateTime(site.autoRecoveryState?.nextCheckAt)],
    ['最近错误', site.lastError?.message ?? '-']
  ]
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(String(value))}</dd>`)
    .join('');
}

async function setExpanded(nextExpanded) {
  expanded = Boolean(nextExpanded);
  await api.setFloatingWindowExpanded?.(expanded);
  render();
}

function scheduleHoverExpand() {
  clearTimeout(hoverCollapseTimer);
  if (expanded || drag || pointerDown) {
    return;
  }
  clearTimeout(hoverExpandTimer);
  hoverExpandTimer = setTimeout(() => {
    hoverExpandTimer = null;
    if (!drag && !pointerDown && hovering) {
      setExpanded(true).catch((error) => {
        logRuntimeError('floating-renderer.expand-failed', error);
      });
    }
  }, 220);
}

function scheduleHoverCollapse() {
  clearTimeout(hoverExpandTimer);
  if (!expanded) {
    return;
  }
  clearTimeout(hoverCollapseTimer);
  hoverCollapseTimer = setTimeout(() => {
    hoverCollapseTimer = null;
    if (!hovering && !drag && !pointerDown) {
      setExpanded(false).catch((error) => {
        logRuntimeError('floating-renderer.collapse-failed', error);
      });
    }
  }, 160);
}

elements.shell.addEventListener('pointerenter', () => {
  hovering = true;
  scheduleHoverExpand();
});

elements.shell.addEventListener('pointerleave', () => {
  hovering = false;
  scheduleHoverCollapse();
});

elements.collapse.addEventListener('click', async () => {
  hovering = false;
  await setExpanded(false);
});

elements.alwaysOnTop.addEventListener('change', async () => {
  state = await api.updateAppSettings({
    floatingWindow: {
      alwaysOnTop: elements.alwaysOnTop.checked
    }
  });
  render();
});

elements.handle.addEventListener('pointerdown', async (event) => {
  if (event.button !== undefined && event.button !== 0) {
    return;
  }
  clearTimeout(hoverExpandTimer);
  clearTimeout(hoverCollapseTimer);
  pointerDown = true;
  const bounds = await api.getFloatingWindowBounds?.();
  if (!bounds) {
    pointerDown = false;
    return;
  }
  event.preventDefault();
  drag = {
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    startX: bounds.x,
    startY: bounds.y,
    moved: false
  };
  render();
});

window.addEventListener('pointermove', async (event) => {
  if (!drag) {
    return;
  }
  event.preventDefault();
  const dx = event.screenX - drag.startScreenX;
  const dy = event.screenY - drag.startScreenY;
  drag.moved = drag.moved || Math.abs(dx) > 3 || Math.abs(dy) > 3;
  await api.setFloatingWindowBounds?.({
    x: drag.startX + dx,
    y: drag.startY + dy
  });
});

window.addEventListener('pointerup', stopDrag);
window.addEventListener('pointercancel', stopDrag);

function stopDrag() {
  pointerDown = false;
  if (!drag) {
    return;
  }
  suppressClick = drag.moved;
  drag = null;
  render();
  if (suppressClick) {
    setTimeout(() => {
      suppressClick = false;
    }, 0);
  } else if (hovering) {
    scheduleHoverExpand();
  }
}

function getActiveSite() {
  return state?.sites?.find((site) => site.id === state.activeSiteId) ?? null;
}

function renderBalanceBadge(site) {
  const balance = site?.sync?.remote?.balance;
  return balance
    ? `<span class="site-balance-badge">${escapeHtml(`余额 ${balance}`)}</span>`
    : '<span class="site-balance-badge">余额 -</span>';
}

function renderMultiplierBadge(site) {
  const multiplier = Number(site?.multiplier ?? 1);
  const danger = multiplier > 1 ? ' is-danger' : '';
  return `<span class="site-multiplier-badge${danger}">${escapeHtml(`倍率 ${formatMultiplier(multiplier)}`)}</span>`;
}

function formatInitial(name) {
  const text = String(name ?? '').trim();
  return text ? text.slice(0, 1).toUpperCase() : '-';
}

function formatCompactMeta(site) {
  return `${formatMultiplier(site?.multiplier)}x`;
}

function calculateSuccessRate(successCount = 0, errorCount = 0) {
  const total = Number(successCount) + Number(errorCount);
  return total > 0 ? Number(successCount) / total : null;
}

function formatSuccessRate(value) {
  return value === null || !Number.isFinite(value) ? '-' : `${Math.round(value * 100)}%`;
}

function formatMultiplier(value) {
  const number = Number(value ?? 1);
  if (!Number.isFinite(number)) {
    return '1';
  }
  return Number.isInteger(number) ? String(number) : String(number);
}

function getAvailabilityState(site, now = new Date()) {
  const manualEnabled = site?.manualEnabled ?? site?.enabled ?? true;
  if (!manualEnabled) {
    return 'manual-disabled';
  }
  if (site?.failureDisabled) {
    return 'failure-disabled';
  }
  if (isRateLimitPaused(site, now)) {
    return 'rate-limited';
  }
  return 'enabled';
}

function formatAvailabilityLabel(site, now = new Date()) {
  const state = getAvailabilityState(site, now);
  if (state === 'manual-disabled') {
    return '人工停用';
  }
  if (state === 'failure-disabled') {
    return '错误停用';
  }
  if (state === 'rate-limited') {
    return '限速暂停';
  }
  return '启用中';
}

function availabilityClass(site) {
  const state = getAvailabilityState(site);
  if (state === 'enabled') {
    return 'success';
  }
  if (state === 'failure-disabled' || state === 'rate-limited') {
    return 'error';
  }
  return 'idle';
}

function isRateLimitPaused(site, now = new Date()) {
  if (!site?.rateLimit?.enabled || !site?.rateLimitState?.pausedUntil) {
    return false;
  }
  return new Date(site.rateLimitState.pausedUntil).getTime() > new Date(now).getTime();
}

function formatRateLimitSummary(site) {
  if (!site?.rateLimit?.enabled) {
    return '不限速';
  }
  const unit = site.rateLimit.windowUnit === 'hour' ? '小时' : '分钟';
  const pausedUntil = site.rateLimitState?.pausedUntil;
  const usage = `${site.rateLimitState?.used ?? 0}/${site.rateLimit.limit}`;
  return pausedUntil
    ? `限速 ${site.rateLimit.limit} 次/${site.rateLimit.windowValue}${unit} · 已暂停到 ${formatLocalDateTime(pausedUntil)}`
    : `限速 ${site.rateLimit.limit} 次/${site.rateLimit.windowValue}${unit} · 已用 ${usage}`;
}

function formatLastRequestText(lastRequestAt, now = new Date()) {
  if (!lastRequestAt) {
    return '尚无请求';
  }
  const requestTime = new Date(lastRequestAt).getTime();
  const nowTime = new Date(now).getTime();
  if (!Number.isFinite(requestTime) || !Number.isFinite(nowTime)) {
    return '尚无请求';
  }
  const elapsedMinutes = Math.floor(Math.max(0, nowTime - requestTime) / 60_000);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}分钟前`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}小时前`;
  }
  return `${Math.floor(elapsedHours / 24)}天前`;
}

function formatLocalDateTime(value, fallback = '-') {
  if (!value) {
    return fallback;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return fallback;
  }
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    const replacements = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return replacements[char];
  });
}

function installGlobalErrorHandlers() {
  window.addEventListener?.('error', (event) => {
    logRuntimeError('floating-renderer.global-error', event.error ?? event.message, {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno
    });
  });
  window.addEventListener?.('unhandledrejection', (event) => {
    logRuntimeError('floating-renderer.unhandled-rejection', event.reason);
  });
}

function formatRuntimeError(error) {
  return error?.message ?? String(error ?? '未知错误');
}

function logRuntimeError(source, error, context = {}) {
  if (!api?.logRuntimeError) {
    return;
  }

  api.logRuntimeError({
    source,
    error: serializeRuntimeError(error),
    message: formatRuntimeError(error),
    context
  }).catch(() => {});
}

function serializeRuntimeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  if (error && typeof error === 'object') {
    return {
      name: error.name ?? 'Error',
      message: error.message ?? String(error),
      stack: error.stack
    };
  }

  return {
    name: typeof error,
    message: String(error ?? '未知错误')
  };
}

installGlobalErrorHandlers();
init().catch((error) => {
  logRuntimeError('floating-renderer.init-failed', error);
  console.error(error);
});
