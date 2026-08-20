import { BrowserWindow } from 'electron';

import {
  createBrowserSessionFetch,
  normalizeSameOriginUrl
} from './proxy/browser-session-fetch.js';

const DEFAULT_TURNSTILE_TIMEOUT_MS = 120_000;
const DEFAULT_BROWSER_SESSION_TIMEOUT_MS = 120_000;
const BROWSER_SESSION_PARTITION = 'persist:juanproxy-remote-sync';
const BROWSER_SESSION_POLL_MS = 500;
const BROWSER_SESSION_SHOW_DELAY_MS = 2_500;
const TURNSTILE_WINDOW_SIZE = {
  width: 460,
  height: 560
};

export async function resolveTurnstileTokenWithWindow({
  parentWindow = null,
  origin,
  siteKey,
  timeoutMs = DEFAULT_TURNSTILE_TIMEOUT_MS
} = {}) {
  const normalizedOrigin = normalizeOrigin(origin);
  const normalizedSiteKey = String(siteKey ?? '').trim();
  if (!normalizedOrigin) {
    throw new Error('Turnstile verification origin is missing');
  }
  if (!normalizedSiteKey) {
    throw new Error('Turnstile site key is unavailable from the remote status endpoint');
  }

  const tokenWindow = new BrowserWindow({
    ...TURNSTILE_WINDOW_SIZE,
    parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
    modal: false,
    show: false,
    title: 'Turnstile Verification - JuanProxy',
    backgroundColor: '#f8fafc',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  let closed = false;
  const closedPromise = new Promise((_, reject) => {
    tokenWindow.once('closed', () => {
      closed = true;
      reject(new Error('Turnstile verification window was closed'));
    });
  });

  try {
    await tokenWindow.loadURL(normalizedOrigin);
    if (closed || tokenWindow.isDestroyed()) {
      throw new Error('Turnstile verification window was closed');
    }
    tokenWindow.show();
    tokenWindow.focus();

    const tokenPromise = tokenWindow.webContents.executeJavaScript(
      createTurnstileScript({
        siteKey: normalizedSiteKey,
        timeoutMs: normalizeTimeoutMs(timeoutMs)
      }),
      true
    );
    const token = String(await Promise.race([tokenPromise, closedPromise]) ?? '').trim();
    if (!token) {
      throw new Error('Turnstile verification did not return a token');
    }
    return token;
  } finally {
    if (!closed && !tokenWindow.isDestroyed()) {
      tokenWindow.close();
    }
  }
}

export async function resolveRemoteBrowserSessionWithWindow({
  parentWindow = null,
  origin,
  challengeUrl,
  timeoutMs = DEFAULT_BROWSER_SESSION_TIMEOUT_MS
} = {}) {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    throw new Error('Remote browser verification origin is missing');
  }
  const verificationUrl = normalizeSameOriginUrl(challengeUrl, normalizedOrigin) || normalizedOrigin;

  const verificationWindow = new BrowserWindow({
    ...TURNSTILE_WINDOW_SIZE,
    parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
    modal: false,
    show: false,
    title: 'Remote Verification - JuanProxy',
    backgroundColor: '#f8fafc',
    webPreferences: {
      partition: BROWSER_SESSION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const browserSession = verificationWindow.webContents.session;
  const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs);
  const startedAt = Date.now();
  let closed = false;
  let shown = false;
  verificationWindow.once('closed', () => {
    closed = true;
  });

  try {
    const initialLoad = verificationWindow.loadURL(verificationUrl).catch(() => null);
    await Promise.race([
      initialLoad,
      delay(Math.min(10_000, normalizedTimeoutMs))
    ]);
    while (Date.now() - startedAt < normalizedTimeoutMs) {
      if (closed || verificationWindow.isDestroyed()) {
        throw new Error('Remote browser verification window was closed');
      }
      const pageState = await readRemoteVerificationPageState(verificationWindow);
      if (pageState.ready && !isRemoteChallengePage(pageState)) {
        return {
          fetch: createBrowserSessionFetch(browserSession)
        };
      }
      if (!shown && Date.now() - startedAt >= BROWSER_SESSION_SHOW_DELAY_MS) {
        shown = true;
        verificationWindow.show();
        verificationWindow.focus();
      }
      await delay(BROWSER_SESSION_POLL_MS);
    }
    throw new Error('Timed out waiting for remote browser verification');
  } finally {
    if (!closed && !verificationWindow.isDestroyed()) {
      verificationWindow.close();
    }
  }
}

async function readRemoteVerificationPageState(window) {
  const emptyState = {
    ready: false,
    title: '',
    bodyText: '',
    html: '',
    href: ''
  };
  try {
    return await Promise.race([
      window.webContents.executeJavaScript(`
        (() => ({
          ready: document.readyState === 'interactive' || document.readyState === 'complete',
          title: String(document.title || ''),
          bodyText: String(document.body?.innerText || '').slice(0, 4000),
          html: String(document.documentElement?.innerHTML || '').slice(0, 12000),
          href: String(location.href || '')
        }))()
      `, true).catch(() => emptyState),
      delay(1_000).then(() => emptyState)
    ]);
  } catch {
    return emptyState;
  }
}

function isRemoteChallengePage(pageState) {
  const content = [pageState.title, pageState.bodyText, pageState.html].join('\n');
  return /(?:_cf_chl_opt|cf-chl-|challenge-platform|just a moment|cloudflare ray id|_waf_is_|\barg1\s*=|acw_sc__v2|aliyun.*challenge|esa.*challenge)/i.test(content);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createTurnstileScript({ siteKey, timeoutMs }) {
  return `
(() => new Promise((resolve, reject) => {
  const siteKey = ${JSON.stringify(siteKey)};
  const timeoutMs = ${JSON.stringify(timeoutMs)};
  let settled = false;
  let statusNode = null;
  let timer = null;

  function setStatus(message) {
    if (statusNode) {
      statusNode.textContent = message;
    }
  }

  function finish(token) {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    resolve(String(token || '').trim());
  }

  function fail(error) {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    reject(error instanceof Error ? error : new Error(String(error || 'Turnstile verification failed')));
  }

  timer = setTimeout(() => {
    fail(new Error('Timed out waiting for Turnstile verification'));
  }, timeoutMs);

  document.documentElement.lang = 'zh-CN';
  document.body.innerHTML = '';
  document.body.style.margin = '0';
  document.body.style.minHeight = '100vh';
  document.body.style.display = 'grid';
  document.body.style.placeItems = 'center';
  document.body.style.background = '#f8fafc';
  document.body.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  document.body.innerHTML = [
    '<main style="width:min(380px,calc(100vw - 40px));padding:24px;border:1px solid #e2e8f0;border-radius:16px;background:#fff;box-shadow:0 20px 45px rgba(15,23,42,.12)">',
    '<h1 style="margin:0 0 8px;font-size:20px;color:#0f172a">Turnstile 验证</h1>',
    '<p style="margin:0 0 18px;color:#475569;line-height:1.6">请完成 Cloudflare Turnstile 验证。验证通过后，JuanProxy 会自动继续远端同步。</p>',
    '<div id="juanproxy-turnstile" style="min-height:74px;display:flex;align-items:center;justify-content:center"></div>',
    '<p id="juanproxy-turnstile-status" style="margin:18px 0 0;color:#64748b;font-size:13px">正在加载验证组件...</p>',
    '</main>'
  ].join('');
  statusNode = document.getElementById('juanproxy-turnstile-status');

  function ensureTurnstileScript() {
    if (window.turnstile && typeof window.turnstile.render === 'function') {
      return Promise.resolve();
    }
    return new Promise((scriptResolve, scriptReject) => {
      const existing = document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]');
      if (existing) {
        existing.addEventListener('load', () => scriptResolve(), { once: true });
        existing.addEventListener('error', () => scriptReject(new Error('Failed to load Turnstile script')), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.onload = () => scriptResolve();
      script.onerror = () => scriptReject(new Error('Failed to load Turnstile script'));
      document.head.appendChild(script);
    });
  }

  ensureTurnstileScript()
    .then(() => {
      if (!window.turnstile || typeof window.turnstile.render !== 'function') {
        throw new Error('Turnstile renderer is unavailable');
      }
      setStatus('等待验证完成...');
      window.turnstile.render('#juanproxy-turnstile', {
        sitekey: siteKey,
        callback: (token) => {
          setStatus('验证完成，正在继续同步...');
          finish(token);
        },
        'error-callback': (code) => {
          setStatus('验证组件返回错误：' + (code || 'unknown') + '，请重试或刷新。');
        },
        'expired-callback': () => {
          setStatus('验证已过期，请重新完成验证。');
        }
      });
    })
    .catch(fail);
}))()
`;
}

function normalizeOrigin(value) {
  try {
    const parsed = new URL(String(value ?? '').trim());
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : '';
  } catch {
    return '';
  }
}

function normalizeTimeoutMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return DEFAULT_TURNSTILE_TIMEOUT_MS;
  }
  return Math.max(10_000, Math.min(Math.trunc(number), DEFAULT_TURNSTILE_TIMEOUT_MS));
}
