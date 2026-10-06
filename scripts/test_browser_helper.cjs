const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchBrowser, delay } = require('./browser_test_helper.cjs');

const prefix = 'tts-harness-lifecycle-test-';
const profiles = () => fs.readdirSync(fs.realpathSync(os.tmpdir())).filter(name => name.startsWith(prefix)).sort();

(async () => {
  const before = profiles();
  const chromePath = process.env.CHROME_PATH;
  const missing = path.join(__dirname, 'nonexistent-browser.exe');
  assert(!fs.existsSync(missing));
  try {
    process.env.CHROME_PATH = missing;
    await assert.rejects(launchBrowser({ profilePrefix: prefix }), error => error.code === 'ENOENT');
    // A process that rejects browser flags must expose its startup error, not time out.
    process.env.CHROME_PATH = process.execPath;
    await assert.rejects(launchBrowser({ profilePrefix: prefix }), /Browser exited before debugging endpoint.*bad option/s);
  } finally {
    if (chromePath === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = chromePath;
  }
  assert.deepEqual(profiles(), before, 'Failed startup must clean its temporary profile');

  const browser = await launchBrowser({ profilePrefix: prefix });
  try {
    assert.deepEqual(await browser.evaluate('Promise.resolve({ value: 42 })'), { value: 42 });
    await assert.rejects(browser.send('Runtime.nonexistentMethod'), error => error.code === -32601);
    await assert.rejects(browser.evaluate('throw new Error("expected evaluation error")'), /expected evaluation error/);
    const pending = browser.evaluate('new Promise(() => {})').then(() => 'resolved', () => 'rejected');
    await browser.close();
    assert.equal(await Promise.race([pending, delay(500).then(() => 'hung')]), 'rejected');
    const afterClose = browser.send('Runtime.evaluate', { expression: '1' }).then(() => 'resolved', () => 'rejected');
    assert.equal(await Promise.race([afterClose, delay(500).then(() => 'hung')]), 'rejected',
      'Commands submitted after browser closure must reject instead of hanging');
  } finally {
    await browser.close();
  }
  assert.deepEqual(profiles(), before, 'Closed browser must clean its temporary profile');
  console.log('PASS browser startup cleanup, CDP errors, async evaluation and rejection during/after closure');
})().catch(error => { console.error(error); process.exitCode = 1; });
