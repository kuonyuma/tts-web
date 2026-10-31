import { apiFetch, getClientId, handleResponseError, escapeHtml, getCopilotRequestTimeoutMs } from './api.js';
import { getSelectedEngine, getSelectedVoice, getApiKey, getMaxCharCount } from './settings.js';
import { getExplainConfig } from './copilot.js';
import { registerExternalAudio, pauseAllPlayers } from './message-player.js';

async function readVocabResponse(response, fallback) {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(typeof data?.detail === 'string' ? data.detail : fallback);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

export class VocabStore {
  constructor({ accountId = null, storage = localStorage } = {}) {
    this.accountId = accountId;
    this.storage = storage;
    this.storageKey = `tts_vocab_v1:${accountId ? `account_${accountId}` : 'guest'}`;
    this.items = [];
    this.listeners = new Set();
    this.loadLocal();
  }

  loadLocal() {
    try {
      const parsed = JSON.parse(this.storage.getItem(this.storageKey) || '[]');
      if (Array.isArray(parsed)) this.items = parsed;
    } catch {
      this.items = [];
    }
  }

  saveLocal() {
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.items));
    } catch {
      // Ignore quota errors on local mirror
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.saveLocal();
    for (const fn of this.listeners) fn(this.items);
  }

  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.accountId) h['X-Article-Account'] = String(this.accountId);
    return h;
  }

  async syncFromServer() {
    if (!this.accountId) return this.items;
    try {
      const res = await apiFetch('/api/vocab', { headers: this.headers() }, 12000);
      if (!res.ok) return this.items;
      const data = await res.json();
      if (Array.isArray(data)) {
        this.items = data;
        this.emit();
      }
    } catch {
      // Retain local mirror on offline/network error
    }
    return this.items;
  }

  list({ query = '', status = 'all' } = {}) {
    const q = (query || '').trim().toLowerCase();
    return this.items.filter(item => {
      if (status === 'mastered' && !item.mastered) return false;
      if (status === 'unmastered' && item.mastered) return false;
      if (!q) return true;
      const hay = `${item.word || ''}\n${item.surface || ''}\n${item.reading || ''}\n${item.meaning || ''}\n${item.notes || ''}\n${item.context_sentence || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  findByWord(word) {
    if (!word) return null;
    const target = word.trim().toLowerCase();
    return this.items.find(item => item.word.toLowerCase() === target || item.surface?.toLowerCase() === target) || null;
  }

  get(id) {
    return this.items.find(item => item.id === id) || null;
  }

  async upsert(payload) {
    const word = String(payload.word || '').trim();
    if (!word) throw new Error('词条不能为空。');
    const clean = {
      word: word.slice(0, 100),
      surface: String(payload.surface || '').trim().slice(0, 100),
      reading: String(payload.reading || '').trim().slice(0, 120),
      pos: String(payload.pos || '').trim().slice(0, 60),
      meaning: String(payload.meaning || '').trim().slice(0, 1000),
      notes: String(payload.notes || '').trim().slice(0, 1000),
      context_sentence: String(payload.context_sentence || '').trim().slice(0, 1000),
      source_article_id: payload.source_article_id || null,
      source_title: String(payload.source_title || '').trim().slice(0, 200),
      mastered: Boolean(payload.mastered),
    };

    if (this.accountId) {
      const res = await apiFetch('/api/vocab', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(clean),
      }, 12000);
      const saved = await readVocabResponse(res, '保存生词失败，请重试。');
      const idx = this.items.findIndex(i => i.id === saved.id || i.word.toLowerCase() === saved.word.toLowerCase());
      if (idx >= 0) this.items[idx] = saved;
      else this.items.unshift(saved);
      this.emit();
      return saved;
    }

    const now = new Date().toISOString();
    const existingIdx = this.items.findIndex(i => i.word.toLowerCase() === clean.word.toLowerCase());
    if (existingIdx >= 0) {
      const prev = this.items[existingIdx];
      const updated = {
        ...prev,
        word: clean.word,
        surface: clean.surface || prev.surface || '',
        reading: clean.reading || prev.reading,
        pos: clean.pos || prev.pos,
        meaning: clean.meaning || prev.meaning,
        notes: clean.notes || prev.notes,
        context_sentence: clean.context_sentence || prev.context_sentence,
        source_article_id: clean.source_article_id ?? prev.source_article_id,
        source_title: clean.source_title || prev.source_title,
        mastered: clean.mastered || prev.mastered,
        updated_at: now,
      };
      this.items[existingIdx] = updated;
      this.emit();
      return updated;
    }

    const created = {
      id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'v_' + Date.now(),
      ...clean,
      review_count: 0,
      created_at: now,
      updated_at: now,
    };
    this.items.unshift(created);
    this.emit();
    return created;
  }

  async update(id, patch) {
    const idx = this.items.findIndex(i => i.id === id);
    if (idx < 0) return null;

    if (this.accountId) {
      const res = await apiFetch(`/api/vocab/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify(patch),
      }, 12000);
      const saved = await readVocabResponse(res, '更新生词失败，请重试。');
      // Other requests may have inserted or removed rows while this request ran.
      const currentIdx = this.items.findIndex(i => i.id === id);
      if (currentIdx >= 0) {
        this.items[currentIdx] = saved;
        this.emit();
      }
      return saved;
    }

    const prev = this.items[idx];
    const updated = {
      ...prev,
      ...(patch.word !== undefined ? { word: patch.word } : {}),
      ...(patch.surface !== undefined ? { surface: patch.surface } : {}),
      ...(patch.reading !== undefined ? { reading: patch.reading } : {}),
      ...(patch.pos !== undefined ? { pos: patch.pos } : {}),
      ...(patch.meaning !== undefined ? { meaning: patch.meaning } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.mastered !== undefined ? { mastered: Boolean(patch.mastered) } : {}),
      review_count: (prev.review_count || 0) + (Number(patch.review_delta) || 0),
      updated_at: new Date().toISOString(),
    };
    this.items[idx] = updated;
    this.emit();
    return updated;
  }

  async remove(id) {
    if (this.accountId) {
      const res = await apiFetch(`/api/vocab/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: this.headers(),
      }, 12000);
      // A record already deleted in another tab is also successfully removed.
      if (res.status !== 404) await readVocabResponse(res, '删除生词失败，请重试。');
    }
    this.items = this.items.filter(i => i.id !== id);
    this.emit();
  }
}

/** Shared quick audio player for speaking words or context sentences in Popover / Vocab list. */
class QuickAudioSpeaker {
  constructor() {
    this.audio = document.createElement('audio');
    this.audio.preload = 'auto';
    this.url = null;
    this.cache = new Map();
    this.speakGen = 0;
    this.controller = null;
    this.unregister = registerExternalAudio(this.audio);
    this.audio.addEventListener('play', () => pauseAllPlayers(this.audio));
  }

  async speak(text, onError = null) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    if (Array.from(trimmed).length > getMaxCharCount()) {
      onError?.(`文本超过 ${getMaxCharCount()} 字，未生成语音。请拆分后重试。`);
      return;
    }
    const gen = ++this.speakGen;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;

    const engine = getSelectedEngine();
    const voice = getSelectedVoice() || '';
    const sig = `${engine}|${voice}|${trimmed}`;
    try {
      let blob = this.cache.get(sig);
      if (!blob) {
        const headers = { 'Content-Type': 'application/json', 'X-Client-ID': getClientId() };
        const key = getApiKey();
        if (engine === 'gemini' && key) headers['X-Gemini-Api-Key'] = key;
        const res = await apiFetch('/api/tts', {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({ text: trimmed, engine, voice: voice || null }),
        });
        if (!res.ok) await handleResponseError(res);
        blob = await res.blob();
        if (this.cache.size >= 40) {
          this.cache.delete(this.cache.keys().next().value);
        }
        this.cache.set(sig, blob);
      }
      if (gen !== this.speakGen) return;
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = URL.createObjectURL(blob);
      this.audio.src = this.url;
      await this.audio.play().catch(() => {});
    } catch (err) {
      if (gen !== this.speakGen || controller.signal.aborted) return;
      onError?.(err.message || '语音播放失败');
    }
  }

  dispose() {
    this.speakGen += 1;
    this.controller?.abort();
    this.audio.pause();
    this.unregister?.();
    if (this.url) URL.revokeObjectURL(this.url);
  }
}

export const quickSpeaker = new QuickAudioSpeaker();

/**
 * Flash-scrolls to a target word inside an opened article's `.article-preview`
 * (Read in Levels `animate-word-flash` pattern).
 */
export function flashWordInArticlePreview(previewEl, word) {
  if (!previewEl || !word) return false;
  const lower = word.trim().toLowerCase();
  const marks = [...previewEl.querySelectorAll('mark.article-vocab-highlight')].filter(
    el => (el.dataset.vocabWord || el.textContent || '').trim().toLowerCase() === lower
  );
  const targets = marks.length
    ? marks
    : [...previewEl.querySelectorAll('.article-sentence')].filter(el => el.textContent.toLowerCase().includes(lower));
  if (!targets.length) return false;

  targets[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  targets.forEach(el => {
    el.classList.remove('animate-word-flash');
    void el.offsetWidth;
    el.classList.add('animate-word-flash');
  });
  setTimeout(() => {
    targets.forEach(el => el.classList.remove('animate-word-flash'));
  }, 4500);
  return true;
}

/**
 * Floating Popover for Instant Word Lookup & Vocabulary Saving (Read in Levels `InlineGlossaryPopover` style).
 */
export class InlineWordPopover {
  constructor({ store, notify }) {
    this.store = store;
    this.notify = notify;
    this.lookupAbort = null;
    this.currentContext = null;

    this.el = document.createElement('div');
    this.el.className = 'vocab-inline-popover';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', '词条速查与生词卡');
    this.el.hidden = true;
    document.body.appendChild(this.el);

    this.onDocMouseDown = event => {
      if (this.el.hidden) return;
      if (!this.el.contains(event.target) && !event.target.closest('.article-vocab-lookup-btn, mark.article-vocab-highlight')) {
        this.close();
      }
    };
    this.onDocKeyDown = event => {
      if (!this.el.hidden && event.key === 'Escape') {
        event.stopPropagation();
        this.close();
      }
    };
    document.addEventListener('mousedown', this.onDocMouseDown);
    document.addEventListener('keydown', this.onDocKeyDown);
  }

  open({ word, sentence = '', articleId = null, articleTitle = '', anchorRect = null, vocabId = null, onPlaySentence = null }) {
    const cleanWord = String(word || '').trim().slice(0, 100);
    if (!cleanWord) return;
    this.lookupAbort?.abort();

    const saved = (vocabId && this.store.get(vocabId)) || this.store.findByWord(cleanWord);
    this.currentContext = {
      word: saved?.word || cleanWord,
      surface: cleanWord,
      reading: saved?.reading || '',
      pos: saved?.pos || '',
      meaning: saved?.meaning || '',
      notes: saved?.notes || '',
      sentence: saved?.context_sentence || String(sentence || '').trim().slice(0, 1000),
      articleId: saved?.source_article_id ?? articleId,
      articleTitle: saved?.source_title || articleTitle || '',
      savedId: saved?.id || null,
      loading: !saved,
      onPlaySentence,
    };

    this.render();
    this.position(anchorRect);
    this.el.hidden = false;

    if (!saved) {
      this.fetchWordGloss(cleanWord, this.currentContext.sentence);
    }
  }

  position(anchorRect) {
    if (window.innerWidth <= 640 || !anchorRect) {
      this.el.style.top = '';
      this.el.style.left = '';
      this.el.style.bottom = '0px';
      this.el.classList.add('is-mobile-sheet');
      return;
    }
    this.el.classList.remove('is-mobile-sheet');
    this.el.style.bottom = '';
    const width = 330;
    const left = Math.max(12, Math.min(anchorRect.left, window.innerWidth - width - 16));
    const spaceBelow = window.innerHeight - anchorRect.bottom;
    const top = spaceBelow >= 280
      ? anchorRect.bottom + 8
      : Math.max(12, anchorRect.top - 270);
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
  }

  async fetchWordGloss(word, sentence) {
    const cfg = getExplainConfig();
    if (!cfg.available) {
      if (this.currentContext) {
        this.currentContext.loading = false;
        this.render();
      }
      return;
    }
    const controller = new AbortController();
    this.lookupAbort = controller;
    try {
      const res = await apiFetch('/api/explain/word', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Client-ID': getClientId() },
        body: JSON.stringify({
          word,
          sentence: sentence || '',
          lang: cfg.lang || 'zh',
          model_id: cfg.model || null,
          mode_id: null,
        }),
      }, getCopilotRequestTimeoutMs());
      if (controller.signal.aborted || !this.currentContext) return;
      if (res.ok) {
        const data = await res.json();
        this.currentContext.word = data.word || this.currentContext.word;
        this.currentContext.reading = data.reading || this.currentContext.reading;
        this.currentContext.pos = data.pos || this.currentContext.pos;
        this.currentContext.meaning = data.meaning || this.currentContext.meaning;
        this.currentContext.notes = data.note || this.currentContext.notes;
      }
    } catch {
      // Allow manual input even if AI lookup fails or is unconfigured
    } finally {
      if (!controller.signal.aborted && this.currentContext) {
        this.currentContext.loading = false;
        this.render();
      }
    }
  }

  render() {
    const ctx = this.currentContext;
    if (!ctx) return;
    const isSaved = Boolean(ctx.savedId);

    this.el.innerHTML = `
      <div class="vocab-popover-head">
        <div class="vocab-popover-title-wrap">
          <strong class="vocab-popover-word">${escapeHtml(ctx.word)}</strong>
          ${ctx.reading ? `<span class="vocab-popover-reading">【${escapeHtml(ctx.reading)}】</span>` : ''}
          ${ctx.pos ? `<span class="vocab-popover-pos">${escapeHtml(ctx.pos)}</span>` : ''}
        </div>
        <div class="vocab-popover-actions">
          <button type="button" class="vocab-pop-speak" title="朗读该词条" aria-label="朗读词条">🔊</button>
          <button type="button" class="vocab-pop-star ${isSaved ? 'is-saved' : ''}" title="${isSaved ? '从生词本移除' : '收藏到生词本'}" aria-pressed="${isSaved}">
            ★ ${isSaved ? '已收藏' : '收藏'}
          </button>
          <button type="button" class="vocab-pop-close" title="关闭" aria-label="关闭">×</button>
        </div>
      </div>

      ${ctx.loading ? `<div class="vocab-popover-loading"><span class="pending-dot"></span>AI 正在结合语境解析词义…</div>` : ''}

      <div class="vocab-popover-fields">
        <div class="vocab-field-row">
          <input type="text" class="vocab-input-reading" placeholder="读音 / 假名（可选）" value="${escapeHtml(ctx.reading)}" maxlength="120" aria-label="词条读音">
          <input type="text" class="vocab-input-pos" placeholder="词性（如 名詞 / v.）" value="${escapeHtml(ctx.pos)}" maxlength="60" aria-label="词性">
        </div>
        <textarea class="vocab-input-meaning" rows="2" placeholder="输入或编辑该词在本句中的释义…" maxlength="1000" aria-label="词条释义">${escapeHtml(ctx.meaning)}</textarea>
        ${ctx.notes ? `<p class="vocab-popover-note">💡 ${escapeHtml(ctx.notes)}</p>` : ''}
      </div>

      ${ctx.sentence ? `
        <div class="vocab-popover-sentence">
          <p>${escapeHtml(ctx.sentence)}</p>
          <button type="button" class="vocab-pop-play-sentence" title="朗读所在原句">▶ 听原句</button>
        </div>
      ` : ''}

      <div class="vocab-popover-foot">
        <button type="button" class="vocab-pop-save-btn article-primary">
          ★ ${isSaved ? '更新生词卡' : '保存到生词本'}
        </button>
      </div>
    `;

    this.el.querySelector('.vocab-pop-close').addEventListener('click', () => this.close());
    this.el.querySelector('.vocab-pop-speak').addEventListener('click', () => {
      quickSpeaker.speak(ctx.surface || ctx.word, msg => this.notify?.(msg));
    });

    const playSentBtn = this.el.querySelector('.vocab-pop-play-sentence');
    if (playSentBtn) {
      playSentBtn.addEventListener('click', () => {
        if (ctx.onPlaySentence) ctx.onPlaySentence();
        else quickSpeaker.speak(ctx.sentence, msg => this.notify?.(msg));
      });
    }

    const syncInputs = () => {
      ctx.reading = this.el.querySelector('.vocab-input-reading')?.value.trim() || '';
      ctx.pos = this.el.querySelector('.vocab-input-pos')?.value.trim() || '';
      ctx.meaning = this.el.querySelector('.vocab-input-meaning')?.value.trim() || '';
    };

    const saveCard = async () => {
      syncInputs();
      const saved = await this.store.upsert({
        word: ctx.word,
        surface: ctx.surface,
        reading: ctx.reading,
        pos: ctx.pos,
        meaning: ctx.meaning || ctx.word,
        notes: ctx.notes,
        context_sentence: ctx.sentence,
        source_article_id: ctx.articleId,
        source_title: ctx.articleTitle,
      });
      ctx.savedId = saved.id;
      if (this.currentContext === ctx) this.render();
    };

    this.el.querySelector('.vocab-pop-save-btn').addEventListener('click', () => {
      saveCard().catch(err => this.notify?.(err.message));
    });

    this.el.querySelector('.vocab-pop-star').addEventListener('click', () => {
      if (ctx.savedId) {
        const removeId = ctx.savedId;
        this.store.remove(removeId).then(() => {
          ctx.savedId = null;
          if (this.currentContext === ctx) this.render();
        }).catch(err => this.notify?.(err.message));
      } else {
        saveCard().catch(err => this.notify?.(err.message));
      }
    });
  }

  close() {
    this.lookupAbort?.abort();
    this.el.hidden = true;
    this.currentContext = null;
  }

  dispose() {
    this.close();
    document.removeEventListener('mousedown', this.onDocMouseDown);
    document.removeEventListener('keydown', this.onDocKeyDown);
    this.el.remove();
  }
}

/**
 * Workbench Vocabulary Panel: List View + Active Recall Flashcards + CSV/Anki Export
 */
export class VocabWorkspaceView {
  constructor({ container, store, onLocateInArticle, notify }) {
    Object.assign(this, { container, store, onLocateInArticle, notify });
    this.viewMode = 'list'; // 'list' | 'cards'
    this.statusFilter = 'all';
    this.searchQuery = '';
    this.composing = false;

    // Flashcard state (Read in Levels Qi style)
    this.cardQueue = [];
    this.cardCursor = 0;
    this.cardFlipped = false;
    this.cardRound = 1;
    this.firstTryKnown = new Set();
    this.seenInSession = new Set();
    this.sessionDone = false;
    this.reviewPending = false;
    this.cardSession = 0;

    this.mountShell();
    this.unsubscribe = this.store.subscribe(() => {
      if (!this.reviewPending) this.render();
    });
    this.render();
  }

  mountShell() {
    if (!this.container) return;
    this.container.innerHTML = `
      <div class="vocab-workspace-header">
        <div class="article-library-heading">
          <span class="eyebrow">MY WORDS · 単語帳</span>
          <div class="vocab-heading-row">
            <h2>个人生词本</h2>
            <div class="vocab-mode-toggle" role="group" aria-label="生词本视图切换">
              <button type="button" class="vocab-mode-btn active" data-vocab-mode="list" aria-pressed="true">☰ 列表 (0)</button>
              <button type="button" class="vocab-mode-btn" data-vocab-mode="cards" aria-pressed="false">❐ 闪卡复习</button>
            </div>
          </div>
          <p>在文章阅读或会话中选中生词即可一键收藏，并在原文中自动点亮 ★ 标记。</p>
        </div>

        <div class="vocab-filter-bar">
          <div class="vocab-status-pills" role="group" aria-label="生词状态筛选">
            <button type="button" class="vocab-filter-pill active" data-filter="all">全部 (0)</button>
            <button type="button" class="vocab-filter-pill" data-filter="unmastered">待复习 (0)</button>
            <button type="button" class="vocab-filter-pill" data-filter="mastered">已掌握 (0)</button>
          </div>
          <button type="button" class="vocab-export-btn" title="导出为 CSV / Anki 词卡文件">↓ 导出 CSV</button>
        </div>

        <label class="article-search vocab-search-label">
          <span class="sr-only">搜索生词、假名或释义</span>
          <input id="vocabSearchInput" type="search" placeholder="搜索生词、读音、释义或原句…" maxlength="200">
        </label>
      </div>

      <div class="vocab-workspace-body"></div>
    `;

    const searchInput = this.container.querySelector('#vocabSearchInput');
    searchInput.addEventListener('compositionstart', () => { this.composing = true; });
    searchInput.addEventListener('compositionend', () => {
      this.composing = false;
      this.searchQuery = searchInput.value;
      this.resetFlashcards();
      this.render();
    });
    searchInput.addEventListener('input', event => {
      this.searchQuery = searchInput.value;
      if (event.isComposing || this.composing) return;
      this.resetFlashcards();
      this.render();
    });

    this.container.querySelectorAll('[data-vocab-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.vocabMode;
        if (mode === this.viewMode) return;
        this.viewMode = mode;
        if (mode === 'cards') this.resetFlashcards();
        this.render();
      });
    });

    this.container.querySelectorAll('[data-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.statusFilter = btn.dataset.filter;
        this.resetFlashcards();
        this.render();
      });
    });

    this.container.querySelector('.vocab-export-btn')?.addEventListener('click', () => this.exportCSV());
  }

  resetFlashcards() {
    this.cardSession += 1;
    const pool = this.store.list({ query: this.searchQuery, status: this.statusFilter });
    this.cardQueue = pool.map(item => item.id);
    this.cardCursor = 0;
    this.cardFlipped = false;
    this.cardRound = 1;
    this.firstTryKnown = new Set();
    this.seenInSession = new Set();
    this.sessionDone = false;
  }

  exportCSV() {
    const rows = this.store.list({ query: this.searchQuery, status: this.statusFilter });
    if (!rows.length) {
      this.notify?.('当前没有可导出的生词记录。');
      return;
    }
    const esc = val => `"${String(val ?? '').replace(/"/g, '""')}"`;
    const header = ['Word', 'Reading', 'POS', 'Meaning', 'Notes', 'ContextSentence', 'SourceTitle'];
    const lines = [
      header.join(','),
      ...rows.map(r => [r.word, r.reading, r.pos, r.meaning, r.notes, r.context_sentence, r.source_title].map(esc).join(',')),
    ];
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `koto-vocab-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  highlightWordInSentence(sentence, word) {
    if (!sentence) return '';
    const safeSentence = escapeHtml(sentence);
    const safeWord = escapeHtml(word);
    if (!safeWord) return safeSentence;
    const escaped = safeWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safeSentence.replace(new RegExp(`(${escaped})`, 'gi'), '<strong class="vocab-sentence-match">$1</strong>');
  }

  render() {
    if (!this.container) return;
    const totalCount = this.store.items.length;
    const unmasteredCount = this.store.items.filter(i => !i.mastered).length;
    const masteredCount = totalCount - unmasteredCount;
    const filtered = this.store.list({ query: this.searchQuery, status: this.statusFilter });

    const listModeBtn = this.container.querySelector('[data-vocab-mode="list"]');
    const cardsModeBtn = this.container.querySelector('[data-vocab-mode="cards"]');
    if (listModeBtn) {
      listModeBtn.textContent = `☰ 列表 (${filtered.length})`;
      listModeBtn.classList.toggle('active', this.viewMode === 'list');
      listModeBtn.setAttribute('aria-pressed', String(this.viewMode === 'list'));
    }
    if (cardsModeBtn) {
      cardsModeBtn.classList.toggle('active', this.viewMode === 'cards');
      cardsModeBtn.setAttribute('aria-pressed', String(this.viewMode === 'cards'));
    }

    const pillAll = this.container.querySelector('[data-filter="all"]');
    const pillUnmastered = this.container.querySelector('[data-filter="unmastered"]');
    const pillMastered = this.container.querySelector('[data-filter="mastered"]');
    if (pillAll) {
      pillAll.textContent = `全部 (${totalCount})`;
      pillAll.classList.toggle('active', this.statusFilter === 'all');
    }
    if (pillUnmastered) {
      pillUnmastered.textContent = `待复习 (${unmasteredCount})`;
      pillUnmastered.classList.toggle('active', this.statusFilter === 'unmastered');
    }
    if (pillMastered) {
      pillMastered.textContent = `已掌握 (${masteredCount})`;
      pillMastered.classList.toggle('active', this.statusFilter === 'mastered');
    }

    const bodyEl = this.container.querySelector('.vocab-workspace-body');
    if (bodyEl) {
      bodyEl.innerHTML = this.viewMode === 'cards' ? this.renderFlashcardsHTML(filtered) : this.renderListHTML(filtered);
      this.bindBodyEvents(bodyEl);
    }
  }

  renderListHTML(filtered) {
    if (!filtered.length) {
      return `
        <div class="article-empty vocab-empty">
          <p>${this.store.items.length ? '没有匹配的生词' : '生词本还是空的'}</p>
          <small>在文章「阅读」视图中划词选中任意日文/英文单词，点击「★ 查词收藏」即可加入生词本。</small>
        </div>
      `;
    }
    return `
      <div class="vocab-list">
        ${filtered.map(item => `
          <article class="vocab-card ${item.mastered ? 'is-mastered' : ''}" data-vocab-item-id="${escapeHtml(item.id)}">
            <div class="vocab-card-top">
              <div class="vocab-card-word-group">
                <strong class="vocab-card-word">${escapeHtml(item.word)}</strong>
                ${item.reading ? `<span class="vocab-card-reading">【${escapeHtml(item.reading)}】</span>` : ''}
                ${item.pos ? `<span class="vocab-card-pos">${escapeHtml(item.pos)}</span>` : ''}
              </div>
              <div class="vocab-card-actions">
                <button type="button" class="vocab-btn-speak" data-speak-word="${escapeHtml(item.word)}" title="朗读单词" aria-label="朗读 ${escapeHtml(item.word)}">🔊</button>
                <button type="button" class="vocab-btn-master ${item.mastered ? 'active' : ''}" data-toggle-master="${escapeHtml(item.id)}" title="${item.mastered ? '标记为待复习' : '标记为已掌握'}">
                  ${item.mastered ? '✓ 已掌握' : '○ 待复习'}
                </button>
                <button type="button" class="vocab-btn-delete" data-delete-vocab="${escapeHtml(item.id)}" title="删除生词" aria-label="删除 ${escapeHtml(item.word)}">×</button>
              </div>
            </div>
            ${item.meaning ? `<p class="vocab-card-meaning">${escapeHtml(item.meaning)}</p>` : ''}
            ${item.notes ? `<p class="vocab-card-note">💡 ${escapeHtml(item.notes)}</p>` : ''}
            ${item.context_sentence ? `
              <div class="vocab-card-sentence">
                <span>“${this.highlightWordInSentence(item.context_sentence, item.surface || item.word)}”</span>
                <button type="button" class="vocab-btn-speak-sentence" data-speak-sentence="${escapeHtml(item.context_sentence)}" title="朗读原句">▶ 听原句</button>
              </div>
            ` : ''}
            ${item.source_article_id ? `
              <div class="vocab-card-source">
                <button type="button" class="vocab-btn-locate" data-locate-article="${escapeHtml(item.source_article_id)}" data-locate-word="${escapeHtml(item.word)}">
                  来自《${escapeHtml(item.source_title || '文章')}》· 在文中定位 ↗
                </button>
              </div>
            ` : ''}
          </article>
        `).join('')}
      </div>
    `;
  }

  renderFlashcardsHTML(filtered) {
    if (!filtered.length) {
      return `
        <div class="article-empty vocab-empty">
          <p>暂无可复习的闪卡</p>
          <small>请先收藏生词或切换筛选条件后再开始闪卡复习。</small>
        </div>
      `;
    }

    // Ensure cardQueue only references existing items
    const validIds = new Set(filtered.map(i => i.id));
    this.cardQueue = this.cardQueue.filter(id => validIds.has(id));
    if (!this.cardQueue.length && !this.sessionDone) {
      this.cardQueue = filtered.map(i => i.id);
      this.cardCursor = 0;
    }

    if (this.sessionDone) {
      return `
        <div class="vocab-flashcard-done">
          <div class="flashcard-done-icon">🎉</div>
          <h3>本轮生词全部复习完成！</h3>
          <p>首轮一次答对：<strong>${this.firstTryKnown.size}</strong> / ${filtered.length} · 共进行 <strong>${this.cardRound}</strong> 轮</p>
          <div class="flashcard-done-actions">
            <button type="button" class="article-primary vocab-cards-restart">↻ 再测一遍</button>
            <button type="button" class="vocab-cards-back">返回列表</button>
          </div>
        </div>
      `;
    }

    const currentId = this.cardQueue[this.cardCursor] || this.cardQueue[0];
    const item = this.store.get(currentId) || filtered[0];
    const remaining = this.cardQueue.length - this.cardCursor;

    return `
      <div class="vocab-flashcard-stage">
        <div class="flashcard-meta-row">
          <span>剩余 ${remaining} 词 · 第 ${this.cardRound} 轮</span>
          <span>已掌握 ${filtered.length - this.cardQueue.length + this.cardCursor} / ${filtered.length}</span>
        </div>

        <div class="vocab-flashcard ${this.cardFlipped ? 'is-flipped' : ''}" tabindex="0" role="button" aria-label="${this.cardFlipped ? '闪卡背面：词义与例句' : '闪卡正面：点击翻转查看释义'}">
          ${!this.cardFlipped ? `
            <div class="flashcard-front">
              <strong class="flashcard-word">${escapeHtml(item.word)}</strong>
              ${item.pos ? `<span class="flashcard-pos">${escapeHtml(item.pos)}</span>` : ''}
              <button type="button" class="flashcard-speak-btn" data-speak-word="${escapeHtml(item.word)}" title="听发音">🔊 听发音</button>
              <small class="flashcard-hint">点击卡片翻转查看释义与原句</small>
            </div>
          ` : `
            <div class="flashcard-back">
              <div class="flashcard-back-head">
                <strong>${escapeHtml(item.word)}</strong>
                ${item.reading ? `<span class="flashcard-reading">【${escapeHtml(item.reading)}】</span>` : ''}
                ${item.pos ? `<span class="flashcard-pos">${escapeHtml(item.pos)}</span>` : ''}
              </div>
              <p class="flashcard-meaning">${escapeHtml(item.meaning || '（暂无释义）')}</p>
              ${item.notes ? `<p class="flashcard-note">💡 ${escapeHtml(item.notes)}</p>` : ''}
              ${item.context_sentence ? `
                <blockquote class="flashcard-sentence">
                  “${this.highlightWordInSentence(item.context_sentence, item.surface || item.word)}”
                </blockquote>
              ` : ''}
            </div>
          `}
        </div>

        <div class="flashcard-judge-row">
          <button type="button" class="flashcard-btn-dontknow" ${!this.cardFlipped || this.reviewPending ? 'disabled' : ''}>还需复习 (Don't Know)</button>
          <button type="button" class="flashcard-btn-know article-primary" ${!this.cardFlipped || this.reviewPending ? 'disabled' : ''}>${this.reviewPending ? '保存中…' : '已掌握 (Know)'}</button>
        </div>
      </div>
    `;
  }

  bindBodyEvents(bodyEl) {
    // List actions
    bodyEl.querySelectorAll('[data-speak-word]').forEach(btn => {
      btn.addEventListener('click', event => {
        event.stopPropagation();
        quickSpeaker.speak(btn.dataset.speakWord, msg => this.notify?.(msg));
      });
    });

    bodyEl.querySelectorAll('[data-speak-sentence]').forEach(btn => {
      btn.addEventListener('click', event => {
        event.stopPropagation();
        quickSpeaker.speak(btn.dataset.speakSentence, msg => this.notify?.(msg));
      });
    });

    bodyEl.querySelectorAll('[data-toggle-master]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.toggleMaster;
        const item = this.store.get(id);
        if (item) {
          this.store.update(id, { mastered: !item.mastered }).catch(err => this.notify?.(err.message));
        }
      });
    });

    bodyEl.querySelectorAll('[data-delete-vocab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.deleteVocab;
        this.store.remove(id).catch(err => this.notify?.(err.message));
      });
    });

    bodyEl.querySelectorAll('[data-locate-article]').forEach(btn => {
      btn.addEventListener('click', () => {
        const articleId = btn.dataset.locateArticle;
        const word = btn.dataset.locateWord;
        this.onLocateInArticle?.(articleId, word);
      });
    });

    // Flashcard interactions
    const cardEl = bodyEl.querySelector('.vocab-flashcard');
    if (cardEl) {
      cardEl.addEventListener('click', () => {
        if (this.reviewPending) return;
        this.cardFlipped = !this.cardFlipped;
        this.render();
      });
      cardEl.addEventListener('keydown', event => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          if (this.reviewPending) return;
          this.cardFlipped = !this.cardFlipped;
          this.render();
        }
      });
    }

    const dontKnowBtn = bodyEl.querySelector('.flashcard-btn-dontknow');
    if (dontKnowBtn) {
      dontKnowBtn.addEventListener('click', () => {
        const currentId = this.cardQueue[this.cardCursor];
        if (currentId) this.seenInSession.add(currentId);
        if (this.cardCursor + 1 >= this.cardQueue.length) {
          this.cardCursor = 0;
          this.cardRound += 1;
        } else {
          this.cardCursor += 1;
        }
        this.cardFlipped = false;
        this.render();
      });
    }

    const knowBtn = bodyEl.querySelector('.flashcard-btn-know');
    if (knowBtn) {
      knowBtn.addEventListener('click', async () => {
        if (this.reviewPending) return;
        const currentId = this.cardQueue[this.cardCursor];
        if (!currentId) return;
        const session = this.cardSession;
        this.reviewPending = true;
        this.render();
        try {
          const saved = await this.store.update(currentId, { review_delta: 1, mastered: true });
          if (!saved) throw new Error('生词记录不存在，请刷新生词本。');
          if (session !== this.cardSession) return;
          if (!this.seenInSession.has(currentId)) {
            this.firstTryKnown.add(currentId);
          }
          this.seenInSession.add(currentId);
          this.cardQueue.splice(this.cardCursor, 1);
          if (this.cardQueue.length === 0) {
            this.sessionDone = true;
          } else if (this.cardCursor >= this.cardQueue.length) {
            this.cardCursor = 0;
            this.cardRound += 1;
          }
          this.cardFlipped = false;
        } catch (err) {
          this.notify?.(err.message);
        } finally {
          this.reviewPending = false;
          this.render();
        }
      });
    }

    bodyEl.querySelector('.vocab-cards-restart')?.addEventListener('click', () => {
      this.resetFlashcards();
      this.render();
    });
    bodyEl.querySelector('.vocab-cards-back')?.addEventListener('click', () => {
      this.viewMode = 'list';
      this.render();
    });
  }

  dispose() {
    this.unsubscribe?.();
    this.container?.replaceChildren();
  }
}
