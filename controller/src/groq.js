'use strict';

// Groq API integration for English-to-Urdu translation using Qwen 3.8 27B.
//
// Model: qwen/qwen3.8-27b
// Endpoint: https://api.groq.com/openai/v1/chat/completions
//
// Translates social media posts into natural Pakistani Urdu while preserving
// meaning, tone, sarcasm, formatting, URLs, mentions, hashtags, and numbers.
//
// Credentials: Read from process.env.GROQ_API_KEY on the local controller only.
// Never exposed in browser extensions, client-side storage, or logs.

const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_TIMEOUT_MS = 30000;
// Groq's on-demand rate limit for Qwen 3.8 27B / GPT-OSS enforces 1,000 output tokens per minute (OTPM).
// Setting max_tokens ensures requests do not exceed this limit.
const DEFAULT_MAX_TOKENS = 800;
const USER_AGENT = 'x-whatsapp-poster-controller/1.0';

const SUPPORTED_MODELS = [
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B (Recommended · High Quality Urdu)', name: 'GPT-OSS 120B' },
  { id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B (Fast / Lightweight)', name: 'Qwen 3.8 27B' },
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B (OpenAI Reasoning 20B)', name: 'GPT-OSS 20B' },
  { id: 'allam-2-7b', label: 'Allam 2 7B (SDAIA Regional)', name: 'Allam 2 7B' },
];

function formatModelDisplayName(modelId) {
  if (!modelId) return 'AI Model';
  const found = SUPPORTED_MODELS.find((m) => m.id === modelId);
  if (found) return found.name;
  if (modelId.includes('/')) return modelId.split('/')[1];
  return modelId;
}

const SYSTEM_PROMPT = `You are a professional English-to-Urdu translator specialising in natural Pakistani Urdu.

Translate the supplied social media post into fluent, natural Urdu.

Rules:
- Preserve the complete original meaning.
- Use natural Pakistani Urdu rather than overly formal or literary Urdu.
- Preserve the author's tone, intent, humour, sarcasm, criticism, and emotional expression.
- Translate idioms and expressions according to their meaning and context.
- Preserve names, usernames, brands, product names, organisations, and technical terminology appropriately.
- Do not translate proper names semantically.
- Preserve numbers, dates, URLs, email addresses, hashtags, and mentions.
- Maintain paragraph breaks and readable formatting.
- Do not add explanations, opinions, summaries, or additional information.
- Do not omit any part of the original post.
- Return only the translated Urdu text.`;

// Configuration reader with fallback defaults.
function getGroqConfig(env = process.env, overrides = {}) {
  const apiKey = (overrides && (overrides.apiKey || overrides.groqApiKey)) || env.GROQ_API_KEY || '';
  const model = (overrides && (overrides.model || overrides.groqModel)) || env.GROQ_MODEL || DEFAULT_MODEL;
  const baseUrl = (overrides && (overrides.baseUrl || overrides.groqBaseUrl)) || env.GROQ_BASE_URL || DEFAULT_BASE_URL;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (overrides && overrides.timeoutMs != null) {
    timeoutMs = overrides.timeoutMs;
  } else if (env.GROQ_TIMEOUT_MS) {
    const parsed = parseInt(env.GROQ_TIMEOUT_MS, 10);
    if (Number.isFinite(parsed) && parsed > 0) timeoutMs = parsed;
  }
  let maxTokens = DEFAULT_MAX_TOKENS;
  if (overrides && overrides.maxTokens != null) {
    maxTokens = overrides.maxTokens;
  } else if (env.GROQ_MAX_TOKENS) {
    const parsed = parseInt(env.GROQ_MAX_TOKENS, 10);
    if (Number.isFinite(parsed) && parsed > 0) maxTokens = parsed;
  }
  return { apiKey, model, baseUrl, timeoutMs, maxTokens };
}

// Checks if Groq is configured with an API key.
function isGroqConfigured(env = process.env, overrides = {}) {
  const { apiKey } = getGroqConfig(env, overrides);
  return typeof apiKey === 'string' && apiKey.trim().length > 0;
}

// Strips model thinking/reasoning tags and enclosing quotation wrappers.
function cleanGroqResponse(rawText) {
  if (typeof rawText !== 'string') return null;
  // Strip <think>...</think> reasoning blocks if present in model output
  let text = rawText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Strip outer matching quotation marks if the LLM wrapped its entire response in quotes
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith('“') && text.endsWith('”') && text.length >= 2) ||
    (text.startsWith('«') && text.endsWith('»') && text.length >= 2)
  ) {
    const unquoted = text.slice(1, -1).trim();
    if (unquoted.length > 0) text = unquoted;
  }
  return text.length > 0 ? text : null;
}

