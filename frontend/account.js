import { accountRequest, rememberAccount } from './account-client.js';
import { apiFetch } from './api.js';

const $ = id => document.getElementById(id);
let currentUser = null;
let config = { email_enabled: false, oauth_providers: [] };
let resetToken = null;
let adminOffset = 0;
const fragment = new URLSearchParams(location.hash.slice(1));
const verifyToken = fragment.get('verify');
resetToken = fragment.get('reset');
if (verifyToken || resetToken) history.replaceState(null, '', location.pathname);
const theme = localStorage.getItem('tts_theme');
if (theme === 'dark' || theme === 'light') document.body.dataset.theme = theme;

function notice(message, error = false) {
  $('accountNotice').textContent = message;
  $('accountNotice').dataset.error = String(error);
  $('accountNotice').hidden = false;
}

function view(name) {
  for (const id of ['login', 'register', 'forgot', 'reset']) $(id + 'Form').hidden = id !== name;
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === name)));
  $('githubLogin').hidden = !config.oauth_providers.includes('github') || name !== 'login';
}

function bindAction(element, action, eventName = 'click') {
  element.addEventListener(eventName, async event => {
    event.preventDefault();
    const button = element.tagName === 'FORM' ? element.querySelector('button[type="submit"]') : element;
    if (button.disabled) return;
    button.disabled = true;
    try { await action(); } catch (error) { notice(error.message, true); }
    finally { button.disabled = false; }
  });
}

async function renderAccount(user) {
  currentUser = user;
  rememberAccount(user);
  $('accountPanel').hidden = !user;
  $('authForms').hidden = Boolean(user);
  $('adminPanel').hidden = user?.role !== 'admin';
  if (!user) return;
  $('accountUsername').textContent = user.username;
  $('accountEmail').textContent = user.email || '尚未设置邮箱';
  $('verificationStatus').textContent = user.email_verified ? '邮箱已验证' : '邮箱尚未验证，请查收验证邮件。';
  $('resendVerification').hidden = !user.email || user.email_verified || !config.email_enabled;
  $('linkGithub').hidden = !config.oauth_providers.includes('github');
  $('emailPassword').hidden = !user.has_password;
  $('emailPasswordLabel').hidden = !user.has_password;
  $('emailPassword').required = user.has_password;
  $('emailForm').hidden = !user.has_password;
  $('oauthEmailAdvice').hidden = user.has_password;
  $('emailForm').querySelector('button').disabled = !config.email_enabled;
  if (user.role === 'admin') { adminOffset = 0; $('adminUsers').replaceChildren(); await loadUsers(); }
}

async function refreshAccount() {
  const response = await apiFetch('/api/auth/me');
  if (response.status === 401) { await renderAccount(null); return; }
  if (!response.ok) throw new Error('暂时无法读取账号，请刷新重试。');
  await renderAccount(await response.json());
}

