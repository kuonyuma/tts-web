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
].find(candidate => fs.existsSync(candidate));
assert(chromePath, 'Chrome/Chromium is required; set CHROME_PATH');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-popover-test-'));

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
  if (url.pathname === '/api/copilot/models') return json({
    models: [
      {
        id: 'deepseek-flash',
        name: 'DeepSeek Flash',
        default: true,
        modes: [
          { id: 'direct', name: '直接回答', description: '速度优先', quota_weight: 1 },
          { id: 'deep', name: '深度思考', description: '复杂长句', quota_weight: 5 },
        ],
      },
      {
        id: 'gemini-flash',
        name: 'Gemini 2.5 Flash',
        default: false,
        modes: [
          { id: 'direct', name: '快速回答', description: '默认速度', quota_weight: 1 },
        ],
      },
    ],
  });
  if (url.pathname === '/api/tts' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Cache-Key': 'test' });
    return res.end(Buffer.alloc(100));
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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
let socket;

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    browser = spawn(chromePath, [
      '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required', 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });

    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await delay(50);
    assert(fs.existsSync(portFile), 'Browser debugging endpoint did not start');
    const port = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
    const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

    let id = 0;
    const pending = new Map();
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id) {
        const entry = pending.get(data.id);
        pending.delete(data.id);
        if (entry) data.error ? entry.reject(data.error) : entry.resolve(data.result);
      }
    };

    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const callId = ++id;
      pending.set(callId, { resolve, reject });
      socket.send(JSON.stringify({ id: callId, method, params }));
    });

    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      }
      return result.result.value;
    };

    const wait = async (expression, timeout = 5000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (await evaluate(expression)) return;
        await delay(50);
      }
      throw new Error('Timeout waiting for: ' + expression);
    };

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Page.navigate', { url });
    await wait("document.body?.dataset.ready === 'true'");

    // 展开 AI 辅助面板（如果当前收起）
    const isAiSidebarHidden = await evaluate("document.getElementById('explainSection').hasAttribute('hidden')");
    if (isAiSidebarHidden) {
      await evaluate("document.getElementById('aiPanelBtn').click()");
      await wait("!document.getElementById('explainSection').hasAttribute('hidden')");
      await delay(300);
    }

    // 1. 验证加号按钮存在且位于聊天输入框左侧
    const plusBtnExists = await evaluate("!!document.getElementById('explainOptionsToggleBtn')");
    assert.equal(plusBtnExists, true, '加号按钮必须存在');

    // 2. 验证默认状态下设置弹层为 hidden
    const isHiddenDefault = await evaluate("document.getElementById('explainOptionsPopover').hasAttribute('hidden')");
    assert.equal(isHiddenDefault, true, '默认情况下设置弹层应该是隐藏的');

    const ariaExpandedDefault = await evaluate("document.getElementById('explainOptionsToggleBtn').getAttribute('aria-expanded')");
    assert.equal(ariaExpandedDefault, 'false', '加号按钮默认 aria-expanded 必须是 false');

    // 3. 点击加号按钮，弹层弹出展示
    await evaluate("document.getElementById('explainOptionsToggleBtn').click()");
    await delay(300);

    const isHiddenAfterClick = await evaluate("document.getElementById('explainOptionsPopover').hasAttribute('hidden')");
    assert.equal(isHiddenAfterClick, false, '点击加号后设置弹层应该显示');

    const ariaExpandedAfterClick = await evaluate("document.getElementById('explainOptionsToggleBtn').getAttribute('aria-expanded')");
    assert.equal(ariaExpandedAfterClick, 'true', '点击加号后 aria-expanded 必须是 true');

    const hasActiveClass = await evaluate("document.getElementById('explainOptionsToggleBtn').classList.contains('active')");
    assert.equal(hasActiveClass, true, '点击加号后加号按钮应具有 active 类');

    // 4. 验证弹层内包含了四个核心控件
    const hasToggle = await evaluate("!!document.getElementById('explainToggle')");
    const hasLang = await evaluate("!!document.getElementById('explainLangSelect')");
    const hasModel = await evaluate("!!document.getElementById('explainModelSelect')");
    const hasThinking = await evaluate("!!document.getElementById('explainThinkingSelect')");
    assert.equal(hasToggle && hasLang && hasModel && hasThinking, true, '弹层内必须包含自动解说、语言、模型、深度四个控件');

    // 验证控件的值已正确加载
    const modelValue = await evaluate("document.getElementById('explainModelSelect').value");
    assert.equal(modelValue, 'deepseek-flash', '默认模型应正确选中');

    // 5. 截图查看展开状态的精致外观
    const screenshotDir = path.join(root, 'docs/screenshots');
    fs.mkdirSync(screenshotDir, { recursive: true });
    const screenshotResult = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(screenshotDir, 'ai-popover-open.png'), Buffer.from(screenshotResult.data, 'base64'));
    console.log('PASS AI 解说设置弹出面板展开成功，截图已保存为 docs/screenshots/ai-popover-open.png');

    // 截取暗色模式下的效果
    await evaluate("document.documentElement.setAttribute('data-theme', 'dark'); document.body.setAttribute('data-theme', 'dark');");
    await delay(100);
    const darkScreenshot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(screenshotDir, 'ai-popover-dark.png'), Buffer.from(darkScreenshot.data, 'base64'));
    await evaluate("document.documentElement.setAttribute('data-theme', 'light'); document.body.setAttribute('data-theme', 'light');");
    await delay(50);

    // 6. 测试再次点击加号按钮，弹层收起
    await evaluate("document.getElementById('explainOptionsToggleBtn').click()");
    await delay(100);
    const isHiddenToggleAgain = await evaluate("document.getElementById('explainOptionsPopover').hasAttribute('hidden')");
    assert.equal(isHiddenToggleAgain, true, '再次点击加号按钮，弹层应该收起');

    // 7. 测试点击右上角关闭按钮收起
    await evaluate("document.getElementById('explainOptionsToggleBtn').click()");
    await delay(50);
    await evaluate("document.getElementById('explainOptionsCloseBtn').click()");
    await delay(50);
    const isHiddenAfterCloseBtn = await evaluate("document.getElementById('explainOptionsPopover').hasAttribute('hidden')");
    assert.equal(isHiddenAfterCloseBtn, true, '点击右上角关闭按钮，弹层应该收起');

    // 8. 测试点击外部区域自动收起
    await evaluate("document.getElementById('explainOptionsToggleBtn').click()");
    await delay(50);
    await evaluate("document.getElementById('explainMessages').click()");
    await delay(50);
    const isHiddenAfterOutsideClick = await evaluate("document.getElementById('explainOptionsPopover').hasAttribute('hidden')");
    assert.equal(isHiddenAfterOutsideClick, true, '点击面板外部区域，弹层应该自动收起');

    // 9. 测试按 ESC 键收起
    await evaluate("document.getElementById('explainOptionsToggleBtn').click()");
    await delay(50);
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    await delay(50);
    const isHiddenAfterEsc = await evaluate("document.getElementById('explainOptionsPopover').hasAttribute('hidden')");
    assert.equal(isHiddenAfterEsc, true, '按 Escape 键，弹层应该收起');

    console.log('ALL AI SETTINGS POPOVER TESTS PASSED SUCCESSFULLY!');
  } finally {
    if (socket) socket.close();
    if (browser) browser.kill();
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
})();
