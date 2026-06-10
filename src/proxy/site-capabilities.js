import { composeTargetUrl } from './proxy-server.js';
import {
  SITE_CAPABILITY_KEYS,
  normalizeSiteCapabilities,
  nowIso
} from './switching-policy.js';

const MAX_MODELS = 1000;
const MAX_DETAIL_LENGTH = 4096;
const FEATURE_DEFINITIONS = [
  {
    key: 'textGeneration',
    detector: ({ id, metadata }) =>
      hasAnyMetadataFlag(metadata, [
        'text_generation',
        'chat',
        'responses',
        'completion',
        'completions',
        'function_calling'
      ]) ||
      matchesAny(id, [
        /^gpt-/,
        /^o\d/,
        /^chatgpt-/,
        /^claude/,
        /^gemini/,
        /^deepseek/,
        /^qwen/,
        /^llama/,
        /^mistral/,
        /^mixtral/,
        /^yi-/,
        /^glm-/,
        /^moonshot/,
        /^doubao/,
        /^ernie/,
        /^abab/,
        /^spark/,
        /chat/,
        /instruct/,
        /sonnet/,
        /haiku/,
        /opus/
      ]) &&
      !isKnownNonTextFamily(id)
  },
  {
    key: 'imageGeneration',
    detector: ({ id, metadata }) =>
      hasAnyMetadataFlag(metadata, [
        'image_generation',
        'image',
        'images',
        'text_to_image',
        'generations'
      ]) ||
      matchesAny(id, [
        /^gpt-image/,
        /^dall[-_ ]?e/,
        /^imagen/,
        /image-generation/,
        /text-to-image/,
        /stable-diffusion/,
        /sdxl/,
        /flux/
      ])
  },
  {
    key: 'embeddings',
    detector: ({ id, metadata }) =>
      hasAnyMetadataFlag(metadata, ['embedding', 'embeddings']) ||
      matchesAny(id, [
        /embedding/,
        /^text-embedding/,
        /^bge-/,
        /^gte-/,
        /^e5-/,
        /^jina-embeddings?/
      ])
  },
  {
    key: 'audioTranscription',
    detector: ({ id, metadata }) =>
      hasAnyMetadataFlag(metadata, [
        'audio_transcription',
        'transcription',
        'speech_to_text'
      ]) ||
      matchesAny(id, [/whisper/, /transcribe/, /transcription/, /speech-to-text/, /stt/])
  },
  {
    key: 'audioSpeech',
    detector: ({ id, metadata }) =>
      hasAnyMetadataFlag(metadata, ['audio_speech', 'tts', 'text_to_speech', 'speech']) ||
      matchesAny(id, [/tts/, /text-to-speech/, /speech/, /audio.*preview/])
  },
  {
    key: 'vision',
    detector: ({ id, metadata }) =>
      hasAnyMetadataFlag(metadata, ['vision', 'image_input', 'multimodal']) ||
      matchesAny(id, [
        /vision/,
        /^gpt-4o/,
        /^gpt-5/,
        /^o\d/,
        /^gemini/,
        /^claude-3/,
        /^claude-(sonnet|opus|haiku)-4/,
        /vl\b/,
        /qwen.*vl/
      ])
  },
  {
    key: 'reasoning',
    detector: ({ id, metadata }) =>
      hasAnyMetadataFlag(metadata, ['reasoning']) ||
      matchesAny(id, [/^o\d/, /reasoning/, /r1\b/, /deepseek-reasoner/])
  },
  {
    key: 'toolCalling',
    detector: ({ id, metadata }) =>
      hasAnyMetadataFlag(metadata, [
        'tool_calling',
        'function_calling',
        'tools',
        'functions'
      ]) ||
      matchesAny(id, [
        /^gpt-/,
        /^o\d/,
        /^claude/,
        /^gemini/,
        /^deepseek-chat/,
        /^qwen/,
        /^mistral/,
        /tool/,
        /function/
      ]) &&
      !isKnownNonTextFamily(id)
  },
  {
    key: 'moderation',
    detector: ({ id, metadata }) =>
      hasAnyMetadataFlag(metadata, ['moderation']) ||
      matchesAny(id, [/moderation/, /^omni-moderation/])
  },
  {
    key: 'rerank',
    detector: ({ id, metadata }) =>
      hasAnyMetadataFlag(metadata, ['rerank', 'reranking']) ||
      matchesAny(id, [/rerank/, /re-rank/])
  }
];