async function loadUsers() {
  const users = await accountRequest(`/api/users?limit=50&offset=${adminOffset}`, null, 'GET');
  for (const user of users) {
    const row = document.createElement('div'); row.className = 'admin-user';
    const label = document.createElement('strong'); label.textContent = `${user.username} · ${user.email || '无邮箱'}`;
    const role = document.createElement('select'); role.setAttribute('aria-label', `${user.username} 的角色`);
    for (const [value, text] of [['user', '普通用户'], ['admin', '管理员']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = text; role.append(option);
    }
    role.value = user.role;
    const activeLabel = document.createElement('label');
    const active = document.createElement('input'); active.type = 'checkbox'; active.checked = user.is_active;
    activeLabel.append(active, document.createTextNode(' 允许登录'));
    const save = document.createElement('button'); save.textContent = '保存';
    bindAction(save, async () => {
      await accountRequest(`/api/users/${user.id}`, { role: role.value, is_active: active.checked }, 'PATCH');
      notice('账号状态已更新。');
      if (user.id === currentUser.id) await refreshAccount();
    });
    row.append(label, role, activeLabel, save); $('adminUsers').append(row);
  }
  adminOffset += users.length;
  $('loadMoreUsers').hidden = users.length < 50;
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => view(button.dataset.view)));
bindAction($('registerForm'), async () => {
  const password = $('registerPassword').value;
  if (password !== $('registerConfirm').value) throw new Error('两次密码不一致。');
  const email = $('registerEmail').value;
  await accountRequest('/api/users/register', { username: $('registerUsername').value, email, password });
  $('loginIdentity').value = email;
  $('registerForm').reset(); view('login');
  notice(config.email_enabled ? '账号已创建，请查收验证邮件，然后登录。' : '账号已创建，可以登录；邮箱验证需稍后启用。');
}, 'submit');
bindAction($('loginForm'), async () => {
  const data = await accountRequest('/api/auth/login', { identity: $('loginIdentity').value, password: $('loginPassword').value });
  $('loginForm').reset(); await renderAccount(data.user); notice('登录成功。');
}, 'submit');
bindAction($('forgotForm'), async () => notice((await accountRequest('/api/auth/password/forgot', { email: $('forgotEmail').value })).detail), 'submit');
bindAction($('resetForm'), async () => {
  if (!resetToken) throw new Error('请从重置邮件中打开链接。');
  if ($('resetPassword').value !== $('resetConfirm').value) throw new Error('两次密码不一致。');
  const data = await accountRequest('/api/auth/password/reset', { token: resetToken, password: $('resetPassword').value });
  resetToken = null; $('resetForm').reset(); await renderAccount(null); view('login'); notice(data.detail);
}, 'submit');
bindAction($('logoutButton'), async () => { await accountRequest('/api/auth/logout'); await renderAccount(null); view('login'); notice('已退出登录。'); });
bindAction($('resendVerification'), async () => notice((await accountRequest('/api/auth/email/verification', { email: currentUser.email })).detail));
bindAction($('emailForm'), async () => {
  const body = { email: $('newEmail').value };
  if (currentUser.has_password) body.password = $('emailPassword').value;
  const user = await accountRequest('/api/auth/email', body, 'PUT');
  $('emailForm').reset(); await renderAccount(user); notice('邮箱已更新，请查收验证邮件。');
}, 'submit');
bindAction($('linkGithub'), async () => {
  const data = await accountRequest('/api/auth/oauth/github/link');
  const url = new URL(data.url);
  if (url.origin !== 'https://github.com' || url.pathname !== '/login/oauth/authorize') throw new Error('授权地址无效。');
  location.assign(url.href);
});
bindAction($('loadMoreUsers'), loadUsers);

window.addEventListener('hashchange', async () => {
  const link = new URLSearchParams(location.hash.slice(1));
  const reset = link.get('reset'), verify = link.get('verify');
  if (!reset && !verify) return;
  history.replaceState(null, '', location.pathname);
  try {
    if (reset) {
      resetToken = reset; $('authForms').hidden = false;
      $('accountPanel').hidden = true; $('adminPanel').hidden = true; view('reset');
    } else {
      notice((await accountRequest('/api/auth/email/verify', { token: verify })).detail);
      await refreshAccount();
    }
  } catch (error) { notice(error.message, true); }
});

async function init() {
  config = await accountRequest('/api/auth/config', null, 'GET');
  $('emailUnavailable').hidden = config.email_enabled;
  $('forgotForm').querySelector('button').disabled = !config.email_enabled;
  await refreshAccount();
  if (verifyToken) { notice((await accountRequest('/api/auth/email/verify', { token: verifyToken })).detail); await refreshAccount(); }
  if (resetToken) { $('authForms').hidden = false; $('accountPanel').hidden = true; view('reset'); }
  else view(fragment.get('view') || 'login');
  document.body.dataset.accountReady = 'true';
}
init().catch(error => { notice(error.message, true); document.body.dataset.accountReady = 'true'; });
