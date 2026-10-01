// Run with Node 22+ and Chrome/Chromium (CHROME_PATH can select the executable).
// This serves only fixture API responses and uses a disposable browser profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const chromePath = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((candidate) => fs.existsSync(candidate));
assert(chromePath, 'Chrome/Chromium is required; set CHROME_PATH');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-release-browser-'));
const key = '0123456789abcdef'.repeat(4);
const attack = 'test" onmouseover="document.documentElement.dataset.auditXss=\'executed\'';
let mode = 'success';
let generations = 0;
let historyDeleted = false;
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
  if (url.pathname === '/api/history') return json(historyDeleted ? [] : [{
    id: 1, text: audioUnavailable ? 'Hello.' : attack, voice: 'ja-JP-NanamiNeural', engine: 'edge', cache_key: key,
    audio_status: audioUnavailable ? 'unavailable' : 'ready',
    created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    last_played_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  }]);
  if (url.pathname === '/api/history/1' && req.method === 'DELETE') {
    historyDeleted = true;
    res.writeHead(204); return res.end();
  }
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
  const relativePath = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  const filePath = path.join(root, 'frontend', relativePath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const contentType = ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : ext === '.html' ? 'text/html' : 'text/plain';
    res.writeHead(200, { 'Content-Type': contentType });
    return res.end(fs.readFileSync(filePath));
  }
  res.writeHead(404); res.end();
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
let socket;
let browserExit;
(async () => {
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    browser = spawn(chromePath, [
      '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required', 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });
    browserExit = new Promise((resolve) => browser.once('exit', resolve));
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await delay(50);
    assert(fs.existsSync(portFile), 'Browser debugging endpoint did not start');
    const port = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
    const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const pending = new Map();
    const exceptions = [];
    const consoleErrors = [];
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id) {
        const entry = pending.get(data.id);
        pending.delete(data.id);
        if (entry) data.error ? entry.reject(data.error) : entry.resolve(data.result);
      } else if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
      else if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') consoleErrors.push(data.params.args.map(a => a.description || a.value));
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const callId = ++id;
      pending.set(callId, { resolve, reject });
      socket.send(JSON.stringify({ id: callId, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
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
    await send('Page.reload'); await wait("document.body?.dataset.ready==='true'");
    await evaluate("document.querySelector('.audio-action:not([hidden])').click()");
    await wait("document.querySelector('.retry-audio')?.textContent.includes('重新生成')");
    await evaluate("document.querySelector('.retry-audio').click()");
    await wait("document.querySelector('audio')?.readyState>=2");
    assert.equal(await evaluate("document.querySelectorAll('.user-message').length"),4);
    console.log('PASS 410 replay regenerates into original card');
    assert.deepEqual(exceptions,[]);
    await send('Browser.close');
    await browserExit;
    console.log('PASS no uncaught browser exceptions');
  } finally {
    socket?.close();
    if (browser && browser.exitCode === null) {
      browser.kill();
      await Promise.race([browserExit, delay(3000)]);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    // This path is the fresh, task-owned mkdtemp directory above.
    assert(path.resolve(profile).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert(path.basename(profile).startsWith('tts-release-browser-'));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
