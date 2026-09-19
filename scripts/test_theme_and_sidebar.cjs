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
let explainRequestCount = 0;

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
  if (url.pathname === '/api/copilot/models') return json({ models: [{
    id: 'deepseek-flash', name: 'DeepSeek Flash', default: true,
    modes: [
      { id: 'direct', name: '直接回答', description: '速度优先', quota_weight: 1 },
      { id: 'deep', name: '深度思考', description: '复杂长句', quota_weight: 5 },
    ],
  }] });
  if (url.pathname === '/api/tts/flow' && req.method === 'POST') return json({
    cache_key: 'test-audio', engine: 'edge', voice: 'ja-JP-NanamiNeural',
    timeline_available: false, sentences: [], audio_url: '/api/audio/test-audio',
  });
  if (url.pathname === '/api/audio/test-audio') {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    return res.end(Buffer.from([0x49, 0x44, 0x33]));
  }
  if (url.pathname === '/api/explain') {
    explainRequestCount += 1;
    return json({ detail: 'Gemini 服务需要 API Key。' }, 400);
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
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });

    await wait('document.readyState === "complete"');
    await delay(300);

    // 1. Verify settings is available only from the sidebar
    const inSidebar = await evaluate('Boolean(document.querySelector("#historySection #settingsBtn"))');
    const inCopilot = await evaluate('Boolean(document.querySelector(".explain-header .copilot-settings-btn"))');
    assert.equal(inSidebar, true, 'Settings button must be inside the history sidebar');
    assert.equal(inCopilot, false, 'Copilot header must not contain a settings button');
    console.log('PASS settings button moved from copilot to sidebar');

    const copilotControls = await evaluate('({ model: document.getElementById("explainModelSelect").value, modes: Array.from(document.getElementById("explainThinkingSelect").options).map(o => o.value) })');
    assert.equal(copilotControls.model, 'deepseek-flash');
    assert.deepEqual(copilotControls.modes, ['direct', 'deep']);
    console.log('PASS Copilot model catalog drives model-specific reasoning modes');

    // 2. Verify history remains collapsed until the user opens it
    assert.equal(await evaluate('document.getElementById("historySection").classList.contains("open")'), false);
    console.log('PASS history sidebar defaults to collapsed');

    // 3. Verify the workspace splitter resizes and persists the two panes
    const initialSplit = await evaluate('Number(document.getElementById("workspaceSplitter").getAttribute("aria-valuenow"))');
    const splitterBounds = await evaluate('(() => { const r = document.getElementById("workspaceSplitter").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: splitterBounds.x, y: splitterBounds.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: splitterBounds.x + 90, y: splitterBounds.y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: splitterBounds.x + 90, y: splitterBounds.y, button: 'left', clickCount: 1 });
    const resizedSplit = await evaluate('Number(document.getElementById("workspaceSplitter").getAttribute("aria-valuenow"))');
    assert(resizedSplit > initialSplit, 'Dragging right should increase the left pane width');
    assert.equal(await evaluate('Boolean(localStorage.getItem("tts_workspace_split_ratio"))'), true);
    console.log('PASS workspace splitter resizes and persists pane widths');

    // 4. Enabling AI explanation must not request AI or open settings
    await evaluate('document.getElementById("explainToggle").click()');
    await evaluate('document.getElementById("textInput").value = "Text waiting for optional AI explanation"');
    await evaluate('document.getElementById("generateBtn").click()');
    await wait('document.getElementById("generateBtn").disabled === false');
    assert.equal(await evaluate('document.getElementById("settingsModal").style.display'), 'none');
    assert.equal(explainRequestCount, 0);
    await evaluate('document.getElementById("explainToggle").click()');
    await delay(100);
    assert.equal(await evaluate('document.getElementById("settingsModal").style.display'), 'none');
    assert.equal(explainRequestCount, 0);
    console.log('PASS enabling AI explanation does not request AI or open settings');

    // 5. Verify initial theme is sakura
    const initialTheme = await evaluate('document.documentElement.getAttribute("data-theme")');
    assert.equal(initialTheme, 'sakura', 'Initial theme should default to sakura');
    const sakuraDecorVisible = await evaluate('getComputedStyle(document.getElementById("sakuraDecor")).display !== "none"');
    assert.equal(sakuraDecorVisible, true, 'Sakura decor should be visible in sakura theme');
    console.log('PASS initial theme defaults to sakura and displays atmosphere decor');

    // 6. Open settings modal from sidebar settings button
    await evaluate('document.getElementById("settingsBtn").click()');
    await wait('document.getElementById("settingsModal").style.display === "flex"');
    console.log('PASS clicking sidebar settings button opens settings modal');

    // 7. Verify multi-choice theme options exist in settings modal
    const themeButtons = await evaluate('Array.from(document.querySelectorAll("#themeOptionsGrid .theme-option-btn")).map(b => b.getAttribute("data-theme"))');
    assert.deepEqual(themeButtons.sort(), ['dark', 'default', 'sakura'].sort());
    console.log('PASS theme options (default, sakura, dark) exist in settings modal');

    // 8. Switch to default theme (Classic Blue)
    await evaluate('document.querySelector(\'.theme-option-btn[data-theme="default"]\').click()');
    assert.equal(await evaluate('document.documentElement.getAttribute("data-theme")'), 'default');
    assert.equal(await evaluate('localStorage.getItem("tts_theme")'), 'default');
    const defaultSakuraHidden = await evaluate('getComputedStyle(document.getElementById("sakuraDecor")).display === "none"');
    assert.equal(defaultSakuraHidden, true, 'Sakura decor should be hidden in default theme');
    console.log('PASS switching to default theme works and updates localStorage');

    // 9. Switch to dark theme
    await evaluate('document.querySelector(\'.theme-option-btn[data-theme="dark"]\').click()');
    assert.equal(await evaluate('document.documentElement.getAttribute("data-theme")'), 'dark');
    assert.equal(await evaluate('localStorage.getItem("tts_theme")'), 'dark');
    console.log('PASS switching to dark theme works and updates localStorage');

    // 10. Switch back to sakura theme
    await evaluate('document.querySelector(\'.theme-option-btn[data-theme="sakura"]\').click()');
    assert.equal(await evaluate('document.documentElement.getAttribute("data-theme")'), 'sakura');
    assert.equal(await evaluate('localStorage.getItem("tts_theme")'), 'sakura');
    assert.equal(await evaluate('getComputedStyle(document.getElementById("sakuraDecor")).display !== "none"'), true);
    console.log('PASS switching back to sakura theme works');

    // 11. Close settings modal
    await evaluate('document.getElementById("modalCloseBtn").click()');
    await wait('document.getElementById("settingsModal").style.display === "none"');
    console.log('PASS closing settings modal works');

    // 12. Verify New Reading is absent and Clear text still works
    assert.equal(await evaluate('Boolean(document.getElementById("newReadingBtn"))'), false);
    await evaluate('document.getElementById("textInput").value = "Testing clear reset"');
    await evaluate('document.getElementById("clearTextBtn").click()');
    assert.equal(await evaluate('document.getElementById("textInput").value'), '');
    console.log('PASS New Reading is absent and Clear text resets input');

    // 13. Verify cute cat illustration in sidebar & reading banner in center
    assert.equal(await evaluate('Boolean(document.querySelector(".sidebar-cat-card"))'), true);
    assert.equal(await evaluate('Boolean(document.querySelector(".work-reading-banner"))'), true);
    assert.equal(await evaluate('Boolean(document.querySelector(".explain-empty-card"))'), true);
    assert.equal(await evaluate('Boolean(document.querySelector(".explain-sync-strip"))'), false);
    console.log('PASS decorative cards remain and explain sync strip is absent');

    // 14. Verify mobile viewport has no splitter or horizontal overflow
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('getComputedStyle(document.getElementById("workspaceSplitter")).display'), 'none');
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
