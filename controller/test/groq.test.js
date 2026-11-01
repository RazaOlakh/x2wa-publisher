'use strict';

const assert = require('assert');
const {
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  SYSTEM_PROMPT,
  getGroqConfig,
  isGroqConfigured,
  cleanGroqResponse,
  readGroqTranslation,
  buildGroqPayload,
  translateWithGroq,
} = require('../src/groq');

function ok(msg, val) {
  assert(val, msg);
  console.log('  ok   ' + msg);
}

function eq(msg, actual, expected) {
  assert.strictEqual(actual, expected, `${msg}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  console.log('  ok   ' + msg);
}

async function testGroqModule() {
  console.log('Groq configuration and defaults');
  eq('default model is openai/gpt-oss-120b', DEFAULT_MODEL, 'openai/gpt-oss-120b');
  eq('default base url is official Groq endpoint', DEFAULT_BASE_URL, 'https://api.groq.com/openai/v1');
  eq('default timeout is 30s', DEFAULT_TIMEOUT_MS, 30000);

  const emptyCfg = getGroqConfig({}, {});
  eq('reads empty key when unset', emptyCfg.apiKey, '');
  eq('falls back to default model', emptyCfg.model, 'openai/gpt-oss-120b');
  eq('falls back to default baseUrl', emptyCfg.baseUrl, 'https://api.groq.com/openai/v1');
  eq('falls back to default timeout', emptyCfg.timeoutMs, 30000);

  const envCfg = getGroqConfig({
    GROQ_API_KEY: 'gsk_test123',
    GROQ_MODEL: 'custom-model',
    GROQ_BASE_URL: 'https://custom.groq.com/v1',
    GROQ_TIMEOUT_MS: '45000',
  });
  eq('reads key from env', envCfg.apiKey, 'gsk_test123');
  eq('reads model from env', envCfg.model, 'custom-model');
  eq('reads baseUrl from env', envCfg.baseUrl, 'https://custom.groq.com/v1');
  eq('reads timeout from env', envCfg.timeoutMs, 45000);

  const overrideCfg = getGroqConfig({}, {
    apiKey: 'override_key',
    model: 'override_model',
    baseUrl: 'https://override.com',
    timeoutMs: 15000,
  });
  eq('override apiKey wins', overrideCfg.apiKey, 'override_key');
  eq('override model wins', overrideCfg.model, 'override_model');
  eq('override baseUrl wins', overrideCfg.baseUrl, 'https://override.com');
  eq('override timeout wins', overrideCfg.timeoutMs, 15000);

  eq('isGroqConfigured is false when empty', isGroqConfigured({}), false);
  eq('isGroqConfigured is true when GROQ_API_KEY is present', isGroqConfigured({ GROQ_API_KEY: 'gsk_123' }), true);
  eq('isGroqConfigured is true with override apiKey', isGroqConfigured({}, { apiKey: 'gsk_456' }), true);

  console.log('System prompt requirements verification');
  ok('system prompt specifies professional English-to-Urdu translator', SYSTEM_PROMPT.includes('You are a professional English-to-Urdu translator specialising in natural Pakistani Urdu.'));
  ok('system prompt requires natural Pakistani Urdu', SYSTEM_PROMPT.includes('Use natural Pakistani Urdu rather than overly formal or literary Urdu.'));
  ok('system prompt preserves tone and sarcasm', SYSTEM_PROMPT.includes("Preserve the author's tone, intent, humour, sarcasm, criticism, and emotional expression."));
  ok('system prompt translates idioms contextually', SYSTEM_PROMPT.includes('Translate idioms and expressions according to their meaning and context.'));
  ok('system prompt forbids translating proper names semantically', SYSTEM_PROMPT.includes('Do not translate proper names semantically.'));
  ok('system prompt preserves URLs, hashtags, mentions', SYSTEM_PROMPT.includes('Preserve numbers, dates, URLs, email addresses, hashtags, and mentions.'));
  ok('system prompt maintains paragraph breaks', SYSTEM_PROMPT.includes('Maintain paragraph breaks and readable formatting.'));
  ok('system prompt forbids explanations or omissions', SYSTEM_PROMPT.includes('Do not add explanations, opinions, summaries, or additional information.'));
  ok('system prompt requires only Urdu text', SYSTEM_PROMPT.includes('Return only the translated Urdu text.'));

  console.log('cleanGroqResponse sanitization');
  eq('plain text is trimmed', cleanGroqResponse('   یہ ایک ٹیسٹ ہے۔   '), 'یہ ایک ٹیسٹ ہے۔');
  eq('strips <think> tag blocks', cleanGroqResponse('<think>Let me analyze this sentence.</think>یہ ایک ٹیسٹ ہے۔'), 'یہ ایک ٹیسٹ ہے۔');
  eq('strips multiline <think> blocks', cleanGroqResponse('<think>\n1. Step one\n2. Step two\n</think>\nیہ ایک ٹیسٹ ہے۔'), 'یہ ایک ٹیسٹ ہے۔');
  eq('strips outer double quotes', cleanGroqResponse('"یہ ایک ٹیسٹ ہے۔"'), 'یہ ایک ٹیسٹ ہے۔');
  eq('strips outer curly quotes', cleanGroqResponse('“یہ ایک ٹیسٹ ہے۔”'), 'یہ ایک ٹیسٹ ہے۔');
  eq('strips outer guillemets quotes', cleanGroqResponse('«یہ ایک ٹیسٹ ہے۔»'), 'یہ ایک ٹیسٹ ہے۔');
  eq('returns null for empty string', cleanGroqResponse('   '), null);
  eq('returns null for <think> only', cleanGroqResponse('<think>Just thinking</think>'), null);
  eq('returns null for non-string', cleanGroqResponse(null), null);

  console.log('readGroqTranslation response parser');
  eq('null data returns null', readGroqTranslation(null), null);
  eq('empty choices returns null', readGroqTranslation({ choices: [] }), null);
  eq('missing message content returns null', readGroqTranslation({ choices: [{ message: {} }] }), null);
  eq('parses valid completion', readGroqTranslation({
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'لاہور کا موسم آج بہت خوشگوار ہے۔',
        },
      },
    ],
  }), 'لاہور کا موسم آج بہت خوشگوار ہے۔');

  console.log('buildGroqPayload request structure');
  const payload = buildGroqPayload('Hello Pakistan', 'qwen/qwen3.8-27b', 0.3);
  eq('payload model matches', payload.model, 'qwen/qwen3.8-27b');
  eq('payload temperature matches', payload.temperature, 0.3);
  eq('payload max_tokens matches default', payload.max_tokens, 800);
  eq('payload has 2 messages', payload.messages.length, 2);
  eq('first message is system role', payload.messages[0].role, 'system');
  eq('first message has system prompt', payload.messages[0].content, SYSTEM_PROMPT);
  eq('second message is user role', payload.messages[1].role, 'user');
  eq('second message has user text', payload.messages[1].content, 'Hello Pakistan');

  console.log('translateWithGroq execution');
  // 1. Missing API key
  let missingKeyError = null;
  try {
    await translateWithGroq('Hello', {}, { env: {} });
  } catch (e) {
    missingKeyError = e;
  }
  ok('throws when API key missing', missingKeyError && missingKeyError.message === 'groq-api-key-missing');

  // 2. Successful fetch
  let capturedUrl = null;
  let capturedOpts = null;
  const mockFetchSuccess = async (url, opts) => {
    capturedUrl = url;
    capturedOpts = opts;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'chatcmpl-test',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '<think>Translate naturally</think>ہیلو دنیا',
            },
            finish_reason: 'stop',
          },
        ],
      }),
    };
  };

  const successRes = await translateWithGroq('Hello world', {}, {
    apiKey: 'gsk_test_secret',
    fetchImpl: mockFetchSuccess,
  });
  eq('correct endpoint called', capturedUrl, 'https://api.groq.com/openai/v1/chat/completions');
  eq('method is POST', capturedOpts.method, 'POST');
  eq('authorization header present', capturedOpts.headers.Authorization, 'Bearer gsk_test_secret');
  eq('content-type is json', capturedOpts.headers['Content-Type'], 'application/json');
  const parsedBody = JSON.parse(capturedOpts.body);
  eq('model is openai/gpt-oss-120b', parsedBody.model, 'openai/gpt-oss-120b');
  eq('user content passed', parsedBody.messages[1].content, 'Hello world');
  eq('result text cleaned and stripped of think tags', successRes.text, 'ہیلو دنیا');
  eq('provider is groq', successRes.provider, 'groq');
  eq('model is openai/gpt-oss-120b', successRes.model, 'openai/gpt-oss-120b');

  // 3. HTTP 401 error
  const mockFetch401 = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: 'Invalid API Key', code: 'invalid_api_key' } }),
  });
  let err401 = null;
  try {
    await translateWithGroq('Hello', {}, { apiKey: 'bad_key', fetchImpl: mockFetch401 });
  } catch (e) {
    err401 = e;
  }
  ok('throws on 401', err401 && err401.status === 401);
  eq('includes error message from body', err401.message, 'Invalid API Key');

  // 4. HTTP 429 rate limit
  const mockFetch429 = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: { message: 'Rate limit reached', type: 'tokens' } }),
  });
  let err429 = null;
  try {
    await translateWithGroq('Hello', {}, { apiKey: 'valid_key', fetchImpl: mockFetch429 });
  } catch (e) {
    err429 = e;
  }
  ok('throws on 429', err429 && err429.status === 429);

  // 5. Empty or whitespace translation
  const mockFetchEmpty = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '<think>empty</think>' } }] }),
  });
  let errEmpty = null;
  try {
    await translateWithGroq('Hello', {}, { apiKey: 'valid_key', fetchImpl: mockFetchEmpty });
  } catch (e) {
    errEmpty = e;
  }
  ok('throws on empty response', errEmpty && errEmpty.message === 'groq-empty-response');

  // 6. Timeout
  const mockFetchTimeout = async (url, opts) => {
    return new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        reject(abortErr);
      });
    });
  };
  let errTimeout = null;
  try {
    await translateWithGroq('Hello', { timeoutMs: 20 }, { apiKey: 'valid_key', fetchImpl: mockFetchTimeout });
  } catch (e) {
    errTimeout = e;
  }
  ok('aborts and throws on timeout', errTimeout && errTimeout.timeout === true);

  console.log('Groq config endpoint and key masking');
  {
    const maskKey = (k) => k && k.length > 8 ? `${k.slice(0, 4)}...${k.slice(-4)}` : '';
    eq('masks key properly', maskKey('gsk_123456789abcdef'), 'gsk_...cdef');
    eq('empty key returns empty', maskKey(''), '');
  }

  console.log('\nALL GROQ TESTS PASSED');
}

testGroqModule().catch((e) => {
  console.error('Groq test failed:', e);
  process.exit(1);
});
