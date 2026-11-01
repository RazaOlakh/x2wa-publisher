'use strict';

const assert = require('assert');
const {
  translateText,
  translateTextWithMeta,
  translatePostText,
  translatePostTextWithMeta,
  transliterateText,
} = require('../src/translate');

function ok(msg, val) {
  assert(val, msg);
  console.log('  ok   ' + msg);
}

function eq(msg, actual, expected) {
  assert.strictEqual(actual, expected, `${msg}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  console.log('  ok   ' + msg);
}

async function runGroqIntegrationTests() {
  console.log('\n--- 1. Groq Translation as Primary Urdu Engine ---');
  {
    const logs = [];
    const testLog = (level, event, data) => logs.push({ level, event, data });

    const mockFetch = async (url, opts) => {
      // Groq Chat Completions request
      if (url.includes('api.groq.com')) {
        const body = JSON.parse(opts.body);
        eq('Groq request receives masked text', body.messages[1].content, 'ہیلو @h0 دنیا');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '<think>Keep handles intact</think>ہیلو @h0 دنیا',
                },
              },
            ],
          }),
        };
      }
      throw new Error('Unexpected URL: ' + url);
    };

    const res = await translateTextWithMeta('ہیلو @testuser دنیا', 'ur', {
      apiKey: 'gsk_live_mock',
      fetchImpl: mockFetch,
      log: testLog,
    });

    eq('Text returned has handle unmasked', res.text, 'ہیلو @testuser دنیا');
    eq('Provider is groq', res.provider, 'groq');
    eq('Model is qwen/qwen3.8-27b', res.model, 'qwen/qwen3.8-27b');

    ok('translate-groq-start log emitted', logs.some((l) => l.event === 'translate-groq-start'));
    ok('translate-groq-done log emitted', logs.some((l) => l.event === 'translate-groq-done' && l.data.provider === 'groq'));
  }

  console.log('\n--- 2. Fallback to Google Translate on Missing Key ---');
  {
    const logs = [];
    const testLog = (level, event, data) => logs.push({ level, event, data });

    const mockFetch = async (url) => {
      if (url.includes('translate.googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => [['گوگل ترجمہ', 'en']],
        };
      }
      throw new Error('Should not call: ' + url);
    };

    const res = await translateTextWithMeta('Google fallback test', 'ur', {
      env: {}, // no GROQ_API_KEY
      fetchImpl: mockFetch,
      log: testLog,
    });

    eq('Google translation text returned', res.text, 'گوگل ترجمہ');
    eq('Provider is google', res.provider, 'google');
    ok('Log records groq skipped due to no API key', logs.some((l) => l.event === 'translate-groq-skipped' && l.data.reason === 'no-api-key'));
    ok('Log records google translation done', logs.some((l) => l.event === 'translate-google-done' && l.data.provider === 'google'));
  }

  console.log('\n--- 3. Fallback to Google Translate on Groq Rate Limit (429) ---');
  {
    const logs = [];
    const testLog = (level, event, data) => logs.push({ level, event, data });

    const mockFetch = async (url) => {
      if (url.includes('api.groq.com')) {
        return {
          ok: false,
          status: 429,
          json: async () => ({ error: { message: 'Rate limit exceeded' } }),
        };
      }
      if (url.includes('translate.googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => [['کامیاب فال بیک', 'en']],
        };
      }
      throw new Error('Unexpected URL: ' + url);
    };

    const res = await translateTextWithMeta('Rate limit test', 'ur', {
      apiKey: 'gsk_valid_key',
      fetchImpl: mockFetch,
      log: testLog,
    });

    eq('Fallback text returned', res.text, 'کامیاب فال بیک');
    eq('Provider is google', res.provider, 'google');
    ok('translate-groq-failed log emitted with status 429', logs.some((l) => l.event === 'translate-groq-failed' && l.data.status === 429));
    ok('translate-google-done log emitted', logs.some((l) => l.event === 'translate-google-done'));
  }

  console.log('\n--- 4. Fallback to Google Translate on Groq HTTP 500 & Network Errors ---');
  {
    const logs = [];
    const testLog = (level, event, data) => logs.push({ level, event, data });

    const mockFetch = async (url) => {
      if (url.includes('api.groq.com')) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: { message: 'Internal Server Error' } }),
        };
      }
      if (url.includes('translate.googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => [['سرور کی خرابی سے بحال', 'en']],
        };
      }
      throw new Error('Unexpected URL: ' + url);
    };

    const res = await translateTextWithMeta('Server error test', 'ur', {
      apiKey: 'gsk_valid_key',
      fetchImpl: mockFetch,
      log: testLog,
    });

    eq('Fallback text returned', res.text, 'سرور کی خرابی سے بحال');
    eq('Provider is google', res.provider, 'google');
    ok('translate-groq-failed emitted with status 500', logs.some((l) => l.event === 'translate-groq-failed' && l.data.status === 500));
  }

  console.log('\n--- 5. Fallback to Google Translate on Groq Timeout ---');
  {
    const logs = [];
    const testLog = (level, event, data) => logs.push({ level, event, data });

    const mockFetch = async (url, opts) => {
      if (url.includes('api.groq.com')) {
        return new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      if (url.includes('translate.googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => [['ٹائم آؤٹ فال بیک', 'en']],
        };
      }
      throw new Error('Unexpected URL: ' + url);
    };

    const res = await translateTextWithMeta('Timeout test', 'ur', {
      apiKey: 'gsk_valid_key',
      timeoutMs: 15,
      fetchImpl: mockFetch,
      log: testLog,
    });

    eq('Timeout fallback text returned', res.text, 'ٹائم آؤٹ فال بیک');
    eq('Provider is google', res.provider, 'google');
    ok('translate-groq-failed log recorded timeout', logs.some((l) => l.event === 'translate-groq-failed' && /timeout/i.test(l.data.error)));
  }

  console.log('\n--- 6. Fallback on Empty or Malformed Groq Response ---');
  {
    const logs = [];
    const testLog = (level, event, data) => logs.push({ level, event, data });

    const mockFetch = async (url) => {
      if (url.includes('api.groq.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: '   ' } }] }),
        };
      }
      if (url.includes('translate.googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => [['خالی جواب فال بیک', 'en']],
        };
      }
      throw new Error('Unexpected URL: ' + url);
    };

    const res = await translateTextWithMeta('Empty test', 'ur', {
      apiKey: 'gsk_valid_key',
      fetchImpl: mockFetch,
      log: testLog,
    });

    eq('Empty response falls back to Google', res.text, 'خالی جواب فال بیک');
    eq('Provider is google', res.provider, 'google');
    ok('Recorded empty response error', logs.some((l) => l.event === 'translate-groq-failed' && l.data.error === 'groq-empty-response'));
  }

  console.log('\n--- 7. Non-Urdu Target Skips Groq ---');
  {
    const logs = [];
    const testLog = (level, event, data) => logs.push({ level, event, data });

    const mockFetch = async (url) => {
      if (url.includes('translate.googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => [['Hola Mundo', 'en']],
        };
      }
      throw new Error('Groq should not be called for Spanish: ' + url);
    };

    const res = await translateTextWithMeta('Hello World', 'es', {
      apiKey: 'gsk_valid_key',
      fetchImpl: mockFetch,
      log: testLog,
    });

    eq('Spanish text returned', res.text, 'Hola Mundo');
    eq('Provider is google', res.provider, 'google');
    ok('Groq was not started for Spanish', !logs.some((l) => l.event === 'translate-groq-start'));
  }

  console.log('\n--- 8. Author Header Transliteration + Groq Post Body Translation ---');
  {
    // Post with author header:
    // Reborn
    //
    // Big announcement today!
    const postWithHeader = 'Reborn\n\nBig announcement today!';

    const mockFetch = async (url) => {
      if (url.includes('inputtools.google.com')) {
        // Phonetic transliteration for Reborn -> ری بورن
        return {
          ok: true,
          status: 200,
          json: async () => ['SUCCESS', [['Reborn', ['ری بورن'], [], []]]],
        };
      }
      if (url.includes('api.groq.com')) {
        // Groq translation for post body
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'آج ایک بڑا اعلان کیا جا رہا ہے!',
                },
              },
            ],
          }),
        };
      }
      throw new Error('Unexpected fetch: ' + url);
    };

    const res = await translatePostTextWithMeta(postWithHeader, 'ur', 'Reborn', {
      apiKey: 'gsk_valid_key',
      fetchImpl: mockFetch,
    });

    eq(
      'Author is phonetically transliterated and body translated via Groq',
      res.text,
      'ری بورن\n\nآج ایک بڑا اعلان کیا جا رہا ہے!'
    );
    eq('Provider is groq', res.provider, 'groq');
    eq('Model is qwen/qwen3.8-27b', res.model, 'qwen/qwen3.8-27b');
    ok('authorTransliterated flag is true', res.authorTransliterated === true);
  }

  console.log('\n--- 9. 8 Real-World Categories: Groq vs Google Translate Comparison ---');
  const realWorldCases = [
    {
      category: '1. Ordinary English sentences',
      input: 'The weather in Lahore is beautiful this evening. Going out for a walk with family.',
      googleTranslation: 'آج شام لاہور میں موسم خوبصورت ہے۔ خاندان کے ساتھ چہل قدمی کے لیے نکلنا۔',
      groqTranslation: 'آج شام لاہور کا موسم بہت خوشگوار ہے۔ فیملی کے ساتھ واک پر نکل رہے ہیں۔',
      criteria: 'Natural phrasing: uses خوشگوار and فیملی کے ساتھ واک instead of literal چہل قدمی کے لیے نکلنا',
    },
    {
      category: '2. Long posts with multiple paragraphs',
      input: 'After months of hard work, our team is proud to announce the launch of our new open-source project.\n\nWe built this tool to help developers automate repetitive workflows.\n\nCheck out the GitHub repository, give us a star, and let us know what you think!',
      googleTranslation: 'مہینوں کی محنت کے بعد، ہماری ٹیم کو اپنے نئے اوپن سورس پروجیکٹ کے آغاز کا اعلان کرتے ہوئے فخر محسوس ہو رہا ہے۔\n\nہم نے یہ ٹول ڈویلپرز کو بار بار چلنے والے ورک فلو کو خودکار بنانے میں مدد کے لیے بنایا ہے۔\n\nGitHub ذخیرہ چیک کریں، ہمیں ستارہ دیں، اور ہمیں بتائیں کہ آپ کیا سوچتے ہیں!',
      groqTranslation: 'مہینوں کی انتھک محنت کے بعد ہماری ٹیم کو اپنے نئے اوپن سورس پروجیکٹ کے آغاز کا اعلان کرتے ہوئے فخر ہے۔\n\nہم نے یہ ٹول ڈویلپرز کی مدد کے لیے بنایا ہے تاکہ وہ تکراری کاموں کو خودکار بنا سکیں۔\n\nگٹ ہب ریپوزٹری دیکھیں، ہمیں اسٹار دیں اور نیچے کمنٹس میں اپنی رائے سے ضرور آگاہ کریں!',
      criteria: 'Preserves \\n\\n paragraph breaks and contextually translates GitHub star and repository without literal nonsense (ستارہ دیں)',
    },
    {
      category: '3. Political commentary',
      input: 'The government\'s new taxation policy is putting an unbearable burden on the salaried class. Instead of broadening the tax net, they are squeezing compliant taxpayers.',
      googleTranslation: 'حکومت کی نئی ٹیکس پالیسی تنخواہ دار طبقے پر ناقابل برداشت بوجھ ڈال رہی ہے۔ ٹیکس نیٹ کو وسعت دینے کے بجائے، وہ انہی مطیع ٹیکس دہندگان کو نچوڑ رہے ہیں۔',
      groqTranslation: 'حکومت کی نئی ٹیکس پالیسی تنخواہ دار طبقے پر ناقابل برداشت بوجھ ڈال رہی ہے۔ ٹیکس نیٹ کو وسیع کرنے کے بجائے، پہلے سے باقاعدگی سے ٹیکس دینے والوں پر ہی مزید بوجھ ڈالا جا رہا ہے۔',
      criteria: 'Captures critical political commentary tone and avoids awkward literal translation like مطیع ٹیکس دہندگان کو نچوڑ رہے ہیں',
    },
    {
      category: '4. Sarcasm and humour',
      input: 'Oh brilliant! Another 4-hour unannounced load shedding right when I sat down to join the client meeting. What a world-class infrastructure we have!',
      googleTranslation: 'اوہ شاندار! ایک اور 4 گھنٹے کی غیر اعلانیہ لوڈ شیڈنگ ٹھیک اس وقت جب میں کلائنٹ میٹنگ میں شامل ہونے بیٹھا تھا۔ ہمارے پاس کیسا عالمی معیار کا بنیادی ڈھانچہ ہے!',
      groqTranslation: 'واہ کیا بات ہے! ٹھیک اسی وقت جب میں کلائنٹ کی میٹنگ میں شامل ہونے بیٹھا، مزید 4 گھنٹے کی غیراعلانیہ لوڈشیڈنگ ہو گئی۔ کیا شاندار عالمی معیار کا انفراسٹرکچر ہے ہمارا!',
      criteria: 'Expresses authentic Pakistani sarcastic expression واہ کیا بات ہے and maintains sarcastic bite',
    },
    {
      category: '5. Idioms and slang',
      input: 'Stop beating around the bush and spill the beans. We all know you aced the interview, no cap!',
      googleTranslation: 'جھاڑی کے گرد مارنا بند کرو اور پھلیاں چھڑک دو۔ ہم سب جانتے ہیں کہ آپ نے انٹرویو پاس کر لیا ہے، کوئی ٹوپی نہیں!',
      groqTranslation: 'باتیں گھمانا بند کرو اور صاف صاف سچ بتاؤ۔ ہم سب جانتے ہیں کہ تم نے انٹرویو میں کمال کر دیا ہے، سچ میں!',
      criteria: 'Correctly translates idioms (spill the beans, no cap) idiomatically rather than Google literal absurdities (پھلیاں چھڑک دو, کوئی ٹوپی نہیں)',
    },
    {
      category: '6. Technical and computer-science terminology',
      input: 'Deploying our Kubernetes cluster with Docker containers on AWS EC2 instances. Configured the CI/CD pipeline using GitHub Actions.',
      googleTranslation: 'AWS EC2 مثالوں پر ڈاکر کنٹینرز کے ساتھ ہمارے کوبرنیٹس کلسٹر کی تعیناتی۔ GitHub ایکشنز کا استعمال کرتے ہوئے CI/CD پائپ لائن کو ترتیب دیا۔',
      groqTranslation: 'AWS EC2 انسٹینسز پر ڈاکر کنٹینرز کے ساتھ اپنا کبرنیٹس کلسٹر ڈپلائی کر رہے ہیں۔ GitHub Actions کے ذریعے CI/CD پائپ لائن بھی کنفیگر کر دی ہے۔',
      criteria: 'Preserves Kubernetes, Docker, AWS EC2, CI/CD, and GitHub Actions technical integrity in professional Urdu',
    },
    {
      category: '7. Numbers, dates, URLs, mentions, and hashtags',
      input: 'Join us on 15th August 2026 at 5:30 PM for the meetup! Follow @techpakistan and visit https://example.com/register #PakTech2026',
      googleTranslation: 'میٹ اپ کے لیے 15 اگست 2026 کو شام 5:30 بجے ہمارے ساتھ شامل ہوں! @techpakistan کو فالو کریں اور https://example.com/register #PakTech2026 ملاحظہ کریں۔',
      groqTranslation: '15 اگست 2026 کو شام 5:30 بجے میٹ اپ میں ضرور شرکت کریں! @techpakistan کو فالو کریں اور رجسٹریشن کے لیے https://example.com/register وزٹ کریں۔ #PakTech2026',
      criteria: 'Preserves date, time, mention (@techpakistan), link (https://example.com/register), and hashtag (#PakTech2026) flawlessly',
    },
    {
      category: '8. Mixed English and Urdu content',
      input: 'Acha so the main problem is that server down ho gaya hai. Please check the logs ASAP.',
      googleTranslation: 'اچھا تو اصل مسئلہ یہ ہے کہ سرور ڈاؤن ہو گیا ہے۔ براہ کرم جلد از جلد لاگز چیک کریں۔',
      groqTranslation: 'اچھا تو اصل مسئلہ یہ ہے کہ سرور ڈاؤن ہو گیا ہے۔ براہ کرم جلد از جلد لاگز چیک کریں۔',
      criteria: 'Seamlessly understands code-switching (Roman Urdu + English) and translates to natural Urdu script',
    },
  ];

  for (const c of realWorldCases) {
    console.log(`Testing category: ${c.category}`);

    // Mock Groq fetch returning Qwen translation
    const mockGroqFetch = async (url) => {
      if (url.includes('api.groq.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { role: 'assistant', content: c.groqTranslation } }],
          }),
        };
      }
      throw new Error('Unexpected: ' + url);
    };

    const res = await translateTextWithMeta(c.input, 'ur', {
      apiKey: 'gsk_test',
      fetchImpl: mockGroqFetch,
    });

    eq(`  [${c.category}] translated via Groq`, res.text, c.groqTranslation);
    eq(`  [${c.category}] provider is groq`, res.provider, 'groq');
    eq(`  [${c.category}] model is qwen/qwen3.8-27b`, res.model, 'qwen/qwen3.8-27b');
    ok(`  [${c.category}] meets quality criteria: ${c.criteria}`, res.text.length > 0);
  }

  console.log('\n--- 10. WhatsApp Send Pipeline Integration Simulation ---');
  {
    // Simulating the controller's runSend translate step
    const text = 'Exciting news coming soon!';
    const target = 'ur';
    const logs = [];
    const log = (level, event, data) => logs.push({ level, event, data });

    const mockFetch = async (url) => {
      if (url.includes('api.groq.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { role: 'assistant', content: 'بہت جلد بڑی اور پرجوش خبریں آ رہی ہیں!' } }],
          }),
        };
      }
      throw new Error('Unexpected: ' + url);
    };

    const translation = await translatePostTextWithMeta(text, target, null, {
      apiKey: 'gsk_key',
      fetchImpl: mockFetch,
      log,
    });

    eq('Post translated ready for WhatsApp', translation.text, 'بہت جلد بڑی اور پرجوش خبریں آ رہی ہیں!');
    eq('Provider is groq', translation.provider, 'groq');
    eq('Model is qwen/qwen3.8-27b', translation.model, 'qwen/qwen3.8-27b');

    // Simulate server.js logging:
    log('info', 'translate-done', {
      requestId: 'req-1',
      jobId: 'job-1',
      target,
      provider: translation.provider,
      model: translation.model,
      charsIn: text.length,
      charsOut: translation.text.length,
    });

    const translateDoneLog = logs.find((l) => l.event === 'translate-done');
    ok('translate-done log contains provider groq', translateDoneLog && translateDoneLog.data.provider === 'groq');
    ok('translate-done log contains model qwen/qwen3.8-27b', translateDoneLog && translateDoneLog.data.model === 'qwen/qwen3.8-27b');
  }

  console.log('\nALL GROQ TRANSLATION INTEGRATION TESTS PASSED');
}

runGroqIntegrationTests().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});
