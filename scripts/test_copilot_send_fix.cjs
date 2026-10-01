// Regression test for Copilot send button, suggestion chips, and retry behavior
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-send-fix-test-'));

const chatRequests = [];
let pendingChatResolver = null;

let shouldFailChat = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (url.pathname === '/api/engines') {
    return json([{
      id: 'edge', name: 'Edge', is_free: true, default_voice: 'ja-JP-NanamiNeural',
      max_text_length: 1000, min_text_length: 1, request_timeout_seconds: 30,
      voices: [{ id: 'ja-JP-NanamiNeural', name: 'Nanami' }],
    }]);
  }
  if (url.pathname === '/api/history') return json([]);
  if (url.pathname === '/api/copilot/models') {
    return json({
      models: [
        {
          id: 'deepseek-flash',
          name: 'DeepSeek Flash',
          default: true,
          modes: [
            { id: 'direct', name: '直接回答', description: '速度优先', quota_weight: 1 },
          ],
        },
      ],
    });
  }
  if (url.pathname === '/api/explain' && req.method === 'POST') {
    return json({
      explain_key: 'test-explain-key-123',
      text: '本日はお忙しい中、お集まりいただきありがとうございます。',
      explanation: '【翻译】非常感谢大家在百忙之中抽空出席。',
      model_id: 'deepseek-flash',
      mode_id: 'direct',
      messages: [],
    });
  }
  if (url.pathname === '/api/explain/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      chatRequests.push(parsed);
      if (shouldFailChat) {
        shouldFailChat = false;
        return json({ detail: '模拟网络错误' }, 500);
      }
      const respond = () => {
        json({
          explain_key: parsed.explain_key,
          answer: `回复：${typeof parsed.message === 'string' ? parsed.message : JSON.stringify(parsed.message)}`,
          model_id: 'deepseek-flash',
          mode_id: 'direct',
        });
      };
      if (pendingChatResolver) {
        pendingChatResolver(respond);
        pendingChatResolver = null;
      } else {
        respond();
      }
    });
    return;
  }

  const relativePath = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  const filePath = path.join(root, 'frontend', relativePath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const contentType = ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : ext === '.html' ? 'text/html' : 'text/plain';
    res.writeHead(200, { 'Content-Type': contentType });
    return res.end(fs.readFileSync(filePath));
  }

  res.writeHead(404);
  res.end();
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let browser = null;
let socket = null;
let msgId = 0;
const pending = new Map();

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const callId = ++msgId;
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

