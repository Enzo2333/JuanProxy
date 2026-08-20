import { composeTargetUrl } from './proxy-server.js';
import { DEFAULT_TEST_MODEL } from './switching-policy.js';

export const CODEX_DESKTOP_USER_AGENT =
  'Codex Desktop/0.142.5 (Windows 10.0.26200; x86_64) unknown (Codex Desktop; 26.623.101652)';

export async function testSiteAvailability(
  site,
  { timeoutMs = 30000, testModel = DEFAULT_TEST_MODEL } = {}
) {
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
        model: testModel?.trim() || DEFAULT_TEST_MODEL,
        instructions: 'Reply briefly.',
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Hi'
              }
            ]
          }
        ],
        max_output_tokens: 1,
        stream: true
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    const bodyError = detectAvailabilityBodyError(text, response.headers.get('content-type'));
    const ok = response.ok && !bodyError;

    return {
      ok,
      statusCode: response.status,
      message: bodyError?.message ?? (
        response.ok ? 'Availability test succeeded' : `Availability test failed HTTP ${response.status}`
      ),
      detail: ok ? null : (bodyError?.detail ?? text.slice(0, 4096)),
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

function detectAvailabilityBodyError(text, contentType) {
  const body = String(text ?? '');
  const normalizedContentType = String(contentType ?? '').toLowerCase();

  if (normalizedContentType.includes('text/event-stream')) {
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === 'event: error' || trimmed === 'event:error') {
        const dataLine = body
          .slice(body.indexOf(line) + line.length)
          .split(/\r?\n/)
          .find((candidate) => candidate.trim().startsWith('data:'));
        const payloadText = dataLine?.replace(/^\s*data:\s*/, '').trim() ?? '';
        const payload = parseJson(payloadText);
        return {
          message: extractBodyErrorMessage(payload) ?? 'Availability test returned an error event',
          detail: body.slice(0, 4096)
        };
      }
      if (!trimmed.startsWith('data:')) {
        continue;
      }
      const payload = parseJson(trimmed.replace(/^data:\s*/, '').trim());
      const message = extractBodyErrorMessage(payload);
      if (message) {
        return { message, detail: body.slice(0, 4096) };
      }
    }
    return null;
  }

  const payload = parseJson(body);
  const message = extractBodyErrorMessage(payload);
  return message ? { message, detail: body.slice(0, 4096) } : null;
}

function parseJson(value) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractBodyErrorMessage(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  if (
    payload.type === 'error' ||
    String(payload.type ?? '').endsWith('.error') ||
    payload.error
  ) {
    const error = payload.error && typeof payload.error === 'object'
      ? payload.error
      : payload;
    return String(error.message ?? error.code ?? 'Availability test returned an error');
  }
  return null;
}