export async function detectSiteCapabilities(site, {
  fetchImpl = fetch,
  timeoutMs = 30000,
  now = new Date()
} = {}) {
  const target = composeTargetUrl(site.baseUrl, '/v1/models');
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(target, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${site.apiKey}`
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = text.slice(0, MAX_DETAIL_LENGTH);
      const message = `Model discovery failed HTTP ${response.status}`;
      return {
        ok: false,
        statusCode: response.status,
        message,
        detail,
        durationMs: Date.now() - startedAt,
        capabilities: buildFailureCapabilities({ message: detail || message, now })
      };
    }

    const payload = parseJsonPayload(text);
    const modelEntries = extractModelEntries(payload);
    const capabilities = normalizeSiteCapabilities({
      ...buildCapabilitiesFromModels(modelEntries),
      checkedAt: nowIso(now),
      lastStatus: 'success',
      lastError: null,
      source: '/v1/models'
    });

    return {
      ok: true,
      statusCode: response.status,
      message: `Discovered ${capabilities.models.length} models`,
      detail: null,
      durationMs: Date.now() - startedAt,
      capabilities
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      message: error.message,
      detail: null,
      durationMs: Date.now() - startedAt,
      capabilities: buildFailureCapabilities({ message: error.message, now })
    };
  }
}

export function buildCapabilitiesFromModels(models = []) {
  const normalizedModels = normalizeModelEntries(models);
  return {
    models: normalizedModels.map((model) => model.id),
    features: inferModelFeatures(normalizedModels),
    featureModels: inferFeatureModels(normalizedModels)
  };
}

export function inferModelFeatures(models = []) {
  const featureModels = inferFeatureModels(models);
  return Object.fromEntries(
    SITE_CAPABILITY_KEYS.map((key) => [key, (featureModels[key] ?? []).length > 0])
  );
}

export function inferFeatureModels(models = []) {
  const normalizedModels = normalizeModelEntries(models);
  const featureModels = Object.fromEntries(SITE_CAPABILITY_KEYS.map((key) => [key, []]));

  for (const model of normalizedModels) {
    for (const definition of FEATURE_DEFINITIONS) {
      if (definition.detector(model)) {
        featureModels[definition.key].push(model.id);
      }
    }
  }

  return Object.fromEntries(
    SITE_CAPABILITY_KEYS.map((key) => [key, featureModels[key].sort(compareModelIds)])
  );
}

function buildFailureCapabilities({ message, now }) {
  return normalizeSiteCapabilities({
    checkedAt: nowIso(now),
    lastStatus: 'failure',
    lastError: String(message ?? '').slice(0, MAX_DETAIL_LENGTH),
    source: '/v1/models'
  });
}

function parseJsonPayload(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new Error('Model discovery returned invalid JSON');
  }
}

function extractModelEntries(payload) {
  const data =
    Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : Array.isArray(payload)
          ? payload
          : [];
  return data.slice(0, MAX_MODELS);
}

function normalizeModelEntries(models = []) {
  const seen = new Set();
  const normalized = [];

  for (const model of models) {
    const id = normalizeModelId(model);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    normalized.push({
      id,
      metadata: model && typeof model === 'object' ? model : {}
    });
  }

  return normalized.sort((left, right) => compareModelIds(left.id, right.id));
}

function normalizeModelId(model) {
  if (typeof model === 'string') {
    return model.trim();
  }
  if (!model || typeof model !== 'object') {
    return '';
  }
  return String(model.id ?? model.name ?? model.model ?? '').trim();
}

function compareModelIds(left, right) {
  return left.localeCompare(right);
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

function hasAnyMetadataFlag(metadata, keys) {
  return keys.some((key) => hasTruthyMetadataValue(metadata, key));
}

function hasTruthyMetadataValue(value, key) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  if (Object.hasOwn(value, key) && isTruthyCapabilityValue(value[key])) {
    return true;
  }

  for (const nestedKey of ['capabilities', 'features', 'supported_features', 'permission']) {
    if (hasTruthyMetadataValue(value[nestedKey], key)) {
      return true;
    }
  }

  return false;
}

function isTruthyCapabilityValue(value) {
  if (value === true) {
    return true;
  }
  if (typeof value === 'string') {
    return !['', 'false', '0', 'no', 'disabled'].includes(value.trim().toLowerCase());
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return false;
}

function isKnownNonTextFamily(id) {
  return matchesAny(id, [
    /embedding/,
    /^bge-/,
    /^gte-/,
    /^e5-/,
    /^dall[-_ ]?e/,
    /^gpt-image/,
    /^imagen/,
    /whisper/,
    /tts/,
    /moderation/,
    /rerank/
  ]);
}
