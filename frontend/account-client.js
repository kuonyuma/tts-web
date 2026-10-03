import { apiFetch, setAccountScope } from './api.js';

export const ACCOUNT_SCOPE_KEY = 'tts_account_scope';

export function rememberAccount(user) {
  if (user) localStorage.setItem(ACCOUNT_SCOPE_KEY, `account_${user.id}`);
  else localStorage.removeItem(ACCOUNT_SCOPE_KEY);
  setAccountScope(user ? `account_${user.id}` : null);
}

export async function accountRequest(path, body = null, method = 'POST') {
  const response = await apiFetch(path, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  }, 15000);
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const detail = data?.detail;
    throw new Error(Array.isArray(detail) ? '输入格式不正确，请检查填写内容。' : detail || '操作失败，请稍后重试。');
  }
  return data;
}

function bounded(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('账号服务暂时无法连接。')), ms);
  })]).finally(() => clearTimeout(timer));
}

export async function bootstrapAccount() {
  const hint = localStorage.getItem(ACCOUNT_SCOPE_KEY);
  try {
    const [response, configResponse] = await bounded(Promise.all([
      apiFetch('/api/auth/me', {}, 2000), apiFetch('/api/auth/config', {}, 2000),
    ]), 2200);
    const config = configResponse.ok ? await configResponse.json() : {};
    if (response.ok) {
      const user = await response.json();
      if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new Error('账号响应无效。');
      rememberAccount(user);
      const button = document.getElementById('accountButton');
      if (button) { button.textContent = user.username; button.title = '账号设置'; }
      return user;
    }
    if (response.status !== 401 && response.status !== 404) throw new Error('暂时无法验证登录状态，请刷新重试。');
    rememberAccount(null);
    if (config.auth_required) { location.replace('/account.html#login'); throw new Error('请先登录。'); }
    return null;
  } catch (error) {
    if (hint) throw error;
    // An unavailable optional account service cannot erase offline local text.
    return null;
  }
}
