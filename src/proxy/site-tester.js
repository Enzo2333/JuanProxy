import { composeTargetUrl } from './proxy-server.js';
import { DEFAULT_TEST_MODEL } from './switching-policy.js';

export const CODEX_DESKTOP_USER_AGENT =
  'Codex Desktop/0.142.5 (Windows 10.0.26200; x86_64) unknown (Codex Desktop; 26.623.101652)';

export async function testSiteAvailability(site, { timeoutMs = 30000 } = {}) {
  const target = composeTargetUrl(site.baseUrl, '/v1/responses');
  const startedAt = Date.now();

  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'User-Agent': CODEX_DESKTOP_USER_AGENT,
        Authorization: `Bearer ${site.apiKey}`
      },
      body: JSON.stringify({
        model: site.testModel?.trim() || DEFAULT_TEST_MODEL,
        instructions: 'Reply briefly.',
        input: 'Hi',
        max_output_tokens: 1,
        stream: true
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();

    return {
      ok: response.ok,
      statusCode: response.status,
      message: response.ok ? 'Availability test succeeded' : `Availability test failed HTTP ${response.status}`,
      detail: response.ok ? null : text.slice(0, 4096),
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      message: error.message,
      detail: null,
      durationMs: Date.now() - startedAt
    };
  }
}