(async () => {
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const testUrl = `http://127.0.0.1:${port}/`;

    browser = spawn(chromePath, [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ]);

    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await delay(50);
    assert(fs.existsSync(portFile), 'Browser debugging endpoint did not start');
    const browserDebugPort = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];

    const tab = await (await fetch(`http://127.0.0.1:${browserDebugPort}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id) {
        const entry = pending.get(data.id);
        pending.delete(data.id);
        if (entry) data.error ? entry.reject(data.error) : entry.resolve(data.result);
      }
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: testUrl });
    await wait("document.body?.dataset.ready === 'true'");

    console.log('Testing Copilot Send Button, Suggestion Chips, and Retry...');

    // Expand AI sidebar if hidden
    const isAiSidebarHidden = await evaluate("document.getElementById('explainSection').hasAttribute('hidden')");
    if (isAiSidebarHidden) {
      await evaluate("document.getElementById('aiPanelBtn').click()");
      await wait("!document.getElementById('explainSection').hasAttribute('hidden')");
      await delay(200);
    }

    // 1. Initialize an explanation session
    await evaluate(`(async () => {
      const copilot = await import('/copilot.js');
      window.__copilot = copilot;
      await copilot.requestExplanation('本日はお忙しい中、お集まりいただきありがとうございます。', { manual: true });
    })()`);
    await delay(300);

    const hasExplanation = await evaluate(`
      document.querySelector('.explain-msg-assistant') !== null
    `);
    assert.equal(hasExplanation, true, 'Base explanation should be rendered');

    // 2. Test: Type query and click explainSendBtn with MouseEvent
    chatRequests.length = 0;
    await evaluate(`(() => {
      const input = document.getElementById('explainChatInput');
      const sendBtn = document.getElementById('explainSendBtn');
      input.value = '请问这句话是在什么场合使用的？';
      sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    })()`);
    await delay(300);

    assert.equal(chatRequests.length, 1, 'Clicking send button should send 1 chat request');
    assert.equal(typeof chatRequests[0].message, 'string', 'Message payload MUST be a string, not an Event object');
    assert.equal(chatRequests[0].message, '请问这句话是在什么场合使用的？', 'Message payload should match input value');

    const inputCleared = await evaluate(`document.getElementById('explainChatInput').value`);
    assert.equal(inputCleared, '', 'Input textarea should be cleared after sending');

    const userBubbleText = await evaluate(`(() => {
      const userBubbles = document.querySelectorAll('.explain-msg-user');
      return userBubbles[userBubbles.length - 1]?.textContent.trim();
    })()`);
    assert.equal(userBubbleText, '请问这句话是在什么场合使用的？', 'User message bubble should be added');

    console.log('PASS: Mouse click on explainSendBtn sends string message and clears input');
    await wait("!document.getElementById('explainSendBtn').disabled");

    // 3. Test: Click suggestion chip "翻译"
    chatRequests.length = 0;
    await evaluate(`(() => {
      const chip = document.querySelector('.suggest-chip[data-prompt="请翻译这段文本。"]');
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    })()`);
    await delay(300);

    assert.equal(chatRequests.length, 1, 'Clicking translate chip should send 1 chat request immediately');
    assert.equal(typeof chatRequests[0].message, 'string', 'Chip prompt MUST be sent as a string');
    assert.equal(chatRequests[0].message, '请翻译这段文本。', 'Chip prompt text must match');

    const translateUserBubble = await evaluate(`(() => {
      const userBubbles = document.querySelectorAll('.explain-msg-user');
      return userBubbles[userBubbles.length - 1]?.textContent.trim();
    })()`);
    assert.equal(translateUserBubble, '请翻译这段文本。', 'User bubble for translate chip should be added');

    console.log('PASS: Clicking suggestion chip "翻译" sends prompt immediately with user bubble');
    await wait("!document.getElementById('explainSendBtn').disabled");

    // 4. Test: Click suggestion chip "语法分析"
    chatRequests.length = 0;
    await evaluate(`(() => {
      const chip = document.querySelector('.suggest-chip[data-prompt="请分析这段文本的语法。"]');
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    })()`);
    await delay(300);

    assert.equal(chatRequests.length, 1, 'Clicking grammar analysis chip should send 1 chat request');
    assert.equal(chatRequests[0].message, '请分析这段文本的语法。');

    const grammarUserBubble = await evaluate(`(() => {
      const userBubbles = document.querySelectorAll('.explain-msg-user');
      return userBubbles[userBubbles.length - 1]?.textContent.trim();
    })()`);
    assert.equal(grammarUserBubble, '请分析这段文本的语法。', 'User bubble for grammar chip should be added');

    console.log('PASS: Clicking suggestion chip "语法分析" sends prompt immediately with user bubble');
    await wait("!document.getElementById('explainSendBtn').disabled");

    // 5. Test: Keyboard Enter in input textarea
    chatRequests.length = 0;
    await evaluate(`(() => {
      const input = document.getElementById('explainChatInput');
      input.value = '请解释这里的敬语成分';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
    await delay(300);

    assert.equal(chatRequests.length, 1, 'Pressing Enter should send 1 chat request');
    assert.equal(chatRequests[0].message, '请解释这里的敬语成分');

    console.log('PASS: Keyboard Enter sends typed query properly');
    await wait("!document.getElementById('explainSendBtn').disabled");

    // 6. Test: Disabled state while busy (chat pending)
    let resolvePending = null;
    pendingChatResolver = (callback) => { resolvePending = callback; };

    await evaluate(`(() => {
      const chip = document.querySelector('.suggest-chip[data-prompt="请解释重点词汇。"]');
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    })()`);
    await delay(100);

    const isBusy = await evaluate(`(() => {
      const sendDisabled = document.getElementById('explainSendBtn').disabled;
      const chipsDisabled = Array.from(document.querySelectorAll('.suggest-chip')).every(c => c.disabled);
      return { sendDisabled, chipsDisabled };
    })()`);
    assert.equal(isBusy.sendDisabled, true, 'Send button must be disabled while request is pending');
    assert.equal(isBusy.chipsDisabled, true, 'Suggestion chips must be disabled while request is pending');

    // Resolve the pending chat request
    resolvePending();
    await wait("!document.getElementById('explainSendBtn').disabled");

    const isReadyAgain = await evaluate(`(() => {
      const sendDisabled = document.getElementById('explainSendBtn').disabled;
      const chipsDisabled = Array.from(document.querySelectorAll('.suggest-chip')).some(c => c.disabled);
      return { sendDisabled, chipsDisabled };
    })()`);
    assert.equal(isReadyAgain.sendDisabled, false, 'Send button should re-enable when done');
    assert.equal(isReadyAgain.chipsDisabled, false, 'Suggestion chips should re-enable when done');

    console.log('PASS: Disabled states and busy handling work correctly during chat requests');

    // 7. Test: Error and Retry
    shouldFailChat = true;
    chatRequests.length = 0;
    await evaluate(`(() => {
      const input = document.getElementById('explainChatInput');
      input.value = '测试失败重试';
      document.getElementById('explainSendBtn').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    })()`);
    await wait("(() => { const btns = document.querySelectorAll('.explain-retry-bubble-btn'); return btns.length > 0 && !btns[btns.length - 1].disabled; })()");

    const userBubbleCountBeforeRetry = await evaluate(`document.querySelectorAll('.explain-msg-user').length`);

    // Click retry button on the failed message
    chatRequests.length = 0;
    await evaluate(`(() => {
      const btns = document.querySelectorAll('.explain-retry-bubble-btn');
      btns[btns.length - 1].click();
    })()`);
    await wait("!document.getElementById('explainSendBtn').disabled");

    assert.equal(chatRequests.length, 1, 'Retry should send 1 chat request');
    assert.equal(chatRequests[0].message, '测试失败重试', 'Retry must resend original question string');

    const userBubbleCountAfterRetry = await evaluate(`document.querySelectorAll('.explain-msg-user').length`);
    assert.equal(userBubbleCountAfterRetry, userBubbleCountBeforeRetry, 'Retry must NOT duplicate user message bubble');

    console.log('PASS: Error retry resends original question without duplicating user bubble');

    console.log('\nALL COPILOT SEND & SUGGESTION CHIP TESTS PASSED SUCCESSFULLY!');
  } catch (err) {
    console.error('Test failed:', err);
    process.exitCode = 1;
  } finally {
    if (socket) socket.close();
    if (browser) browser.kill();
    server.close();
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
})();
