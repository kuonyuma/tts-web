import { renderArticleBlocks } from './article-markdown.js';

/** One native textarea inside a document of rendered blocks. Never remount it during input/IME. */
export class ArticleLiveEditor {
  constructor(viewport, { onInput, onSelection }) {
    Object.assign(this, { viewport, onInput, onSelection });
    this.content = null;
    this.active = null;
    this.cursor = { start: 0, end: 0 };
    this.undo = []; this.redo = []; this.historyGroup = null;
    this.input = document.createElement('textarea');
    this.input.className = 'article-live-input';
    this.input.placeholder = '在这里写 Markdown…';
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', '当前段落 Markdown 源码');
    this.add = document.createElement('button');
    this.add.type = 'button'; this.add.className = 'article-add-paragraph';
    this.add.textContent = '＋ 新段落';
    this.add.addEventListener('click', () => this.addParagraph());
    viewport.addEventListener('click', event => {
      if (event.target.closest('textarea, button, a') || !window.getSelection()?.isCollapsed) return;
      const block = event.target.closest('[data-source-start]');
      if (block && !this.disabled) this.activate(Number(block.dataset.sourceStart));
    });
    viewport.addEventListener('keydown', event => {
      if (event.target === this.input) return;
      if (event.key === 'Enter' && event.target.dataset.sourceStart !== undefined) {
        event.preventDefault(); this.activate(Number(event.target.dataset.sourceStart));
      }
    });
    this.input.addEventListener('compositionstart', () => { this.composing = true; this.change(true); });
    this.input.addEventListener('input', event => this.change(this.composing || event.isComposing));
    this.input.addEventListener('compositionend', () => {
      this.composing = false; this.change(false);
      this.historyGroup = null;
      if (this.pendingBlur) this.commit();
    });
    this.input.addEventListener('blur', () => {
      if (this.composing) this.pendingBlur = true;
      else this.commit();
    });
    for (const event of ['select', 'keyup', 'mouseup']) this.input.addEventListener(event, () => {
      this.rememberCursor(); this.onSelection();
    });
    this.input.addEventListener('keydown', event => this.keydown(event));
    this.input.addEventListener('beforeinput', () => this.rememberCursor());
    this.resizeObserver = new ResizeObserver(entries => {
      const width = entries[0].contentRect.width;
      if (width > 0 && width !== this.width) {
        this.width = width;
        if (this.active) this.fit(true);
      }
    });
    this.resizeObserver.observe(viewport);
  }
  setContent(content) {
    if (this.content === content) return;
    const anchor = this.anchor();
    this.content = content;
    this.undo.length = this.redo.length = 0; this.historyGroup = null;
    this.active = null;
    this.render(); this.restoreAnchor(anchor);
  }
  render() {
    this.blocks = renderArticleBlocks(this.content || '');
    const existing = new Map([...this.viewport.querySelectorAll('[data-source-start]')]
      .map(node => [Number(node.dataset.sourceStart), node]));
    const nodes = this.blocks.map(block => {
      const node = existing.get(block.start) || document.createElement('div');
      node.className = 'article-live-block'; node.tabIndex = 0;
      node.dataset.sourceStart = block.start; node.dataset.sourceEnd = block.end;
      node.setAttribute('aria-label', '编辑此段落');
      if (node.articleHtml !== block.html || node.contains(this.input)) node.innerHTML = block.html;
      node.articleHtml = block.html;
      return node;
    });
    const keep = new Set(nodes);
    for (const node of existing.values()) if (!keep.has(node)) node.remove();
    nodes.forEach((node, index) => {
      if (this.viewport.children[index] !== node) this.viewport.insertBefore(node, this.viewport.children[index] || null);
    });
    this.viewport.appendChild(this.add);
    this.onSelection();
  }
  activate(offset, selection = null) {
    if (this.disabled || this.composing) return;
    if (this.active && offset >= this.active.start && offset <= this.active.end) {
      if (selection) {
        const position = value => this.content.slice(this.active.start, value).replace(/\r\n|\r/g, '\n').length;
        this.input.setSelectionRange(position(selection.start), position(selection.end));
        this.rememberCursor();
      }
      this.input.focus({ preventScroll: true }); return;
    }
    this.commit();
    const block = this.blocks.find(part => part.start <= offset && offset <= part.end)
      || this.blocks.find(part => part.start >= offset) || this.blocks.at(-1);
    if (!block) { this.addParagraph(); return; }
    const node = this.viewport.querySelector(`[data-source-start="${block.start}"]`);
    this.begin(block, node, selection);
    if (!this.viewport.hidden) node.scrollIntoView({ block: 'nearest' });
  }
  begin(block, node, selection = null) {
    const scroll = this.viewport.scrollTop;
    this.active = { start: block.start, end: block.end, node,
      newline: this.content.slice(block.start, block.end).match(/\r\n|\r|\n/)?.[0]
        || this.content.match(/\r\n|\r|\n/)?.[0] || '\n' };
    this.input.value = this.content.slice(block.start, block.end);
    node.classList.add('article-live-active'); node.tabIndex = -1;
    node.replaceChildren(this.input);
    this.fit();
    this.input.focus({ preventScroll: true });
    const position = value => this.content.slice(block.start, Math.max(block.start, value)).replace(/\r\n|\r/g, '\n').length;
    const start = selection ? position(selection.start) : this.input.value.length;
    this.input.setSelectionRange(start, selection ? position(selection.end) : start);
    this.viewport.scrollTop = scroll;
    this.rememberCursor(); this.onSelection();
  }
  fit(followCaret = false) {
    if (!this.active) return;
    const scroll = this.viewport.scrollTop;
    this.input.style.height = 'auto';
    this.input.style.height = `${this.input.scrollHeight + 2}px`;
    this.viewport.scrollTop = scroll;
    if (followCaret) this.ensureCaret();
  }
  ensureCaret() {
    if (document.activeElement !== this.input || !this.viewport.clientHeight) return;
    const style = getComputedStyle(this.input), mirror = document.createElement('div');
    for (const key of ['font', 'lineHeight', 'letterSpacing', 'whiteSpace', 'overflowWrap', 'wordBreak', 'tabSize', 'padding']) mirror.style[key] = style[key];
    Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', pointerEvents: 'none',
      width: `${this.input.clientWidth}px`, boxSizing: 'border-box', top: '0', left: '0' });
    mirror.textContent = this.input.value.slice(0, this.input.selectionEnd);
    const marker = document.createElement('span'); marker.textContent = '\u200b'; mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const top = this.input.getBoundingClientRect().top + marker.getBoundingClientRect().top - mirror.getBoundingClientRect().top;
    const bottom = top + (Number.parseFloat(style.lineHeight) || marker.getBoundingClientRect().height);
    const viewport = this.viewport.getBoundingClientRect();
    mirror.remove();
    if (bottom > viewport.bottom - 8) this.viewport.scrollTop += bottom - viewport.bottom + 8;
    else if (top < viewport.top + 8) this.viewport.scrollTop -= viewport.top + 8 - top;
  }
  rememberCursor() {
    if (!this.active) return;
    const offset = value => this.active.start + this.input.value.slice(0, value).replace(/\n/g, this.active.newline).length;
    this.cursor = { start: offset(this.input.selectionStart), end: offset(this.input.selectionEnd) };
  }
  change(composing) {
    if (!this.active) return;
    const value = this.input.value.replace(/\n/g, this.active.newline);
    const previousEnd = this.active.end, delta = value.length - (previousEnd - this.active.start);
    const content = this.content.slice(0, this.active.start) + value + this.content.slice(previousEnd);
    this.recordHistory(content, composing);
    this.content = content;
    this.active.end += delta;
    for (const node of this.viewport.querySelectorAll('[data-source-start]')) {
      if (node === this.active.node) node.dataset.sourceEnd = this.active.end;
      else if (Number(node.dataset.sourceStart) >= previousEnd) {
        node.dataset.sourceStart = Number(node.dataset.sourceStart) + delta;
        node.dataset.sourceEnd = Number(node.dataset.sourceEnd) + delta;
      }
    }
    this.fit(true); this.rememberCursor();
    if (this.historyGroup) this.historyGroup.cursor = this.cursor;
    this.onInput(this.content, composing); this.onSelection();
  }
  commit() {
    if (!this.active || this.composing) return;
    this.rememberCursor();
    const anchor = this.anchor();
    this.active = null; this.pendingBlur = false;
    this.historyGroup = null;
    this.render(); this.restoreAnchor(anchor);
  }
  addParagraph() {
    if (this.disabled || this.composing) return;
    this.commit();
    const newline = this.content.match(/\r\n|\r|\n/)?.[0] || '\n';
    const normalized = this.content.replace(/\r\n|\r/g, '\n');
    if (normalized && !normalized.endsWith('\n\n')) {
      const content = this.content + (normalized.endsWith('\n') ? newline : newline + newline);
      this.recordHistory(content, false); this.content = content;
    }
    const start = this.content.length, node = document.createElement('div');
    node.className = 'article-live-block'; node.dataset.sourceStart = start; node.dataset.sourceEnd = start;
    this.viewport.insertBefore(node, this.add);
    this.begin({ start, end: start }, node);
    this.onInput(this.content, false);
    node.scrollIntoView({ block: 'nearest' });
  }
  keydown(event) {
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && (key === 'z' || key === 'y') && !event.isComposing && !this.composing) {
      event.preventDefault(); this.restoreHistory(key === 'y' || event.shiftKey); return;
    }
    if (event.isComposing || this.composing || !this.active || this.input.selectionStart !== this.input.selectionEnd) return;
    const start = this.input.selectionStart === 0, end = this.input.selectionEnd === this.input.value.length;
    if ((event.key === 'ArrowUp' && start) || (event.key === 'ArrowDown' && end)) {
      event.preventDefault();
      const offset = this.active.start;
      this.commit();
      const index = this.blocks.findIndex(block => block.start <= offset && block.end >= offset);
      const next = this.blocks[index + (start && event.key === 'ArrowUp' ? -1 : 1)];
      if (next) {
        const position = event.key === 'ArrowUp' ? next.end : next.start;
        this.activate(next.start, { start: position, end: position });
        this.active.node.scrollIntoView({ block: 'nearest' });
      } else this.activate(offset, this.cursor);
    }
  }
  recordHistory(content, composing) {
    if (content === this.content) return;
    const group = this.historyGroup, now = Date.now();
    if (!group || group.block !== this.active?.start || (!group.composing && now - group.time > 800)
      || group.cursor.start !== this.cursor.start || group.cursor.end !== this.cursor.end) {
      this.undo.push({ content: this.content, cursor: { ...this.cursor } });
      if (this.undo.length > 50) this.undo.shift();
    }
    this.historyGroup = { block: this.active?.start, time: now, composing, cursor: this.cursor };
    this.redo.length = 0;
  }
  restoreHistory(forward) {
    const from = forward ? this.redo : this.undo, to = forward ? this.undo : this.redo;
    if (!from.length || this.disabled) return;
    this.rememberCursor();
    to.push({ content: this.content, cursor: { ...this.cursor } });
    const saved = from.pop();
    this.commit(); this.content = saved.content; this.cursor = saved.cursor;
    this.render(); this.activate(saved.cursor.start, saved.cursor);
    this.onInput(this.content, false);
  }
  anchor() {
    const top = this.viewport.getBoundingClientRect().top + this.viewport.clientTop;
    const nodes = [...this.viewport.querySelectorAll('[data-source-start]')];
    const node = nodes.find(part => part.getBoundingClientRect().bottom > top + 1) || nodes.at(-1);
    return node ? { offset: Number(node.dataset.sourceStart), top: node.getBoundingClientRect().top - top } : null;
  }
  restoreAnchor(anchor) {
    if (!anchor || this.viewport.hidden) return;
    const nodes = [...this.viewport.querySelectorAll('[data-source-start]')];
    const node = nodes.find(part => Number(part.dataset.sourceEnd) >= anchor.offset) || nodes.at(-1);
    if (node) this.viewport.scrollTop += node.getBoundingClientRect().top
      - this.viewport.getBoundingClientRect().top - this.viewport.clientTop - anchor.top;
  }
  selectedText() {
    if (this.active && document.activeElement === this.input) return this.input.value.slice(this.input.selectionStart, this.input.selectionEnd);
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return '';
    const range = selection.getRangeAt(0);
    return this.viewport.contains(range.startContainer) && this.viewport.contains(range.endContainer) ? selection.toString() : '';
  }
  setDisabled(disabled) {
    this.disabled = disabled; this.input.disabled = disabled; this.add.disabled = disabled;
  }
  dispose() { this.resizeObserver.disconnect(); }
}
