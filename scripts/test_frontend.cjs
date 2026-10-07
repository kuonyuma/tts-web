// Run with Node 22+ and Chrome/Chromium (CHROME_PATH can select the executable).
// This serves only fixture API responses and uses a disposable browser profile.
const assert = require('node:assert/strict');
const http = require('node:http');
const { serveFrontend } = require('./frontend_test_server.cjs');
const { launchBrowser, delay } = require('./browser_test_helper.cjs');

const key = '0123456789abcdef'.repeat(4);
const attack = 'test" onmouseover="document.documentElement.dataset.auditXss=\'executed\'';
let mode = 'success';
let generations = 0;
let audioUnavailable = false;
const wav = Buffer.alloc(44 + 4800);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4800, 40);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (url.pathname === '/api/engines') return json([{
    id: 'edge', name: 'Edge', is_free: true, default_voice: 'ja-JP-NanamiNeural',
    max_text_length: 12, min_text_length: 1, request_timeout_seconds: 30,
    storage_mode: 'private',
    voices: [{ id: 'ja-JP-NanamiNeural', name: 'Nanami' }],
  }]);
  if (url.pathname === '/api/history') return json([{
    id: 1, text: audioUnavailable ? 'Hello.' : attack, voice: 'ja-JP-NanamiNeural', engine: 'edge', cache_key: key,
    audio_status: audioUnavailable ? 'unavailable' : 'ready',
    created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    last_played_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  }]);
  if (url.pathname === '/api/tts' && req.method === 'POST') {
    generations += 1;
    if (mode === 'stall') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{'); return;
    }
    if (mode === 'error') return json({ detail: '上游服务暂时不可用（上游返回 429）。' }, 502);
    audioUnavailable = false;
    await new Promise((resolve) => setTimeout(resolve, 30));
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Cache-Key': key });
    return res.end(wav);
  }
  if (url.pathname === '/api/tts/' + key) {
    if (audioUnavailable) return json({ detail: '原音频不可用' }, 410);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); return res.end(wav);
  }
  serveFrontend(res, url.pathname);
});

let browser;
(async () => {
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const consoleErrors = [];
    browser = await launchBrowser({
      profilePrefix: 'tts-release-browser-', args: ['--autoplay-policy=no-user-gesture-required'],
      exceptionDescriptions: true, exceptionDetailsAsJson: true,
      onEvent: data => {
        if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') consoleErrors.push(data.params.args.map(a => a.description || a.value));
      },
    });
    const { send, evaluate, exceptions } = browser;
    const wait = async (expression) => {
      for (let i = 0; i < 160; i++) {
        if (await evaluate(expression)) return;
        await delay(50);
      }
      throw new Error('UI did not reach expected state: ' + expression + '\n' + JSON.stringify({
        exceptions, consoleErrors, state: await evaluate('({ready: document.readyState, counter: document.getElementById("charCounter")?.textContent, history: document.getElementById("historyList")?.innerHTML, scripts: Array.from(document.scripts).map(s => s.src)})'),
      }));
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      localStorage.setItem('tts_explain_enabled', '0');
      const originalSetTimeout = window.setTimeout;
      window.setTimeout = (callback, ms, ...args) => originalSetTimeout(callback, ms >= 10000 ? 1500 : ms, ...args);
    ` });
    await send('Page.navigate', { url });
    await wait("document.body?.dataset.ready==='true'");
    assert.equal(await evaluate("document.querySelector('.user-message').textContent"), attack);
    assert.equal(await evaluate("document.querySelector('.user-message').hasAttribute('onmouseover')"), false);
    await evaluate("document.querySelector('.user-message').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");
    assert.equal(await evaluate("document.documentElement.dataset.auditXss || ''"), '');
    console.log('PASS stored XSS stays literal text');
    await evaluate("window.submit=text=>{const input=document.getElementById('textInput');input.value=text;input.dispatchEvent(new Event('input'));document.getElementById('generateBtn').click();};document.getElementById('newConversationBtn').click();submit('Hello.');document.getElementById('generateBtn').click();");
    await wait("document.querySelector('audio')?.readyState>=2");
    assert.equal(generations,1);
    assert.equal(await evaluate("document.querySelector('audio').duration"),0.1);
    await evaluate("document.querySelector('audio').currentTime=0.05");
    assert(Math.abs(await evaluate("document.querySelector('audio').currentTime")-0.05)<0.005);
    console.log('PASS actual HTTP generation, audio duration/seek, empty double-click protection');
    mode='error';
    await evaluate("submit('Failure')");
    await wait("document.querySelector('.audio-status.is-error')?.textContent.includes('429')");
    mode='stall';
    await evaluate("submit('Timeout')");
    await wait("[...document.querySelectorAll('.audio-status.is-error')].some(el=>el.textContent.includes('超时'))");
    assert.equal(await evaluate("document.querySelectorAll('.user-message').length"),3);
    console.log('PASS provider error and stalled response body remain retryable without losing text');
    const before=generations;
    await evaluate("submit('x'.repeat(13))");
    assert.equal(await evaluate("document.getElementById('generateBtn').disabled"),true);
    assert.equal(generations,before);
    await evaluate("submit('😀'.repeat(12))");
    await wait("document.querySelectorAll('.user-message').length===4");
    console.log('PASS configured limits count Unicode code points');
    mode='success'; audioUnavailable=true;
    await evaluate("document.body.dataset.ready='reloading'");
    await send('Page.reload'); await wait("document.body?.dataset.ready==='true'");
    await evaluate("document.querySelector('.audio-action:not([hidden])').click()");
    await wait("document.querySelector('.retry-audio')?.textContent.includes('重新生成')");
    await evaluate("document.querySelector('.retry-audio').click()");
    await wait("document.querySelector('audio')?.readyState>=2");
    assert.equal(await evaluate("document.querySelectorAll('.user-message').length"),4);
    console.log('PASS 410 replay regenerates into original card');
    assert.deepEqual(exceptions,[]);
    console.log('PASS no uncaught browser exceptions');
  } finally {
    try {
      await browser?.close();
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
