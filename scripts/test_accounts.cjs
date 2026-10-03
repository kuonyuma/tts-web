// Offline browser contract tests for account forms; backend flows use pytest.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { launchBrowser } = require('./browser_test_helper.cjs');
const root = path.resolve(__dirname, '..', 'frontend');
const requests = [];
let loggedIn = false;
const user = { id: 7, username: 'alice', email: 'alice@example.com', email_verified: false,
  role: 'user', is_active: true, has_password: true };
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const json = (data, status = 200, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data));
  };
  if (pathname.startsWith('/api/')) {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ pathname, body, headers: req.headers });
    if (pathname === '/api/auth/config') return json({ email_enabled: true, oauth_providers: ['github'], auth_required: false });
    if (pathname === '/api/auth/me') return json(loggedIn ? user : { detail: '登录已失效' }, loggedIn ? 200 : 401);
    if (pathname === '/api/users/register') return json(user, 201);
    if (pathname === '/api/auth/login') {
      loggedIn = true;
      return json({ user, access_token: 'should-not-be-stored', token_type: 'bearer' }, 200,
        { 'Set-Cookie': ['tts_session=opaque; HttpOnly; SameSite=Lax; Path=/', 'tts_csrf=csrf-demo; SameSite=Lax; Path=/'] });
    }
    if (pathname === '/api/auth/logout') { loggedIn = false; res.writeHead(204); return res.end(); }
    if (pathname === '/api/auth/email/verify') { user.email_verified = true; return json({ detail: '邮箱已验证。' }); }
    if (pathname === '/api/auth/email/verification' || pathname === '/api/auth/password/forgot') return json({ detail: '邮件已申请。' }, 202);
    if (pathname === '/api/auth/password/reset') return json({ detail: '密码已重置。' });
    return json({ detail: 'missing' }, 404);
  }
  const file = path.resolve(root, pathname.slice(1));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'text/plain' });
  res.end(fs.readFileSync(file));
});
let browser;
(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/account.html`;
    browser = await launchBrowser({ profilePrefix: 'tts-account-browser-', exceptionDescriptions: true });
    await browser.send('Page.enable'); await browser.send('Runtime.enable');
    await browser.send('Page.navigate', { url });
    await browser.wait("document.body.dataset.accountReady === 'true'");
    await browser.evaluate("document.querySelector('[data-view=\"register\"]').click();");
    const shots = path.join(__dirname, '..', 'docs', 'screenshots');
    fs.mkdirSync(shots, { recursive: true });
    fs.writeFileSync(path.join(shots, 'accounts-register.png'), Buffer.from((await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
    await browser.evaluate(`document.querySelector('[data-view="register"]').click();
      document.getElementById('registerUsername').value='alice';document.getElementById('registerEmail').value='alice@example.com';
      document.getElementById('registerPassword').value='example-password';document.getElementById('registerConfirm').value='mismatch';
      document.getElementById('registerForm').requestSubmit();`);
    await browser.wait("document.getElementById('accountNotice').textContent.includes('两次')");
    assert(!requests.some(r => r.pathname === '/api/users/register'));
    await browser.evaluate("document.getElementById('registerConfirm').value='example-password';document.getElementById('registerForm').requestSubmit();");
    await browser.wait("document.getElementById('accountNotice').textContent.includes('账号已创建')");
    assert.deepEqual(requests.find(r => r.pathname === '/api/users/register').body,
      { username: 'alice', email: 'alice@example.com', password: 'example-password' });
    await browser.evaluate(`document.getElementById('loginIdentity').value='alice';document.getElementById('loginPassword').value='example-password';document.getElementById('loginForm').requestSubmit();`);
    await browser.wait("!document.getElementById('accountPanel').hidden");
    assert.equal(await browser.evaluate("localStorage.getItem('tts_account_scope')"), 'account_7');
    assert(!await browser.evaluate("JSON.stringify(localStorage).includes('should-not-be-stored')"));
    await browser.evaluate("document.getElementById('resendVerification').click();");
    await browser.wait("document.getElementById('accountNotice').textContent.includes('邮件已申请')");
    await browser.evaluate("document.getElementById('logoutButton').click();");
    await browser.wait("document.getElementById('accountPanel').hidden");
    assert.equal(requests.find(r => r.pathname === '/api/auth/logout').headers['x-csrf-token'], 'csrf-demo');
    assert.equal(await browser.evaluate("localStorage.getItem('tts_account_scope')"), null);
    await browser.send('Page.navigate', { url: url + '#reset=' + 'r'.repeat(43) });
    await browser.wait("document.body.dataset.accountReady === 'true' && !document.getElementById('resetForm').hidden");
    assert.equal(await browser.evaluate('location.hash'), '');
    await browser.evaluate(`document.getElementById('resetPassword').value='changed-password';document.getElementById('resetConfirm').value='changed-password';document.getElementById('resetForm').requestSubmit();`);
    await browser.wait("document.getElementById('accountNotice').textContent.includes('密码已重置')");
    assert.equal(requests.find(r => r.pathname === '/api/auth/password/reset').body.token, 'r'.repeat(43));
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'));
    fs.writeFileSync(path.join(shots, 'accounts-mobile.png'), Buffer.from((await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
    assert.deepEqual(browser.exceptions, []);
    console.log('PASS registration/confirmation, login, no JWT persistence, verification, CSRF logout, reset fragment removal and mobile layout');
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
