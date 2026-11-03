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

const SYSTEM_PROMPT = `You are an expert English-to-Urdu translator specialising in natural, contemporary Pakistani Urdu. Translate the complete text into fluent, natural Urdu while preserving its meaning, context, tone, humour, sarcasm, and formatting.

Rules:
- Author Name: If an author display name is provided at the start (e.g. "Author: ..."), always transliterate/translate it into Urdu script at the very top followed by a colon and a newline (e.g., Ali → علی:, Siddiq → صدیق:, Muhammad → محمد:, Imran Khan → عمران خان:, PTI → پی ٹی آئی:, ADV. Salman → ایڈووکیٹ سلمان:). Never leave the author name in English Latin script.
- Body Translation: Faithfully translate the complete body text into Urdu. Never omit, drop, or summarise words, even if a name or organization is already in the author line.
- Acronyms and initialisms: Write initialisms letter-by-letter in Urdu script (e.g., PTI → پی ٹی آئی, PMLN → پی ایم ایل این). Recognise professional titles contextually (e.g., ADV. → ایڈووکیٹ).
- Personal names: Write names in their commonly recognised Urdu spellings (Ali → علی, Siddiq → صدیق, Muhammad → محمد). Transliterate phonetically into Urdu script, never by literal dictionary meaning.
- Organisations and brands: Use their recognised Urdu names or conventional Urdu transliteration. Never translate their individual words literally.
- Technical elements: Keep @handles, usernames, hashtags, URLs, emails, numbers, dates, and technical identifiers unchanged.
- Output: Return ONLY the final translated Urdu text without any introductory remarks, notes, or explanations.`;

const PURE_SYSTEM_PROMPT = SYSTEM_PROMPT;

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
  // Strip outer markdown code block fences if present
  if (text.startsWith('```') && text.endsWith('```')) {
    text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  }
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
function buildGroqPayload(text, model = DEFAULT_MODEL, temperature = 0.1, maxTokens = DEFAULT_MAX_TOKENS, options = {}) {
  const isPure = options && options.pure !== undefined ? Boolean(options.pure) : true;
  const prompt = (options && options.systemPrompt) || (isPure ? PURE_SYSTEM_PROMPT : SYSTEM_PROMPT);

  let userContent = typeof text === 'string' ? text.trim() : '';
  const rawAuthor = options && options.author && typeof options.author === 'string' ? options.author.trim() : '';
  if (rawAuthor) {
    if (!userContent.toLowerCase().startsWith('author:') && !userContent.toLowerCase().startsWith(rawAuthor.toLowerCase())) {
      userContent = `Author: ${rawAuthor}\n\n${userContent}`;
    } else if (!userContent.toLowerCase().startsWith('author:') && userContent.toLowerCase().startsWith(rawAuthor.toLowerCase())) {
      const afterAuthor = userContent.slice(rawAuthor.length).replace(/^[:\s]+/, '');
      userContent = `Author: ${rawAuthor}\n\n${afterAuthor}`;
    }
  }

  const payload = {
    model,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: userContent },
    ],
    temperature,
  };
  if (maxTokens != null && Number.isFinite(maxTokens) && maxTokens > 0) {
    payload.max_tokens = maxTokens;
  }
  return payload;
}

// Translates `text` using Groq's official Chat Completions API.
// Returns { text, provider: 'groq', model, reasoning, durationMs } or throws an error.
async function translateWithGroq(text, options, deps) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { text: '', provider: 'groq', model: DEFAULT_MODEL, reasoning: null, durationMs: 0 };
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
  const temperature = (options && options.temperature != null) ? options.temperature : 0.1;
  const maxTokens = (options && options.maxTokens != null) ? options.maxTokens : config.maxTokens;
  const isPure = options && options.pure !== undefined ? Boolean(options.pure) : true;
  const fetchImpl = (deps && deps.fetchImpl) || fetch;

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const payload = buildGroqPayload(text, model, temperature, maxTokens, {
    pure: isPure,
    systemPrompt: options && options.systemPrompt,
    author: options && options.author,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try { controller.abort(); } catch {}
  }, timeoutMs);

  const t0 = Date.now();
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
    const firstChoice = (data && Array.isArray(data.choices) && data.choices[0] && data.choices[0].message) || {};
    if (!translated) {
      const err = new Error('groq-empty-response');
      err.retryable = false;
      throw err;
    }

    return {
      text: translated,
      raw: firstChoice.content || '',
      reasoning: firstChoice.reasoning || null,
      provider: 'groq',
      model,
      durationMs: Date.now() - t0,
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
  PURE_SYSTEM_PROMPT,
  getGroqConfig,
  isGroqConfigured,
  cleanGroqResponse,
  readGroqTranslation,
  buildGroqPayload,
  translateWithGroq,
};
