import { escapeHtml } from './api.js';
import { renderArticleBlocks } from './article-markdown.js';
import { ArticleEditor } from './article-editor.js';

const statusNames = { pending: '等待保存', saving: '保存中…', saved: '已保存', error: '保存失败', conflict: '版本冲突 · 草稿已保留' };
const dateLabel = value => new Date(value).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });

/** Plain text only, with strict UTF-8 decoding and no newline normalization. */
export async function readArticleFile(file) {
  if (!/\.(txt|md)$/i.test(file.name)) throw new Error(`${file.name}：只支持 .txt 和 .md 文件。`);
  if (file.size > 2 * 1024 * 1024) throw new Error(`${file.name}：文件超过 2 MiB，请拆分后导入。`);
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error(`${file.name}：读取失败或不是有效的 UTF-8 编码，请转换为 UTF-8 后重试。`); }
  if (Array.from(content).length > 500000) throw new Error(`${file.name}：正文超过 500,000 字，请拆分后导入。`);
  const title = file.name.replace(/\.(txt|md)$/i, '') || '未命名文章';
  if (Array.from(title).length > 200) throw new Error(`${file.name}：文件名超过 200 字，请缩短后导入。`);
  return { title, content };
}

export class ArticleViews {
  constructor({ state, library, editors, open, activateLibrary, fillInput, notify, onViewChange = () => {} }) {
    Object.assign(this, { state, library, editors, open, activateLibrary, fillInput, notify, onViewChange });
    this.nodes = new Map();
    this.rows = [];
    this.searchVersion = 0;
    this.selectionChanged = () => this.updateSelections();
    document.addEventListener('selectionchange', this.selectionChanged);
    this.renderLibrary();
  }
  run(action) { Promise.resolve().then(action).catch(error => { if (this.state?.alive) this.notify(error.message); }); }
  renderLibrary() {
    this.library.innerHTML = `<div class="article-library-heading"><span class="eyebrow">YOUR READING SHELF</span><h2>账号文章库</h2><p>保存原文，随时回来继续阅读。</p></div>
      ${this.state ? `<div class="article-library-actions"><button id="newArticleBtn" class="article-primary">＋ 新建文章</button><button id="importArticleBtn">导入文件</button><input id="articleFileInput" type="file" accept=".txt,.md,text/plain,text/markdown" multiple hidden></div>
      <label class="article-search"><span class="sr-only">搜索标题或正文</span><input id="articleSearch" type="search" placeholder="搜索标题或正文…" maxlength="200"></label>
      <div class="article-list-caption"><span id="articleCount">正在读取…</span><button id="refreshArticlesBtn" aria-label="刷新文章库">↻ 刷新</button></div>
      <div id="articleList" class="article-list"></div><p class="article-library-note">文章属于当前登录账号 · 自动保存<br>.txt / .md 按 UTF-8 纯文本导入</p>`
      : `<div class="article-empty"><p>登录后即可保存文章，并在其他设备读取。</p><a class="article-primary" href="account.html#login">登录 / 注册</a></div>`}`;
    if (!this.state) return;
    this.library.querySelector('#newArticleBtn').addEventListener('click', event => this.run(async () => {
      const button = this.library.querySelector('#newArticleBtn');
      button.disabled = true;
      try { const entry = this.state.create(); await this.open(entry.id); await this.state.flush(entry.id); }
      finally { button.disabled = false; }
    }));
    const picker = this.library.querySelector('#articleFileInput');
    this.library.querySelector('#importArticleBtn').addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => this.run(async () => {
      const files = [...picker.files]; picker.value = '';
      const button = this.library.querySelector('#importArticleBtn'); button.disabled = true;
      const errors = [];
      try {
        for (const file of files) {
          if (!this.state.alive) break;
          try {
            const data = await readArticleFile(file);
            if (!this.state.alive) break;
            const entry = this.state.create(data.title, data.content);
            await this.open(entry.id); await this.state.flush(entry.id);
          } catch (error) { errors.push(error.message); }
        }
      } finally { button.disabled = false; }
      if (errors.length) this.notify(errors.join('\n'));
    }));
    this.library.querySelector('#articleSearch').addEventListener('input', () => {
      clearTimeout(this.searchTimer);
      this.searchVersion++;
      this.searchTimer = setTimeout(() => this.run(() => this.refresh()), 200);
    });
    this.library.querySelector('#refreshArticlesBtn').addEventListener('click', () => this.run(() => this.refresh()));
    this.library.querySelector('#articleList').addEventListener('click', event => {
      const button = event.target.closest('button');
      if (button?.dataset.articleOpen) this.run(() => this.open(button.dataset.articleOpen));
      if (button?.dataset.articleRename) this.run(async () => {
        await this.open(button.dataset.articleRename);
        const title = this.nodes.get(button.dataset.articleRename)?.querySelector('.article-title-input');
        title?.focus(); title?.select();
      });
      if (button?.dataset.articleDelete) this.run(() => this.remove(button.dataset.articleDelete));
    });
  }
  async refresh() {
    if (!this.state?.alive) return;
    const version = ++this.searchVersion;
    const query = this.library.querySelector('#articleSearch').value;
    const rows = await this.state.list(query);
    if (!this.state.alive || version !== this.searchVersion || !rows) return;
    this.rows = rows;
    this.renderRows();
  }
  renderRows() {
    if (!this.state?.alive) return;
    const query = this.library.querySelector('#articleSearch').value.toLocaleLowerCase();
    const rows = new Map(this.rows.map(row => [row.id, row]));
    for (const entry of this.state.entries.values()) {
      if (!entry.deleting && (entry.dirty || rows.has(entry.id))) rows.set(entry.id, entry);
    }
    const filtered = [...rows.values()].filter(row => !query || `${row.title}\n${row.content || ''}`.toLocaleLowerCase().includes(query)
      || this.rows.some(server => server.id === row.id));
    this.library.querySelector('#articleCount').textContent = `${filtered.length} 篇文章`;
    this.library.querySelector('#articleList').innerHTML = filtered.length ? filtered.map(row => `
      <article class="article-row"><button class="article-open" data-article-open="${escapeHtml(row.id)}"><strong>${escapeHtml(row.title || '未命名文章')}</strong><span>${row.content === undefined ? row.character_count : Array.from(row.content).length} 字 · ${escapeHtml(dateLabel(row.created_at))}</span>${row.dirty ? `<small>${escapeHtml(statusNames[row.status] || '本地草稿')}</small>` : ''}</button>
      <div class="article-row-actions"><button data-article-rename="${escapeHtml(row.id)}" aria-label="重命名 ${escapeHtml(row.title)}">重命名</button><button data-article-delete="${escapeHtml(row.id)}" aria-label="删除 ${escapeHtml(row.title)}">删除</button></div></article>`).join('')
      : '<div class="article-empty"><p>暂无匹配文章</p><small>新建文章，或导入一份日文原文。</small></div>';
  }
  mount(entry, savedView = null) {
    if (this.nodes.has(entry.id)) return this.nodes.get(entry.id);
    const node = document.createElement('section');
    node.id = `article-panel-${entry.id}`;
    node.className = 'article-editor workspace-panel';
    node.setAttribute('role', 'tabpanel');
    node.setAttribute('aria-labelledby', `tab-${entry.id}`);
    node.hidden = true;
    const legacyScroll = typeof savedView === 'number' ? savedView : 0;
    node.articleView = {
      mode: ['read', 'live', 'edit'].includes(savedView?.mode) ? savedView.mode : entry.content ? 'read' : 'live',
      readScroll: Number(savedView?.readScroll) || 0,
      editScroll: Number(savedView?.editScroll) || legacyScroll,
      liveScroll: Number(savedView?.liveScroll) || 0,
      liveAnchor: savedView?.liveAnchor || null,
      editAnchor: savedView?.editAnchor || null,
      selection: savedView?.selection || { anchor: savedView?.liveCursor?.start || 0, head: savedView?.liveCursor?.end || 0 },
      renderedText: null,
    };
    node.innerHTML = `<div class="article-editor-toolbar"><button class="article-back">‹ 文章库</button><div class="article-editor-actions"><button class="article-rename">重命名</button><button class="article-delete">删除</button></div></div>
      <label class="sr-only" for="title-${entry.id}">文章标题</label><input id="title-${entry.id}" class="article-title-input" placeholder="未命名文章" maxlength="200" autocomplete="off">
      <div class="article-save-line"><span class="article-save-state" role="status"></span><span class="article-character-count"></span></div>
      <div class="article-save-error" role="alert" hidden><p></p><button class="article-retry">重试保存</button></div>
      <div class="article-conflict" hidden><p>服务器已有更新。当前编辑区保留你的草稿；选择后才会继续保存。</p><details><summary>查看服务器版本</summary><strong class="article-server-title"></strong><pre class="article-server-content"></pre></details><div><button class="article-use-server">使用服务器版本</button><button class="article-keep-draft">保留本地并保存</button></div></div>
      <div class="article-mode-switch" role="group" aria-label="文章视图"><button class="article-mode-read" type="button">阅读</button><button class="article-mode-live" type="button">实时预览</button><button class="article-mode-edit" type="button">编辑源码</button></div>
      <div id="body-${entry.id}" class="article-body article-code-editor" aria-label="文章 Markdown 编辑器"></div>
      <div class="article-preview" tabindex="0" role="document" aria-label="文章阅读正文"></div>
      <div class="article-selection-bar"><button class="article-fill" disabled>选中文字 → 语音输入</button><small>填入后，由你点击发送</small></div>`;
    const title = node.querySelector('.article-title-input');
    title.value = entry.title;
    for (const [input, field] of [[title, 'title']]) {
      input.addEventListener('compositionstart', () => this.state.edit(entry.id, { [field]: input.value }, true));
      input.addEventListener('input', event => this.state.edit(entry.id, { [field]: input.value }, event.isComposing));
      input.addEventListener('compositionend', () => this.state.edit(entry.id, { [field]: input.value }));
    }
    node.querySelector('.article-back').addEventListener('click', this.activateLibrary);
    node.querySelector('.article-mode-read').addEventListener('click', () => { this.setMode(entry.id, 'read'); this.run(() => this.state.flush(entry.id)); });
    node.querySelector('.article-mode-edit').addEventListener('click', () => this.setMode(entry.id, 'edit'));
    node.querySelector('.article-mode-live').addEventListener('click', () => this.setMode(entry.id, 'live'));
    node.querySelector('.article-rename').addEventListener('click', () => { title.focus(); title.select(); });
    node.querySelector('.article-delete').addEventListener('click', () => this.run(() => this.remove(entry.id)));
    node.querySelector('.article-retry').addEventListener('click', () => this.run(() => this.state.flush(entry.id)));
    node.querySelector('.article-use-server').addEventListener('click', () => this.run(() => this.state.resolve(entry.id, 'server')));
    node.querySelector('.article-keep-draft').addEventListener('click', () => {
      if (confirm('用本地草稿覆盖刚读取的服务器版本？另一设备的修改可能会被替换。')) this.run(() => this.state.resolve(entry.id, 'local'));
    });
    const fill = node.querySelector('.article-fill');
    const updateSelection = () => { fill.disabled = !this.selectedText(node); };
    node.articleEditor = new ArticleEditor(node.querySelector('.article-code-editor'), {
      content: entry.content, selection: node.articleView.selection,
      onInput: (content, composing) => this.state.edit(entry.id, { content }, composing),
      onSelection: () => {
        updateSelection();
        this.captureViewState(entry.id); this.onViewChange();
      },
      onScroll: () => { this.captureViewState(entry.id); this.onViewChange(); },
    });
    fill.addEventListener('pointerdown', event => event.preventDefault());
    fill.addEventListener('click', () => {
      const text = this.selectedText(node);
      if (!text) { this.notify('请先在文章正文中选中文字。'); return; }
      this.fillInput(text);
    });
    this.nodes.set(entry.id, node); this.editors.appendChild(node);
    for (const viewport of node.querySelectorAll('.article-preview')) {
      viewport.addEventListener('scroll', () => { this.captureViewState(entry.id); this.onViewChange(); }, { passive: true });
    }
    this.applyMode(node);
    this.update(entry);
    return node;
  }
  selectedText(node) {
    if (node.hidden) return '';
    if (node.articleView.mode !== 'read') return node.articleEditor.selectedText();
    const preview = node.querySelector('.article-preview');
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return '';
    const range = selection.getRangeAt(0);
    return preview.contains(range.startContainer) && preview.contains(range.endContainer) ? selection.toString() : '';
  }
  updateSelections() {
    for (const node of this.nodes.values()) node.querySelector('.article-fill').disabled = !this.selectedText(node);
  }
  captureViewState(id) {
    const node = this.nodes.get(id);
    if (!node) return null;
    const view = node.articleView;
    if (!node.hidden) {
      const viewport = this.viewport(node);
      if (!node.articleEditor.restoring || view.mode === 'read') view[`${view.mode}Scroll`] = viewport.scrollTop;
      view.selection = node.articleEditor.selection;
      if (view.mode !== 'read' && !node.articleEditor.restoring) view[`${view.mode}Anchor`] = node.articleEditor.anchor(false);
    }
    return { mode: view.mode, readScroll: view.readScroll, editScroll: view.editScroll,
      liveScroll: view.liveScroll, liveAnchor: view.liveAnchor, editAnchor: view.editAnchor, selection: view.selection };
  }
  viewport(node) {
    return node.articleView.mode === 'read' ? node.querySelector('.article-preview') : node.articleEditor.scrollDOM;
  }
  restoreScroll(id, resume = false) {
    const node = this.nodes.get(id);
    if (!node || node.hidden) return;
    const view = node.articleView;
    if (view.mode === 'read') this.viewport(node).scrollTop = view.readScroll;
    else if (resume) node.articleEditor.restoreScroll(view[`${view.mode}Scroll`], view[`${view.mode}Anchor`]);
  }
  renderPreview(node) {
    const entry = this.state.entries.get(node.id.slice('article-panel-'.length));
    if (!entry || node.articleView.renderedText === entry.content) return;
    node.querySelector('.article-preview').innerHTML = entry.content
      ? renderArticleBlocks(entry.content).map(block => `<div class="article-reading-block" data-source-start="${block.start}" data-source-end="${block.end}">${block.html}</div>`).join('')
      : '<p class="article-reading-empty">还没有正文，点击“实时预览”开始写作。</p>';
    node.articleView.renderedText = entry.content;
    this.updateSelections();
  }
  applyMode(node) {
    const reading = node.articleView.mode === 'read';
    const live = node.articleView.mode === 'live';
    node.querySelector('.article-body').hidden = reading;
    node.querySelector('.article-preview').hidden = !reading;
    node.querySelector('.article-mode-read').setAttribute('aria-pressed', String(reading));
    node.querySelector('.article-mode-live').setAttribute('aria-pressed', String(live));
    node.querySelector('.article-mode-edit').setAttribute('aria-pressed', String(!reading && !live));
    node.articleEditor.setMode(live ? 'live' : 'edit');
    if (reading) this.renderPreview(node);
  }
  setMode(id, mode) {
    const node = this.nodes.get(id);
    if (!node || node.articleView.mode === mode) return;
    if (node.articleEditor.composing || this.state.entries.get(id)?.composing) return;
    this.captureViewState(id);
    const previous = node.articleView.mode;
    const anchor = previous === 'read' ? this.documentAnchor(node) : node.articleEditor.anchor();
    node.articleView.mode = mode;
    this.applyMode(node);
    if (mode === 'read') {
      this.restoreScroll(id);
      this.restoreDocumentAnchor(node, anchor);
    } else if (previous === 'read') {
      node.articleEditor.restoreScroll(node.articleView[`${mode}Scroll`], node.articleView[`${mode}Anchor`]);
    } else node.articleEditor.restoreAnchor(anchor);
    this.captureViewState(id); this.updateSelections(); this.onViewChange();
  }
  documentAnchor(node) {
    const viewport = this.viewport(node), top = viewport.getBoundingClientRect().top + viewport.clientTop;
    const blocks = [...viewport.querySelectorAll('[data-source-start]')];
    const block = blocks.find(part => part.getBoundingClientRect().bottom > top + 1) || blocks.at(-1);
    return block ? { offset: Number(block.dataset.sourceStart), top: block.getBoundingClientRect().top - top } : null;
  }
  restoreDocumentAnchor(node, anchor) {
    const viewport = this.viewport(node), blocks = [...viewport.querySelectorAll('[data-source-start]')];
    const block = blocks.find(part => Number(part.dataset.sourceEnd) >= anchor.offset) || blocks.at(-1);
    if (block) viewport.scrollTop += block.getBoundingClientRect().top - viewport.getBoundingClientRect().top - viewport.clientTop - anchor.top;
  }
  update(entry) {
    if (entry.status === 'saved' && !entry.dirty) {
      // Keep acknowledged summaries after a new article stops being a draft,
      // and after closing releases its editing state from ArticleState.
      const index = this.rows.findIndex(row => row.id === entry.id);
      const query = this.library.querySelector('#articleSearch').value.toLocaleLowerCase();
      if (index >= 0 || `${entry.title}\n${entry.content}`.toLocaleLowerCase().includes(query)) {
        const row = { id: entry.id, title: entry.title, character_count: Array.from(entry.content).length,
          created_at: entry.created_at, updated_at: entry.updated_at, revision: entry.revision };
        if (index >= 0) this.rows[index] = row;
        else this.rows.unshift(row);
      }
    }
    if (entry.removed) {
      this.searchVersion++;
      this.nodes.get(entry.id)?.articleEditor.dispose();
      this.nodes.get(entry.id)?.remove(); this.nodes.delete(entry.id);
      this.rows = this.rows.filter(row => row.id !== entry.id); this.renderRows(); return;
    }
    const node = this.nodes.get(entry.id);
    if (node) {
      // Do not replace editor DOM or assign equal values: selection and scroll must survive saves.
      const title = node.querySelector('.article-title-input');
      if (title.value !== entry.title) title.value = entry.title;
      node.articleEditor.setContent(entry.content);
      if (node.articleView.mode === 'read') this.renderPreview(node);
      title.disabled = entry.deleting;
      node.articleEditor.setDisabled(entry.deleting);
      const status = node.querySelector('.article-save-state');
      status.textContent = entry.deleting ? '正在删除…' : entry.composing ? '输入中 · 草稿已保护' : statusNames[entry.status];
      status.dataset.status = entry.status;
      node.querySelector('.article-character-count').textContent = `${Array.from(entry.content).length} 字`;
      const error = node.querySelector('.article-save-error');
      error.hidden = !entry.localError && !entry.error;
      error.querySelector('p').textContent = [entry.error, entry.localError].filter(Boolean).join(' · ');
      node.querySelector('.article-conflict').hidden = entry.status !== 'conflict';
      for (const button of node.querySelectorAll('.article-use-server, .article-keep-draft')) button.disabled = !!entry.resolving;
      node.querySelector('.article-server-title').textContent = entry.server?.title || '';
      node.querySelector('.article-server-content').textContent = entry.server?.content || '服务器版本暂时无法读取，请重试选择。';
    }
    this.renderRows();
  }
  async remove(id) {
    const title = this.state.entries.get(id)?.title || this.rows.find(row => row.id === id)?.title || '这篇文章';
    if (!confirm(`删除「${title}」？文章将从账号文章库删除，此操作无法撤销。`)) return;
    await this.state.remove(id);
  }
  dispose() {
    clearTimeout(this.searchTimer); document.removeEventListener('selectionchange', this.selectionChanged);
    for (const node of this.nodes.values()) node.articleEditor.dispose();
    this.nodes.clear(); this.editors.replaceChildren(); this.library.replaceChildren();
  }
}
