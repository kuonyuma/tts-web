/** Account-scoped drafts and one serialized save queue per article. No UI or AI dependencies. */
export class ArticleState {
  constructor({ api, storage, accountId, draftOwner = 'default', onChange = () => {}, debounceMs = 1000 }) {
    Object.assign(this, { api, storage, accountId, draftOwner, onChange, debounceMs });
    this.entries = new Map();
    this.opening = new Map();
    this.controllers = new Set();
    this.deletingIds = new Set();
    this.removedIds = new Set();
    this.alive = true;
  }

  draftPrefix() { return `tts_article_draft_v1:account_${this.accountId}:`; }
  deletedKey(id = '') { return `tts_article_deleted_v1:account_${this.accountId}:${id}`; }
  draftKey(id) { return this.draftPrefix() + id + (this.draftOwner === 'default' ? '' : ':' + this.draftOwner); }
  draftIds() {
    const prefix = this.draftPrefix();
    const ids = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key?.startsWith(prefix)) ids.push(key.slice(prefix.length).split(':')[0]);
    }
    return [...new Set(ids)].filter(id => !this.storage.getItem(this.deletedKey(id)));
  }
  readDraft(id) {
    try {
      let raw = this.storage.getItem(this.draftKey(id));
      let foreign = false;
      if (!raw) {
        const prefix = this.draftPrefix() + id;
        const candidates = [];
        for (let i = 0; i < this.storage.length; i++) {
          const key = this.storage.key(i);
          if (key === prefix || key?.startsWith(prefix + ':')) {
            try { candidates.push({ key, raw: this.storage.getItem(key), data: JSON.parse(this.storage.getItem(key)) }); } catch { /* keep unreadable records */ }
          }
        }
        candidates.sort((a, b) => String(b.data?.savedAt || '').localeCompare(String(a.data?.savedAt || '')));
        raw = candidates.length ? JSON.stringify({ ...candidates[0].data, sourceKey: candidates[0].key, sourceRaw: candidates[0].raw }) : null;
        foreign = !!raw;
      }
      const draft = JSON.parse(raw || 'null');
      return draft && typeof draft.title === 'string' && typeof draft.content === 'string'
        && (Number.isSafeInteger(draft.revision) || draft.isNew === true) ? { ...draft, foreign } : null;
    } catch { return null; }
  }
  protect(entry) {
    try {
      if (entry.dirty) this.storage.setItem(this.draftKey(entry.id), JSON.stringify({
        title: entry.title, content: entry.content, revision: entry.revision, isNew: entry.isNew,
        savedAt: new Date().toISOString(), conflict: entry.status === 'conflict',
      }));
      else this.storage.removeItem(this.draftKey(entry.id));
      entry.localError = '';
    } catch { entry.localError = '浏览器草稿保护失败，请保持页面打开并重试保存。'; }
  }
  emit(entry) { if (this.alive) this.onChange(entry); }
  valid(entry) { return this.alive && this.entries.get(entry.id) === entry && !entry.deleting; }
  async request(action) {
    if (!this.alive) return null;
    const controller = new AbortController();
    this.controllers.add(controller);
    try { return await action(controller.signal); }
    finally { this.controllers.delete(controller); }
  }
  async list(query = '') { return this.request(signal => this.api.list(query, signal)); }

  async open(id) {
    if (!this.alive || this.deletingIds.has(id) || this.removedIds.has(id) || this.storage.getItem(this.deletedKey(id))) return null;
    if (this.entries.has(id)) return this.entries.get(id);
    if (this.opening.has(id)) return this.opening.get(id);
    const task = this.load(id).finally(() => this.opening.delete(id));
    this.opening.set(id, task);
    return task;
  }
  async load(id) {
    const draft = this.readDraft(id);
    let article, loadError = null;
    try { article = await this.request(signal => this.api.get(id, signal)); }
    catch (error) {
      if (!this.alive) return null;
      if (!draft || [401, 403, 409].includes(error.status)) throw error;
      // Expose protected drafts even offline. Verify ownership/version before retrying a write.
      loadError = error.status === 404 && draft.isNew ? null : error;
      article = { id, ...draft, created_at: draft.savedAt, updated_at: draft.savedAt,
        revision: draft.revision || 0, unverified: !!loadError };
    }
    if (!this.alive || !article || this.deletingIds.has(id) || this.removedIds.has(id)) return null;
    if (this.entries.has(id)) return this.entries.get(id);
    const entry = this.register(article, !!article.isNew);
    if (draft) {
      entry.sourceDraft = draft.foreign ? { key: draft.sourceKey, raw: draft.sourceRaw } : null;
      // A POST may have committed before a lost response; its UUID is idempotent.
      const alreadySaved = !entry.isNew && !entry.unverified && draft.title === article.title && draft.content === article.content;
      if (!alreadySaved) {
        Object.assign(entry, { title: draft.title, content: draft.content, dirty: true, seq: 1 });
        if (entry.unverified) {
          entry.status = 'error'; entry.error = loadError.message;
        } else if (!entry.isNew && (draft.foreign || draft.conflict || draft.revision !== article.revision)) {
          entry.revision = draft.revision;
          entry.status = 'conflict'; entry.server = article;
          if (draft.foreign) entry.error = '已恢复其他浏览器标签的草稿，请明确选择后再保存。';
        } else { entry.status = 'pending'; this.schedule(entry); }
      } else this.protect(entry);
    }
    this.emit(entry);
    return entry;
  }
  register(article, isNew = false) {
    const entry = { ...article, isNew, dirty: isNew, seq: 0, status: isNew ? 'pending' : 'saved',
      error: '', localError: '', server: null, timer: null, task: null, deleting: false };
    this.entries.set(entry.id, entry);
    return entry;
  }
  create(title = '未命名文章', content = '') {
    if (!this.alive) return null;
    const now = new Date().toISOString();
    const entry = this.register({ id: globalThis.crypto.randomUUID(), title, content,
      revision: 0, created_at: now, updated_at: now }, true);
    this.protect(entry); this.emit(entry);
    return entry;
  }
  edit(id, patch, composing = false) {
    const entry = this.entries.get(id);
    if (!entry || !this.valid(entry)) return;
    Object.assign(entry, patch);
    entry.composing = composing;
    entry.seq++; entry.dirty = true; entry.error = '';
    if (entry.status !== 'conflict') entry.status = entry.task ? 'saving' : 'pending';
    this.protect(entry);
    clearTimeout(entry.timer);
    if (!composing) this.schedule(entry);
    this.emit(entry);
  }
  schedule(entry) {
    clearTimeout(entry.timer);
    if (this.valid(entry) && entry.status !== 'conflict') {
      entry.timer = setTimeout(() => this.flush(entry.id), this.debounceMs);
    }
  }
  async flush(id) {
    const entry = this.entries.get(id);
    if (!entry || !this.valid(entry) || !entry.dirty || entry.composing || entry.status === 'conflict') return;
    clearTimeout(entry.timer);
    if (entry.task) return entry.task;
    entry.task = this.saveLoop(entry);
    try { await entry.task; }
    finally { entry.task = null; }
  }
  async saveLoop(entry) {
    while (this.valid(entry) && entry.dirty && !entry.composing && entry.status !== 'conflict') {
      const seq = entry.seq;
      const body = { title: entry.title, content: entry.content };
      const controller = new AbortController();
      entry.controller = controller;
      this.controllers.add(controller);
      entry.status = 'saving'; this.emit(entry);
      try {
        if (entry.unverified) {
          let server;
          try { server = await this.api.get(entry.id, controller.signal); }
          catch (error) { if (!(error.status === 404 && entry.isNew)) throw error; }
          if (!this.valid(entry)) return;
          if (server && (server.revision !== entry.revision || entry.isNew)) {
            entry.status = 'conflict'; entry.server = server;
            if (server.title === entry.title && server.content === entry.content) {
              entry.dirty = false; entry.status = 'saved'; entry.revision = server.revision; entry.isNew = false;
            }
            this.protect(entry); this.emit(entry); return;
          }
          entry.unverified = false;
        }
        const saved = entry.isNew ? await this.api.create({ id: entry.id, ...body }, controller.signal)
          : await this.api.update(entry.id, { ...body, revision: entry.revision }, controller.signal);
        if (!this.valid(entry)) return;
        entry.isNew = false;
        entry.updated_at = saved.updated_at;
        entry.created_at = saved.created_at;
        entry.dirty = seq !== entry.seq;
        // Idempotent creation may return an earlier version, never falsely acknowledge it.
        if (saved.title !== body.title || saved.content !== body.content) {
          entry.dirty = true; entry.status = 'conflict'; entry.server = saved;
        } else {
          entry.revision = saved.revision;
          entry.status = entry.dirty ? 'pending' : 'saved';
        }
        entry.error = '';
        this.protect(entry); this.emit(entry);
      } catch (error) {
        if (!this.valid(entry)) return;
        entry.error = error.message;
        entry.status = error.status === 409 ? 'conflict' : 'error';
        if (entry.status === 'conflict') {
          try { entry.server = await this.api.get(entry.id, controller.signal); } catch { /* retain draft */ }
          if (!this.valid(entry)) return;
        }
        this.protect(entry); this.emit(entry);
        return;
      } finally {
        this.controllers.delete(controller);
        if (entry.controller === controller) entry.controller = null;
      }
    }
  }
  async resolve(id, choice) {
    const entry = this.entries.get(id);
    if (!entry || !this.valid(entry) || entry.resolving) return;
    const seq = entry.seq;
    entry.resolving = true; this.emit(entry);
    try {
      const server = await this.request(signal => this.api.get(id, signal));
      if (!this.valid(entry) || !server) return;
      if (seq !== entry.seq) {
        entry.status = 'conflict'; entry.server = server;
        entry.error = '读取服务器版本时你又编辑了文章，请重新选择；新输入仍保留。';
        this.protect(entry); return;
      }
      if (choice !== 'server' && (!entry.server || entry.server.revision !== server.revision)) {
        entry.status = 'conflict'; entry.server = server;
        entry.error = '服务器版本再次变化，已更新对照内容。请检查后重新选择。';
        this.protect(entry); return;
      }
      if (choice === 'server') {
        Object.assign(entry, { title: server.title, content: server.content, dirty: false });
      } else { entry.dirty = true; entry.seq++; }
      entry.revision = server.revision;
      entry.unverified = false; entry.isNew = false;
      entry.updated_at = server.updated_at;
      entry.status = entry.dirty ? 'pending' : 'saved'; entry.server = null; entry.error = '';
      this.protect(entry); this.emit(entry);
      if (entry.dirty) await this.flush(id);
      if (this.valid(entry) && !entry.dirty && entry.sourceDraft) {
        // Only an explicit conflict choice can discard the foreign snapshot it displayed.
        const source = entry.sourceDraft;
        if (this.storage.getItem(source.key) === source.raw) this.storage.removeItem(source.key);
        entry.sourceDraft = null;
      }
    } finally { entry.resolving = false; if (this.valid(entry)) this.emit(entry); }
  }
  async remove(id) {
    if (!this.alive || this.deletingIds.has(id)) return;
    this.deletingIds.add(id);
    let entry = this.entries.get(id);
    try {
      if (!entry) {
        const article = await this.request(signal => this.api.get(id, signal));
        if (!this.alive || !article) return;
        entry = this.entries.get(id) || this.register(article);
      }
      if (!this.valid(entry)) return;
      entry.deleting = true; clearTimeout(entry.timer); entry.controller?.abort(); this.emit(entry);
      await this.request(signal => this.api.remove(id, signal));
      if (!this.alive) return;
      this.markRemoved(id, true);
    } catch (error) {
      if (!this.alive) return;
      if (!entry) throw error;
      // A never-committed creation has no remote record to delete.
      if (error.status === 404 && entry.isNew) {
        this.markRemoved(id, true); return;
      }
      entry.deleting = false; entry.status = 'error'; entry.error = error.message;
      this.protect(entry); this.emit(entry);
      throw error;
    } finally { this.deletingIds.delete(id); }
  }
  markRemoved(id, broadcast = false) {
    if (!this.alive) return;
    const entry = this.entries.get(id);
    if (entry) { clearTimeout(entry.timer); entry.deleting = true; entry.controller?.abort(); }
    this.removedIds.add(id); this.entries.delete(id);
    let localError = '';
    try {
      const prefix = this.draftPrefix() + id;
      const keys = [];
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (key === prefix || key?.startsWith(prefix + ':')) keys.push(key);
      }
      for (const key of keys) this.storage.removeItem(key);
      if (broadcast) this.storage.setItem(this.deletedKey(id), String(Date.now()));
    } catch { localError = '文章已从服务器删除，但本地草稿清理失败，请检查浏览器存储。'; }
    this.emit({ id, removed: true, localError });
  }
  releaseSaved(id) {
    const entry = this.entries.get(id);
    if (entry && !entry.dirty && !entry.task && !entry.deleting) {
      clearTimeout(entry.timer); this.entries.delete(id);
    }
  }
  flushAll() { return Promise.all([...this.entries.keys()].map(id => this.flush(id))); }
  get hasUnsaved() { return [...this.entries.values()].some(entry => entry.dirty); }
  dispose() {
    this.alive = false;
    for (const entry of this.entries.values()) { clearTimeout(entry.timer); if (entry.dirty) this.protect(entry); }
    for (const controller of this.controllers) controller.abort();
    this.entries.clear(); this.opening.clear();
  }
}
