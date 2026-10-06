const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Own only the isolated browser and CDP connection; fixtures and UI setup stay in each suite.
async function launchBrowser({
  profilePrefix, args = [], startupInterval = 50, waitTimeout = 5000, waitAttempts,
  waitMessage = 'Timeout waiting for: ', exceptionDetailsAsJson = false,
  exceptionDescriptions = false, onEvent,
}) {
  const chromePath = process.env.CHROME_PATH || [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].find(candidate => fs.existsSync(candidate));
  assert(chromePath, 'Chrome/Chromium is required; set CHROME_PATH');

  const tempRoot = fs.realpathSync(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempRoot, profilePrefix));
  const pending = new Map();
  const exceptions = [];
  let browser, socket, browserExit, startupError;
  let startupStderr = '';
  let id = 0;

  const rejectPending = error => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket?.readyState !== WebSocket.OPEN) return reject(new Error('Browser connection closed'));
    const callId = ++id;
    pending.set(callId, { resolve, reject });
    try {
      socket.send(JSON.stringify({ id: callId, method, params }));
    } catch (error) {
      pending.delete(callId);
      reject(error);
    }
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(exceptionDetailsAsJson ? JSON.stringify(details) : details.exception?.description || details.text);
    }
    return result.result.value;
  };
  const wait = async (expression, timeout = waitTimeout) => {
    const start = Date.now();
    for (let attempt = 0; waitAttempts === undefined ? Date.now() - start < timeout : attempt < waitAttempts; attempt++) {
      try {
        if (await evaluate(expression)) return;
      } catch (error) {
        // Navigation replaces the execution context; retry readiness in the new page.
        if (error.code !== -32000 || !/Inspected target navigated or closed|Cannot find context|Execution context was destroyed/.test(error.message)) throw error;
      }
      await delay(50);
    }
    throw new Error(waitMessage + expression);
  };
  const close = async () => {
    if (browser && browser.exitCode === null && socket?.readyState === WebSocket.OPEN) {
      await Promise.race([send('Browser.close').catch(() => {}), delay(1000)]);
    }
    socket?.close();
    rejectPending(new Error('Browser connection closed'));
    if (browser && browser.exitCode === null) {
      await Promise.race([browserExit, delay(3000)]);
      if (browser.exitCode === null && !startupError) {
        browser.kill();
        await Promise.race([browserExit, delay(3000)]);
        if (browser.exitCode === null && browser.signalCode === null) throw new Error('Browser did not exit before profile cleanup');
      }
    }
    // Verify the generated profile is inside the resolved temp root before recursive removal.
    const relative = path.relative(tempRoot, path.resolve(profile));
    assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
      'Browser profile must stay inside the temporary directory');
    await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  };

  try {
    browser = spawn(chromePath, [
      '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
      ...args, 'about:blank',
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr.setEncoding('utf8');
    browser.stderr.on('data', chunk => { startupStderr = (startupStderr + chunk).slice(-8000); });
    browserExit = new Promise(resolve => {
      browser.once('exit', resolve);
      browser.once('error', error => { startupError = error; resolve(); });
    });
    const portFile = path.join(profile, 'DevToolsActivePort');
    let port;
    for (let i = 0; i < 200 && !port; i++) {
      if (startupError) throw startupError;
      if (browser.exitCode !== null || browser.signalCode !== null) {
        throw new Error(`Browser exited before debugging endpoint (code ${browser.exitCode}, signal ${browser.signalCode}): ${startupStderr}`);
      }
      try {
        const [rawPort, endpoint] = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
        const candidate = Number(rawPort);
        if (Number.isInteger(candidate) && candidate > 0 && candidate <= 65535 && endpoint?.startsWith('/devtools/browser/')) {
          port = candidate;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!port) await delay(startupInterval);
    }
    if (startupError) throw startupError;
    assert(port, `Browser debugging endpoint did not start: ${startupStderr || 'no stderr output'}`);
    const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onclose = () => rejectPending(new Error('Browser connection closed'));
    socket.onmessage = event => {
      const data = JSON.parse(event.data);
      if (data.id) {
        const entry = pending.get(data.id);
        pending.delete(data.id);
        if (entry) data.error ? entry.reject(data.error) : entry.resolve(data.result);
      }
      if (data.method === 'Runtime.exceptionThrown') {
        const details = data.params.exceptionDetails;
        exceptions.push(exceptionDescriptions ? details.exception?.description || details.text : details);
      }
      if (!data.id) onEvent?.(data);
    };
    return { send, evaluate, wait, exceptions, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

module.exports = { launchBrowser, delay };
