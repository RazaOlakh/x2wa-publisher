'use strict';

const assert = require('assert');
const { compareTranslations } = require('../src/translate');
const { PURE_SYSTEM_PROMPT, buildGroqPayload, translateWithGroq } = require('../src/groq');

function ok(msg, val) {
  assert(val, msg);
  console.log('  ok   ' + msg);
}

function eq(msg, actual, expected) {
  assert.strictEqual(actual, expected, `${msg}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  console.log('  ok   ' + msg);
}

async function runTests() {
  console.log('--- 1. Pure Translation System Prompt & Payload ---');
  ok('pure system prompt is defined', typeof PURE_SYSTEM_PROMPT === 'string' && PURE_SYSTEM_PROMPT.length > 0);
  ok('pure system prompt instructs natural Pakistani Urdu', PURE_SYSTEM_PROMPT.includes('Pakistani Urdu'));
  ok('pure system prompt prohibits notes or explanations', PURE_SYSTEM_PROMPT.includes('without any introductory remarks, notes, or explanations'));

  const purePayload = buildGroqPayload('Hello world', 'openai/gpt-oss-120b', 0.2, 1000, { pure: true });
  eq('payload model matches', purePayload.model, 'openai/gpt-oss-120b');
  eq('payload temperature matches', purePayload.temperature, 0.2);
  eq('payload max_tokens matches', purePayload.max_tokens, 1000);
  eq('pure system prompt is in messages', purePayload.messages[0].content, PURE_SYSTEM_PROMPT);
  eq('pure text is untouched in user message', purePayload.messages[1].content, 'Hello world');

  console.log('\n--- 2. translateWithGroq Pure Execution & Reasoning Extraction ---');
  let capturedBody = null;
  const mockFetchSuccess = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '<think>Let me reason</think>ہیلو دنیا',
              reasoning: 'I reasoned carefully about translating hello world.',
            },
          },
        ],
      }),
    };
  };

  const groqRes = await translateWithGroq('Hello world', {
    model: 'openai/gpt-oss-120b',
    pure: true,
  }, {
    apiKey: 'gsk_mock_key',
    fetchImpl: mockFetchSuccess,
  });

  eq('pure prompt used in request', capturedBody.messages[0].content, PURE_SYSTEM_PROMPT);
  eq('pure raw user text passed without handle tokens', capturedBody.messages[1].content, 'Hello world');
  eq('translation text cleaned of think tags', groqRes.text, 'ہیلو دنیا');
  eq('reasoning extracted', groqRes.reasoning, 'I reasoned carefully about translating hello world.');
  eq('provider is groq', groqRes.provider, 'groq');
  eq('model is openai/gpt-oss-120b', groqRes.model, 'openai/gpt-oss-120b');
  ok('durationMs is recorded', typeof groqRes.durationMs === 'number' && groqRes.durationMs >= 0);

  console.log('\n--- 3. compareTranslations Multi-Model Parallel Analysis ---');
  const emptyRes = await compareTranslations('   ', {}, {});
  eq('rejects empty text', emptyRes.ok, false);
  eq('error is empty-text', emptyRes.error, 'empty-text');

  const mockCompareFetch = async (url, opts) => {
    if (url.includes('translate.googleapis.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => [['گوگل ترجمہ', 'en']],
      };
    }
    const body = JSON.parse(opts.body);
    const m = body.model;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: `ترجمہ از ${m}`,
              reasoning: `Thinking for ${m}`,
            },
          },
        ],
      }),
    };
  };

  const compareRes = await compareTranslations('Test sentence for models', {
    models: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'google'],
    pure: true,
  }, {
    apiKey: 'gsk_mock_key',
    fetchImpl: mockCompareFetch,
  });

  eq('compareRes ok is true', compareRes.ok, true);
  eq('original text preserved', compareRes.original, 'Test sentence for models');
  eq('pure flag preserved', compareRes.pure, true);
  eq('tested 3 models', compareRes.results.length, 3);

  const gpt120 = compareRes.results.find((r) => r.model === 'openai/gpt-oss-120b');
  ok('gpt-120b result found', Boolean(gpt120));
  eq('gpt-120b ok is true', gpt120.ok, true);
  eq('gpt-120b modelName is GPT-OSS 120B', gpt120.modelName, 'GPT-OSS 120B');
  eq('gpt-120b text matches', gpt120.text, 'ترجمہ از openai/gpt-oss-120b');
  eq('gpt-120b reasoning matches', gpt120.reasoning, 'Thinking for openai/gpt-oss-120b');
  eq('gpt-120b provider is groq', gpt120.provider, 'groq');

  const qwen = compareRes.results.find((r) => r.model === 'qwen/qwen3.8-27b');
  ok('qwen result found', Boolean(qwen));
  eq('qwen ok is true', qwen.ok, true);
  eq('qwen modelName is Qwen 3.8 27B', qwen.modelName, 'Qwen 3.8 27B');

  const google = compareRes.results.find((r) => r.model === 'google');
  ok('google result found', Boolean(google));
  eq('google ok is true', google.ok, true);
  eq('google modelName is Google Translate', google.modelName, 'Google Translate');
  eq('google text matches', google.text, 'گوگل ترجمہ');
  eq('google provider is google', google.provider, 'google');

  console.log('\n--- 4. Author Display Name (No Username/Handle) in Comparison ---');
  let capturedAuthorBody = null;
  const mockAuthorFetch = async (url, opts) => {
    capturedAuthorBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ڈونلڈ ٹرمپ:\nخلائی مشن کامیابی سے مکمل ہوا۔',
            },
          },
        ],
      }),
    };
  };

  const authorCompareRes = await compareTranslations('Space mission completed successfully.', {
    author: 'Donald J. Trump (@realDonaldTrump)',
    models: ['openai/gpt-oss-120b'],
    pure: true,
  }, {
    apiKey: 'gsk_mock_key',
    fetchImpl: mockAuthorFetch,
  });

  eq('original text includes display name only (handle stripped)', authorCompareRes.original, 'Donald J. Trump:\nSpace mission completed successfully.');
  eq('request body includes author display name at top', capturedAuthorBody.messages[1].content, 'Author: Donald J. Trump\n\nSpace mission completed successfully.');
  eq('result text has translated author', authorCompareRes.results[0].text, 'ڈونلڈ ٹرمپ:\nخلائی مشن کامیابی سے مکمل ہوا۔');

  console.log('\n--- 5. Error Isolation Across Models ---');
  const mockFetchWithFailures = async (url, opts) => {
    if (url.includes('translate.googleapis.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => [['گوگل کام کر رہا ہے', 'en']],
      };
    }
    const body = JSON.parse(opts.body);
    if (body.model === 'failing-model') {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: { message: 'Model overloaded' } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'ٹھیک ہے' } }],
      }),
    };
  };

  const failRes = await compareTranslations('Some text', {
    models: ['openai/gpt-oss-120b', 'failing-model', 'google'],
  }, {
    apiKey: 'gsk_key',
    fetchImpl: mockFetchWithFailures,
  });

  eq('comparison succeeds overall', failRes.ok, true);
  const failItem = failRes.results.find((r) => r.model === 'failing-model');
  eq('failing model reported error', failItem.ok, false);
  ok('error message captured', failItem.error.includes('Model overloaded'));
  const successItem = failRes.results.find((r) => r.model === 'openai/gpt-oss-120b');
  eq('other model succeeded unaffected', successItem.ok, true);

  console.log('\nALL COMPARE MODEL TRANSLATION TESTS PASSED');
}

runTests().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});