// Extracts translated text from Groq Chat Completions API response.
function readGroqTranslation(data) {
  if (!data || typeof data !== 'object') return null;
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== 'object') return null;
  const msg = first.message;
  if (!msg || typeof msg !== 'object') return null;
  const content = msg.content;
  if (typeof content !== 'string') return null;
  return cleanGroqResponse(content);
}

// Constructs Chat Completions payload for Groq.
function buildGroqPayload(text, model = DEFAULT_MODEL, temperature = 0.3, maxTokens = DEFAULT_MAX_TOKENS) {
  const payload = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ],
    temperature,
  };
  if (maxTokens != null && Number.isFinite(maxTokens) && maxTokens > 0) {
    payload.max_tokens = maxTokens;
  }
  return payload;
}

// Translates `text` using Groq's official Chat Completions API with Qwen 3.8 27B.
// Returns { text, provider: 'groq', model } or throws an error.
async function translateWithGroq(text, options, deps) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { text: '', provider: 'groq', model: DEFAULT_MODEL };
  }

  const env = (deps && deps.env) || process.env;
  const config = getGroqConfig(env, deps);
  if (!config.apiKey) {
    const err = new Error('groq-api-key-missing');
    err.code = 'MISSING_API_KEY';
    err.retryable = false;
    throw err;
  }

  const model = (options && options.model) || config.model;
  const baseUrl = (options && options.baseUrl) || config.baseUrl;
  const timeoutMs = (options && options.timeoutMs != null) ? options.timeoutMs : config.timeoutMs;
  const temperature = (options && options.temperature != null) ? options.temperature : 0.3;
  const maxTokens = (options && options.maxTokens != null) ? options.maxTokens : config.maxTokens;
  const fetchImpl = (deps && deps.fetchImpl) || fetch;

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const payload = buildGroqPayload(text, model, temperature, maxTokens);

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try { controller.abort(); } catch {}
  }, timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      let errBody = null;
      try { errBody = await res.json(); } catch {}
      const msg = (errBody && errBody.error && errBody.error.message) || `groq-http-${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.code = (errBody && errBody.error && errBody.error.code) || undefined;
      err.type = (errBody && errBody.error && errBody.error.type) || undefined;
      throw err;
    }

    const data = await res.json();
    const translated = readGroqTranslation(data);
    if (!translated) {
      const err = new Error('groq-empty-response');
      err.retryable = false;
      throw err;
    }

    return {
      text: translated,
      provider: 'groq',
      model,
    };
  } catch (e) {
    const isAbort = e && (e.name === 'AbortError' || /abort|timeout/i.test(e.message));
    if (isAbort) {
      const timeoutErr = new Error(`groq-timeout-${timeoutMs}ms`);
      timeoutErr.timeout = true;
      throw timeoutErr;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  SUPPORTED_MODELS,
  formatModelDisplayName,
  SYSTEM_PROMPT,
  getGroqConfig,
  isGroqConfigured,
  cleanGroqResponse,
  readGroqTranslation,
  buildGroqPayload,
  translateWithGroq,
};
