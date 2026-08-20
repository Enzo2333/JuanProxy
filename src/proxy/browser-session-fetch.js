export function createBrowserSessionFetch(browserSession) {
  if (typeof browserSession?.fetch !== 'function') {
    throw new Error('Browser session fetch is unavailable');
  }
  return (url, options = {}) => fetchWithBrowserSession(browserSession, url, options);
}

export function normalizeSameOriginUrl(value, expectedOrigin) {
  try {
    const parsed = new URL(String(value ?? '').trim());
    return parsed.origin === expectedOrigin && ['http:', 'https:'].includes(parsed.protocol)
      ? parsed.href
      : '';
  } catch {
    return '';
  }
}

async function fetchWithBrowserSession(browserSession, url, options) {
  const headers = new Headers(options.headers ?? {});
  const accountCookie = headers.get('Cookie') || '';
  const browserCookie = await getBrowserCookieHeader(browserSession, url);
  const cookie = mergeCookieHeaders(browserCookie, accountCookie);
  if (cookie) {
    headers.set('Cookie', cookie);
  }
  return browserSession.fetch(url, {
    ...options,
    headers,
    credentials: 'include'
  });
}

async function getBrowserCookieHeader(browserSession, url) {
  const cookieUrl = normalizeFetchUrl(url);
  if (!cookieUrl || typeof browserSession?.cookies?.get !== 'function') {
    return '';
  }
  try {
    const cookies = await browserSession.cookies.get({ url: cookieUrl });
    return cookies
      .filter((cookie) => cookie?.name && cookie?.value)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  } catch {
    return '';
  }
}

function mergeCookieHeaders(...headers) {
  const cookies = new Map();
  for (const header of headers) {
    for (const entry of String(header ?? '').split(';')) {
      const separator = entry.indexOf('=');
      if (separator <= 0) {
        continue;
      }
      const name = entry.slice(0, separator).trim();
      const value = entry.slice(separator + 1).trim();
      if (name && value) {
        cookies.set(name, value);
      }
    }
  }
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function normalizeFetchUrl(value) {
  try {
    if (value && typeof value === 'object' && typeof value.url === 'string') {
      return new URL(value.url).href;
    }
    return new URL(String(value ?? '')).href;
  } catch {
    return '';
  }
}
