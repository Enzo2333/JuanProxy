import { composeTargetUrl } from './proxy-server.js';
import { DEFAULT_TEST_MODEL } from './switching-policy.js';

export async function testSiteAvailability(site, { timeoutMs = 30000 } = {}) {
  const target = composeTargetUrl(site.baseUrl, '/v1/responses');
  const startedAt = Date.now();

  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${site.apiKey}`
      },
      body: JSON.stringify({
        model: site.testModel?.trim() || DEFAULT_TEST_MODEL,
        input: 'Hi',
        max_output_tokens: 1,
        stream: false
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
