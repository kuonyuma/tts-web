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
const key = '0123456789abcdef';
const attack = 'test" onmouseover="document.documentElement.dataset.auditXss=\'executed\'';
let mode = 'success';
let generations = 0;
let historyDeleted = false;
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
    voices: [{ id: 'ja-JP-NanamiNeural', name: 'Nanami' }],
  }]);
  if (url.pathname === '/api/history') return json(historyDeleted ? [] : [{
    id: 1, text: attack, voice: 'ja-JP-NanamiNeural', engine: 'edge', cache_key: key,
    created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    last_played_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  }]);
  if (url.pathname === '/api/history/1' && req.method === 'DELETE') {
    historyDeleted = true;
    res.writeHead(204); return res.end();
  }
  if (url.pathname === '/api/tts/flow' && req.method === 'POST') {
    generations += 1;
    if (mode === 'stall') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{'); return;
    }
    if (mode === 'error') return json({ detail: '上游服务暂时不可用（上游返回 429）。' }, 502);
    await new Promise((resolve) => setTimeout(resolve, 30));
    return json({
      version: 1, engine: 'edge', voice: 'ja-JP-NanamiNeural', cache_key: key,
      audio_url: '/api/tts/' + key, cached: false, timeline_available: true,
      sentences: [{ index: 0, text: 'Hello.', start_ms: 0, end_ms: 100 }],
    });
  }
  if (url.pathname === '/api/tts/' + key) {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); return res.end(wav);
  }
  const file = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' }[url.pathname];
  if (file) {
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
    return res.end(fs.readFileSync(path.join(root, 'frontend', file)));
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
      window.setTimeout = (callback, ms, ...args) => originalSetTimeout(callback, ms >= 10000 ? 300 : ms, ...args);
    ` });
    await send('Page.navigate', { url });
    await wait('document.querySelector(".history-text") && document.getElementById("charCounter").textContent.includes("12")');
    assert.equal(await evaluate('document.querySelector(".history-text").getAttribute("title")'), attack);
    assert.equal(await evaluate('document.querySelector(".history-text").hasAttribute("onmouseover")'), false);
    await evaluate('document.querySelector(".history-text").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))');
    assert.equal(await evaluate('document.documentElement.dataset.auditXss || ""'), '');
    console.log('PASS stored XSS remains literal text and cannot create event handlers');

    await evaluate(`document.getElementById('textInput').value = 'Hello.'; document.getElementById('generateBtn').click(); document.getElementById('generateBtn').click();`);
    await wait('!document.getElementById("generateBtn").disabled && document.getElementById("audioPlayer").readyState >= 2');
    assert.equal(generations, 1);
    assert.equal(await evaluate('document.querySelectorAll(".sentence-row").length > 0'), true);
    console.log('PASS synthesis, audio decoding, timeline and double-click protection');

    mode = 'error';
    await evaluate('document.getElementById("generateBtn").click()');
    await wait('!document.getElementById("generateBtn").disabled && document.getElementById("errorMessage").textContent.includes("429")');
    console.log('PASS upstream error visible and generate button recovers');
    mode = 'stall';
    await evaluate('document.getElementById("generateBtn").click()');
    await wait('!document.getElementById("generateBtn").disabled && document.getElementById("errorMessage").textContent.includes("超时")');
    console.log('PASS stalled response body times out and loading clears');

    const before = generations;
    await evaluate(`document.getElementById('textInput').value = 'x'.repeat(13); document.getElementById('generateBtn').click();`);
    assert.equal(generations, before);
    assert.equal(await evaluate('document.getElementById("errorMessage").textContent.includes("12")'), true);
    console.log('PASS configured character limit is enforced by the browser');

    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), true);
    await evaluate('document.getElementById("historyBtn").click()');
    await evaluate('document.querySelector(".history-delete-btn").click()');
    await wait('document.getElementById("historyEmpty").style.display === "block"');
    console.log('PASS mobile viewport and history deletion (204 response)');
    assert.deepEqual(exceptions, []);
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
