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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-theme-test-'));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (url.pathname === '/api/engines') return json([{
    id: 'edge', name: 'Edge', is_free: true, default_voice: 'ja-JP-NanamiNeural',
    max_text_length: 1000, min_text_length: 1, request_timeout_seconds: 30,
    voices: [{ id: 'ja-JP-NanamiNeural', name: 'Nanami' }],
  }]);
  if (url.pathname === '/api/history') return json([]);
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
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id) {
        const entry = pending.get(data.id);
        pending.delete(data.id);
        if (entry) data.error ? entry.reject(data.error) : entry.resolve(data.result);
      } else if (data.method === 'Runtime.exceptionThrown') {
        exceptions.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
      }
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
      throw new Error('UI did not reach expected state: ' + expression);
    };

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url });

    await wait('document.readyState === "complete"');
    await delay(300);

    // 1. Verify button was moved to sidebar and removed from copilot header
    const inSidebar = await evaluate('Boolean(document.querySelector("#historySection #settingsBtn"))');
    const inCopilot = await evaluate('Boolean(document.querySelector(".explain-header #settingsBtn"))');
    assert.equal(inSidebar, true, 'Settings button must be inside the history sidebar');
    assert.equal(inCopilot, false, 'Settings button must not be inside the copilot header');
    console.log('PASS settings button moved from copilot to sidebar');

    // 2. Verify initial theme is sakura
    const initialTheme = await evaluate('document.documentElement.getAttribute("data-theme")');
    assert.equal(initialTheme, 'sakura', 'Initial theme should default to sakura');
    const sakuraDecorVisible = await evaluate('getComputedStyle(document.getElementById("sakuraDecor")).display !== "none"');
    assert.equal(sakuraDecorVisible, true, 'Sakura decor should be visible in sakura theme');
    console.log('PASS initial theme defaults to sakura and displays atmosphere decor');

    // 3. Open settings modal from sidebar settings button
    await evaluate('document.getElementById("settingsBtn").click()');
    await wait('document.getElementById("settingsModal").style.display === "flex"');
    console.log('PASS clicking sidebar settings button opens settings modal');

    // 4. Verify multi-choice theme options exist in settings modal
    const themeButtons = await evaluate('Array.from(document.querySelectorAll("#themeOptionsGrid .theme-option-btn")).map(b => b.getAttribute("data-theme"))');
    assert.deepEqual(themeButtons.sort(), ['dark', 'default', 'sakura'].sort());
    console.log('PASS theme options (default, sakura, dark) exist in settings modal');

    // 5. Switch to default theme (Classic Blue)
    await evaluate('document.querySelector(\'.theme-option-btn[data-theme="default"]\').click()');
    assert.equal(await evaluate('document.documentElement.getAttribute("data-theme")'), 'default');
    assert.equal(await evaluate('localStorage.getItem("tts_theme")'), 'default');
    const defaultSakuraHidden = await evaluate('getComputedStyle(document.getElementById("sakuraDecor")).display === "none"');
    assert.equal(defaultSakuraHidden, true, 'Sakura decor should be hidden in default theme');
    console.log('PASS switching to default theme works and updates localStorage');

    // 6. Switch to dark theme
    await evaluate('document.querySelector(\'.theme-option-btn[data-theme="dark"]\').click()');
    assert.equal(await evaluate('document.documentElement.getAttribute("data-theme")'), 'dark');
    assert.equal(await evaluate('localStorage.getItem("tts_theme")'), 'dark');
    console.log('PASS switching to dark theme works and updates localStorage');

    // 7. Switch back to sakura theme
    await evaluate('document.querySelector(\'.theme-option-btn[data-theme="sakura"]\').click()');
    assert.equal(await evaluate('document.documentElement.getAttribute("data-theme")'), 'sakura');
    assert.equal(await evaluate('localStorage.getItem("tts_theme")'), 'sakura');
    assert.equal(await evaluate('getComputedStyle(document.getElementById("sakuraDecor")).display !== "none"'), true);
    console.log('PASS switching back to sakura theme works');

    // 8. Close settings modal
    await evaluate('document.getElementById("modalCloseBtn").click()');
    await wait('document.getElementById("settingsModal").style.display === "none"');
    console.log('PASS closing settings modal works');

    // 9. Test New Reading button and Clear text button
    await evaluate('document.getElementById("textInput").value = "Testing new reading reset"');
    await evaluate('document.getElementById("clearTextBtn").click()');
    assert.equal(await evaluate('document.getElementById("textInput").value'), '');
    await evaluate('document.getElementById("textInput").value = "Testing sidebar new reading"');
    await evaluate('document.getElementById("newReadingBtn").click()');
    assert.equal(await evaluate('document.getElementById("textInput").value'), '');
    console.log('PASS clear button and sidebar new reading button reset input');

    // 10. Verify cute cat illustration in sidebar & reading banner in center
    assert.equal(await evaluate('Boolean(document.querySelector(".sidebar-cat-card"))'), true);
    assert.equal(await evaluate('Boolean(document.querySelector(".work-reading-banner"))'), true);
    assert.equal(await evaluate('Boolean(document.querySelector(".explain-empty-card"))'), true);
    console.log('PASS cute cat card, reading banner, and copilot empty card exist');

    // 11. Verify mobile viewport has no horizontal overflow
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), true);
    console.log('PASS mobile responsive layout has no horizontal overflow');

    assert.deepEqual(exceptions, []);
    console.log('PASS all theme and sidebar tests passed with 0 exceptions');
    await send('Browser.close');
    await browserExit;
  } finally {
    socket?.close();
    if (browser && browser.exitCode === null) {
      browser.kill();
      await Promise.race([browserExit, delay(3000)]);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
