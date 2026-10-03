import { apiFetch } from './api.js';

export class ArticleAPI {
  constructor(accountId) { this.accountId = accountId; }

  async request(path, method = 'GET', body = null, signal = null) {
    const response = await apiFetch('/api/articles' + path, {
      method, signal,
      headers: { 'Content-Type': 'application/json', 'X-Article-Account': String(this.accountId) },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    }, 15000);
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      const error = new Error(Array.isArray(data?.detail)
        ? '文章格式无效：标题最多 200 字，正文最多 500,000 字。' : data?.detail || '文章服务暂时不可用。');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  list(query = '', signal) { return this.request('?q=' + encodeURIComponent(query), 'GET', null, signal); }
  get(id, signal) { return this.request('/' + encodeURIComponent(id), 'GET', null, signal); }
  create(body, signal) { return this.request('', 'POST', body, signal); }
  update(id, body, signal) { return this.request('/' + encodeURIComponent(id), 'PUT', body, signal); }
  remove(id, signal) { return this.request('/' + encodeURIComponent(id), 'DELETE', null, signal); }
}
