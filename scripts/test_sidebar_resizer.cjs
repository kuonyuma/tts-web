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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-resizer-test-'));

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
  if (url.pathname === '/api/copilot/models') return json({ models: [] });
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
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id) {
        const entry = pending.get(data.id);
        pending.delete(data.id);
        if (entry) {
          if (data.error) entry.reject(data.error);
          else entry.resolve(data.result);
        }
      }
      if (data.method === 'Runtime.exceptionThrown') {
        exceptions.push(data.params.exceptionDetails);
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
    await wait("document.body?.dataset.ready==='true'");
    await delay(300);

    // 1. Verify resizer elements exist and have ARIA separator roles
    const leftResizerExists = await evaluate("!!document.getElementById('leftResizer')");
    const rightResizerExists = await evaluate("!!document.getElementById('rightResizer')");
    assert.equal(leftResizerExists, true, 'Left resizer handle must exist');
    assert.equal(rightResizerExists, true, 'Right resizer handle must exist');

    const leftRole = await evaluate("document.getElementById('leftResizer').getAttribute('role')");
    const rightRole = await evaluate("document.getElementById('rightResizer').getAttribute('role')");
    assert.equal(leftRole, 'separator');
    assert.equal(rightRole, 'separator');

    console.log('PASS resizers rendered with ARIA separator semantics');

    // 2. Measure default widths
    const initialLeftWidth = await evaluate("document.getElementById('conversationSidebar').getBoundingClientRect().width");
    const initialRightWidth = await evaluate("document.getElementById('explainSection').getBoundingClientRect().width");
    const initialMainWidth = await evaluate("document.getElementById('chatMain').getBoundingClientRect().width");
    assert.equal(Math.round(initialLeftWidth), 250);
    assert.equal(Math.round(initialRightWidth), 345);

    // 3. Test dragging left resizer to increase width
    await evaluate(`(() => {
      const resizer = document.getElementById('leftResizer');
      const box = resizer.getBoundingClientRect();
      const clientX = box.left + box.width / 2;
      const clientY = box.top + box.height / 2;
      resizer.dispatchEvent(new PointerEvent('pointerdown', { clientX, clientY, button: 0, bubbles: true }));
      // Drag right by 70px
      resizer.dispatchEvent(new PointerEvent('pointermove', { clientX: clientX + 70, clientY, bubbles: true }));
      resizer.dispatchEvent(new PointerEvent('pointerup', { clientX: clientX + 70, clientY, bubbles: true }));
    })()`);

    const expandedLeftWidth = await evaluate("document.getElementById('conversationSidebar').getBoundingClientRect().width");
    const shrunkMainWidth = await evaluate("document.getElementById('chatMain').getBoundingClientRect().width");
    assert.equal(Math.round(expandedLeftWidth), 320, 'Left sidebar expanded to 320px');
    assert(shrunkMainWidth < initialMainWidth, 'Main chat area shrunk dynamically');
    console.log('PASS dragging left resizer expands left sidebar and adjusts main area');

    // 4. Test dragging left resizer past bounds (test min and max boundaries)
    // Drag way right (try to exceed MAX_LEFT_WIDTH = 480)
    await evaluate(`(() => {
      const resizer = document.getElementById('leftResizer');
      const box = resizer.getBoundingClientRect();
      const clientX = box.left + box.width / 2;
      resizer.dispatchEvent(new PointerEvent('pointerdown', { clientX, clientY: 200, button: 0, bubbles: true }));
      resizer.dispatchEvent(new PointerEvent('pointermove', { clientX: clientX + 600, clientY: 200, bubbles: true }));
      resizer.dispatchEvent(new PointerEvent('pointerup', { clientX: clientX + 600, clientY: 200, bubbles: true }));
    })()`);
    const maxClampedLeftWidth = await evaluate("document.getElementById('conversationSidebar').getBoundingClientRect().width");
    assert(Math.round(maxClampedLeftWidth) <= 480, `Left width ${maxClampedLeftWidth} clamped to max 480px`);

    // Drag way left (try to go below MIN_LEFT_WIDTH = 180)
    await evaluate(`(() => {
      const resizer = document.getElementById('leftResizer');
      const box = resizer.getBoundingClientRect();
      const clientX = box.left + box.width / 2;
      resizer.dispatchEvent(new PointerEvent('pointerdown', { clientX, clientY: 200, button: 0, bubbles: true }));
      resizer.dispatchEvent(new PointerEvent('pointermove', { clientX: clientX - 800, clientY: 200, bubbles: true }));
      resizer.dispatchEvent(new PointerEvent('pointerup', { clientX: clientX - 800, clientY: 200, bubbles: true }));
    })()`);
    const minClampedLeftWidth = await evaluate("document.getElementById('conversationSidebar').getBoundingClientRect().width");
    assert.equal(Math.round(minClampedLeftWidth), 180, 'Left width clamped to min 180px');
    console.log('PASS left sidebar min/max boundaries strictly enforced');

    // 5. Test double click to reset left width to default (250px)
    await evaluate(`document.getElementById('leftResizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    const resetLeftWidth = await evaluate("document.getElementById('conversationSidebar').getBoundingClientRect().width");
    assert.equal(Math.round(resetLeftWidth), 250, 'Double-click reset left sidebar to 250px');
    console.log('PASS double-click resets left sidebar to default width');

    // 6. Test dragging right resizer to expand right sidebar
    await evaluate(`(() => {
      const resizer = document.getElementById('rightResizer');
      const box = resizer.getBoundingClientRect();
      const clientX = box.left + box.width / 2;
      const clientY = box.top + box.height / 2;
      resizer.dispatchEvent(new PointerEvent('pointerdown', { clientX, clientY, button: 0, bubbles: true }));
      // Drag left by 80px to expand right sidebar
      resizer.dispatchEvent(new PointerEvent('pointermove', { clientX: clientX - 80, clientY, bubbles: true }));
      resizer.dispatchEvent(new PointerEvent('pointerup', { clientX: clientX - 80, clientY, bubbles: true }));
    })()`);
    const expandedRightWidth = await evaluate("document.getElementById('explainSection').getBoundingClientRect().width");
    assert.equal(Math.round(expandedRightWidth), 425, 'Right sidebar expanded to 425px');
    console.log('PASS dragging right resizer expands right sidebar');

    // 7. Test right sidebar min boundary (MIN_RIGHT_WIDTH = 260)
    await evaluate(`(() => {
      const resizer = document.getElementById('rightResizer');
      const box = resizer.getBoundingClientRect();
      const clientX = box.left + box.width / 2;
      resizer.dispatchEvent(new PointerEvent('pointerdown', { clientX, clientY: 200, button: 0, bubbles: true }));
      // Drag way right to shrink
      resizer.dispatchEvent(new PointerEvent('pointermove', { clientX: clientX + 500, clientY: 200, bubbles: true }));
      resizer.dispatchEvent(new PointerEvent('pointerup', { clientX: clientX + 500, clientY: 200, bubbles: true }));
    })()`);
    const minClampedRightWidth = await evaluate("document.getElementById('explainSection').getBoundingClientRect().width");
    assert.equal(Math.round(minClampedRightWidth), 260, 'Right width clamped to min 260px');

    // Double-click reset right sidebar
    await evaluate(`document.getElementById('rightResizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    const resetRightWidth = await evaluate("document.getElementById('explainSection').getBoundingClientRect().width");
    assert.equal(Math.round(resetRightWidth), 345, 'Double-click reset right sidebar to 345px');
    console.log('PASS right sidebar min/max boundaries and double-click reset');

    // 8. Keyboard navigation
    await evaluate(`(() => {
      const resizer = document.getElementById('leftResizer');
      resizer.focus();
      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    })()`);
    const kbLeftWidth = await evaluate("document.getElementById('conversationSidebar').getBoundingClientRect().width");
    assert.equal(Math.round(kbLeftWidth), 270, 'ArrowRight increased left width by 20px');

    await evaluate(`(() => {
      const resizer = document.getElementById('leftResizer');
      resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    const kbResetLeftWidth = await evaluate("document.getElementById('conversationSidebar').getBoundingClientRect().width");
    assert.equal(Math.round(kbResetLeftWidth), 250, 'Enter reset left width');
    console.log('PASS keyboard navigation and accessibility on resizers');

    // 9. Persistence across page reload
    // Set custom widths: left = 300, right = 400
    await evaluate(`(() => {
      const resizerL = document.getElementById('leftResizer');
      const boxL = resizerL.getBoundingClientRect();
      const xL = boxL.left + boxL.width / 2;
      resizerL.dispatchEvent(new PointerEvent('pointerdown', { clientX: xL, clientY: 200, button: 0, bubbles: true }));
      resizerL.dispatchEvent(new PointerEvent('pointermove', { clientX: xL + 50, clientY: 200, bubbles: true }));
      resizerL.dispatchEvent(new PointerEvent('pointerup', { clientX: xL + 50, clientY: 200, bubbles: true }));

      const resizerR = document.getElementById('rightResizer');
      const boxR = resizerR.getBoundingClientRect();
      const xR = boxR.left + boxR.width / 2;
      resizerR.dispatchEvent(new PointerEvent('pointerdown', { clientX: xR, clientY: 200, button: 0, bubbles: true }));
      resizerR.dispatchEvent(new PointerEvent('pointermove', { clientX: xR - 55, clientY: 200, bubbles: true }));
      resizerR.dispatchEvent(new PointerEvent('pointerup', { clientX: xR - 55, clientY: 200, bubbles: true }));
    })()`);

    assert.equal(await evaluate("localStorage.getItem('tts_sidebar_left_width')"), '300');
    assert.equal(await evaluate("localStorage.getItem('tts_sidebar_right_width')"), '400');

    // Reload page and check restored widths
    await send('Page.reload');
    await wait('document.readyState === "complete"');
    await wait("document.body?.dataset.ready==='true'");
    await delay(300);

    const reloadedLeftWidth = await evaluate("document.getElementById('conversationSidebar').getBoundingClientRect().width");
    const reloadedRightWidth = await evaluate("document.getElementById('explainSection').getBoundingClientRect().width");
    assert.equal(Math.round(reloadedLeftWidth), 300, 'Restored left width 300px');
    assert.equal(Math.round(reloadedRightWidth), 400, 'Restored right width 400px');
    console.log('PASS custom sidebar widths survive page reload');

    // 10. Mobile drawer hides resizers
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await delay(100);
    const mobileLeftResizerDisplay = await evaluate("getComputedStyle(document.getElementById('leftResizer')).display");
    const mobileRightResizerDisplay = await evaluate("getComputedStyle(document.getElementById('rightResizer')).display");
    assert.equal(mobileLeftResizerDisplay, 'none', 'Left resizer hidden on mobile');
    assert.equal(mobileRightResizerDisplay, 'none', 'Right resizer hidden on mobile');
    console.log('PASS mobile drawer hides resizers cleanly');

    assert.deepEqual(exceptions, []);
    console.log('ALL SIDEBAR RESIZER TESTS PASSED SUCCESSFULLY!');
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
