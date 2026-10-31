import { apiFetch, getClientId, handleResponseError, escapeHtml } from './api.js';
import { getSelectedEngine, getSelectedVoice, getApiKey, getMaxCharCount } from './settings.js';
import { registerExternalAudio, pauseAllPlayers } from './message-player.js';

export const LOOP_MODES = ['off', 'all', '3x', '5x', 'inf'];

export const LOOP_META = {
  off: { short: '顺序', label: '不循环（顺序朗读全文）' },
  all: { short: 'All', label: '全文循环朗读' },
  '3x': { short: '3×', label: '每句重复 3 遍（跟读精听）' },
  '5x': { short: '5×', label: '每句重复 5 遍（强化精听）' },
  inf: { short: '∞', label: '当前句无限循环' },
};

const SPEED_OPTIONS = [0.75, 1, 1.25];
const MAX_BLOB_CACHE = 60;
const audioBlobCache = new Map();

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function getCachedBlob(signature) {
  if (!audioBlobCache.has(signature)) return null;
  const entry = audioBlobCache.get(signature);
  audioBlobCache.delete(signature);
  audioBlobCache.set(signature, entry);
  return entry;
}

function setCachedBlob(signature, blob, cacheKey) {
  if (audioBlobCache.has(signature)) {
    audioBlobCache.delete(signature);
  } else if (audioBlobCache.size >= MAX_BLOB_CACHE) {
    const oldestKey = audioBlobCache.keys().next().value;
    audioBlobCache.delete(oldestKey);
  }
  const entry = { blob, cacheKey };
  audioBlobCache.set(signature, entry);
  return entry;
}

const sentenceSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('ja', { granularity: 'sentence' })
  : null;

function splitTextIntoSentences(text) {
  if (!text || !text.trim()) return [text];
  if (sentenceSegmenter) {
    const parts = [];
    for (const { segment } of sentenceSegmenter.segment(text)) {
      if (segment) parts.push(segment);
    }
    if (parts.length > 0) return parts;
  }
  const matches = text.match(/[^。！？.!?\r\n]+[。！？.!?」』）)”'\s]*/g);
  return matches && matches.length ? matches : [text];
}

/**
 * Splits readable blocks in `.article-preview` into `<span class="article-sentence">`
 * while strictly preserving `<br>`, inline formatting, and `selection.toString()` output.
 */
export function segmentArticlePreview(previewEl) {
  if (!previewEl) return [];
  const blocks = [...previewEl.querySelectorAll('.article-reading-block')];
  let sentenceIndex = 0;
  const sentences = [];

  blocks.forEach((blockEl, blockIndex) => {
    blockEl.dataset.blockIndex = String(blockIndex);
    const targets = [...blockEl.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6')].filter(el => {
      if (el.closest('pre, table')) return false;
      if (el.tagName === 'LI' && el.querySelector('p')) return false;
      return true;
    });

    targets.forEach(target => {
      const childNodes = [...target.childNodes];
      if (!childNodes.length) return;

      // Group child nodes by <br> or nested block lists (<ul>/<ol>)
      const lineGroups = [];
      let currentGroup = [];
      for (const node of childNodes) {
        const isBreak = node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR';
        const isNestedList = node.nodeType === Node.ELEMENT_NODE && (node.tagName === 'UL' || node.tagName === 'OL');
        if (isBreak || isNestedList) {
          if (currentGroup.length) {
            lineGroups.push({ type: 'inline', nodes: currentGroup });
            currentGroup = [];
          }
          lineGroups.push({ type: 'passthrough', node });
        } else {
          currentGroup.push(node);
        }
      }
      if (currentGroup.length) {
        lineGroups.push({ type: 'inline', nodes: currentGroup });
      }

      const fragment = document.createDocumentFragment();
      for (const group of lineGroups) {
        if (group.type === 'passthrough') {
          fragment.appendChild(group.node);
          continue;
        }
        const onlyPlainText = group.nodes.length === 1 && group.nodes[0].nodeType === Node.TEXT_NODE;
        if (onlyPlainText) {
          const rawText = group.nodes[0].nodeValue || '';
          const parts = splitTextIntoSentences(rawText);
          for (const part of parts) {
            if (!part.trim()) {
              fragment.appendChild(document.createTextNode(part));
              continue;
            }
            const span = document.createElement('span');
            span.className = 'article-sentence';
            span.dataset.sentenceIndex = String(sentenceIndex);
            span.dataset.blockIndex = String(blockIndex);
            span.textContent = part;
            fragment.appendChild(span);
            sentences.push({ index: sentenceIndex, blockIndex, text: part.trim(), element: span, blockEl });
            sentenceIndex += 1;
          }
        } else {
          const combinedText = group.nodes.map(n => n.textContent || '').join('').trim();
          if (!combinedText) {
            group.nodes.forEach(n => fragment.appendChild(n));
            continue;
          }
          const span = document.createElement('span');
          span.className = 'article-sentence';
          span.dataset.sentenceIndex = String(sentenceIndex);
          span.dataset.blockIndex = String(blockIndex);
          group.nodes.forEach(n => span.appendChild(n));
          fragment.appendChild(span);
          sentences.push({ index: sentenceIndex, blockIndex, text: combinedText, element: span, blockEl });
          sentenceIndex += 1;
        }
      }
      target.replaceChildren(fragment);
    });
  });

  return sentences;
}

/**
 * Decorates saved vocabulary words inside `.article-sentence` text nodes with
 * `<mark class="article-vocab-highlight">` using CSS ::after for the ★ star badge
 * so that `textContent` and `selection.toString()` are never polluted.
 */
export function highlightSavedWordsInPreview(previewEl, vocabItems = []) {
  if (!previewEl) return;
  // First unwrap any existing <mark class="article-vocab-highlight">
  previewEl.querySelectorAll('mark.article-vocab-highlight').forEach(mark => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });

  const validItems = (vocabItems || [])
    .filter(item => item && typeof item.word === 'string' && item.word.trim().length > 0)
    .flatMap(item => [...new Set([item.word, item.surface].filter(word => typeof word === 'string' && word.trim()))]
      .map(word => ({ word, item })))
    .sort((a, b) => b.word.length - a.word.length);

  if (!validItems.length) return;

  const wordPatterns = validItems.map(item => {
    const escaped = item.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const startsAscii = /^[A-Za-z0-9_]/.test(item.word);
    const endsAscii = /[A-Za-z0-9_]$/.test(item.word);
    return `${startsAscii ? '(?<![A-Za-z0-9_])' : ''}${escaped}${endsAscii ? '(?![A-Za-z0-9_])' : ''}`;
  });
  const pattern = new RegExp(`(${wordPatterns.join('|')})`, 'gi');
  const byLower = new Map();
  for (const match of validItems) {
    const k = match.word.toLowerCase();
    if (!byLower.has(k)) byLower.set(k, match.item);
  }

  const sentenceEls = previewEl.querySelectorAll('.article-sentence');
  sentenceEls.forEach(sentenceEl => {
    const walker = document.createTreeWalker(sentenceEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest('code, pre, a, mark.article-vocab-highlight')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes = [];
    let current = walker.nextNode();
    while (current) {
      textNodes.push(current);
      current = walker.nextNode();
    }

    for (const textNode of textNodes) {
      const value = textNode.nodeValue;
      pattern.lastIndex = 0;
      if (!pattern.test(value)) continue;
      pattern.lastIndex = 0;

      const frag = document.createDocumentFragment();
      let lastIdx = 0;
      for (const match of value.matchAll(pattern)) {
        const matchedText = match[0];
        const idx = match.index;
        if (idx > lastIdx) {
          frag.appendChild(document.createTextNode(value.slice(lastIdx, idx)));
        }
        const item = byLower.get(matchedText.toLowerCase());
        if (item) {
          const mark = document.createElement('mark');
          mark.className = 'article-vocab-highlight' + (item.mastered ? ' is-mastered' : '');
          mark.dataset.vocabId = item.id;
          mark.dataset.vocabWord = item.word;
          mark.textContent = matchedText;
          frag.appendChild(mark);
        } else {
          frag.appendChild(document.createTextNode(matchedText));
        }
        lastIdx = idx + matchedText.length;
      }
      if (lastIdx < value.length) {
        frag.appendChild(document.createTextNode(value.slice(lastIdx)));
      }
      textNode.parentNode?.replaceChild(frag, textNode);
    }
  });
}

export class ArticleReaderController {
  constructor(node, { entryId, fillInput, onExplainSentence, onLookupSelection, onOpenVocabCard, notify }) {
    Object.assign(this, { node, entryId, fillInput, onExplainSentence, onLookupSelection, onOpenVocabCard, notify });
    this.sentences = [];
    this.activeIndex = -1;
    this.audioSentenceIndex = -1;
    this.selectedIndex = -1;
    this.isPlaying = false;
    this.isLoading = false;
    this.singleSentenceOnly = false;
    this.repeatCount = 0;
    this.playGeneration = 0;
    this.repeatTimer = null;
    this.userScrolledUntil = 0;
    this.currentObjectUrl = null;
    this.prefetchController = null;

    const savedLoop = localStorage.getItem('tts_article_loop_mode');
    this.loopMode = LOOP_MODES.includes(savedLoop) ? savedLoop : 'off';
    const savedSpeed = parseFloat(localStorage.getItem('tts_article_speed'));
    this.speed = SPEED_OPTIONS.includes(savedSpeed) ? savedSpeed : 1;

    this.audio = document.createElement('audio');
    this.audio.preload = 'auto';
    this.audio.className = 'audio-native-hidden';
    this.unregisterAudio = registerExternalAudio(this.audio);

    this.mountUI();
    this.bindEvents();
  }

  mountUI() {
    const preview = this.node.querySelector('.article-preview');
    this.preview = preview;

    // 1. Top Article Reader Audio Player Bar (inserted right before .article-preview)
    this.playerBar = document.createElement('div');
    this.playerBar.className = 'article-reader-bar';
    this.playerBar.setAttribute('role', 'region');
    this.playerBar.setAttribute('aria-label', '文章精听朗读控制栏');
    this.playerBar.innerHTML = `
      <div class="reader-bar-main">
        <button type="button" class="reader-btn-play" aria-label="朗读文章" title="播放 / 暂停">
          <span class="reader-play-icon">▶</span>
        </button>
        <div class="reader-nav-group">
          <button type="button" class="reader-btn-prev" aria-label="上一句" title="上一句" disabled>⏮</button>
          <button type="button" class="reader-btn-next" aria-label="下一句" title="下一句" disabled>⏭</button>
        </div>
        <div class="reader-progress-wrap">
          <div class="reader-status-row">
            <span class="reader-sentence-status">点按文中任意句子即可朗读</span>
            <span class="reader-time-label">0:00 / 0:00</span>
          </div>
          <div class="reader-progress-track" role="slider" aria-label="当前句播放进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0">
            <div class="reader-progress-fill" style="width: 0%"></div>
          </div>
        </div>
      </div>
      <div class="reader-bar-controls">
        <div class="reader-speed-pills" role="group" aria-label="朗读倍速">
          ${SPEED_OPTIONS.map(s => `<button type="button" class="reader-speed-btn ${s === this.speed ? 'active' : ''}" data-speed="${s}">${s}x</button>`).join('')}
        </div>
        <button type="button" class="reader-loop-btn ${this.loopMode !== 'off' ? 'active' : ''}" data-loop-mode="${this.loopMode}" title="${escapeHtml(LOOP_META[this.loopMode].label)}">
          <span class="loop-icon">🔁</span>
          <span class="loop-text">${escapeHtml(LOOP_META[this.loopMode].short)}</span>
        </button>
      </div>
    `;
    preview.parentNode.insertBefore(this.playerBar, preview);

    // 2. Sentence Quick Action Toolbar (placed outside .article-preview so DOM text inside .article-preview stays 100% pure)
    this.sentenceToolbar = document.createElement('div');
    this.sentenceToolbar.className = 'article-sentence-toolbar';
    this.sentenceToolbar.hidden = true;
    this.sentenceToolbar.innerHTML = `
      <span class="sentence-toolbar-index">第 1 句</span>
      <button type="button" class="sentence-act-play" title="从本句开始朗读">▶ 朗读此句</button>
      <button type="button" class="sentence-act-loop" title="单句重复 3 遍跟读">🔁 3× 精听</button>
      <button type="button" class="sentence-act-explain" title="使用 AI 助手解析此句">✧ AI 解说</button>
      <button type="button" class="sentence-act-fill" title="填入中间语音输入框">↗ 填入</button>
    `;
    preview.parentNode.insertBefore(this.sentenceToolbar, preview);

    // 3. Floating Mini-Player at bottom when scrolled
    this.miniPlayer = document.createElement('div');
    this.miniPlayer.className = 'article-mini-player';
    this.miniPlayer.hidden = true;
    this.miniPlayer.innerHTML = `
      <button type="button" class="mini-btn-play" aria-label="播放或暂停">❚❚</button>
      <span class="mini-status-text">第 1 句</span>
      <button type="button" class="mini-btn-loop" title="切换循环模式">🔁</button>
      <button type="button" class="mini-btn-locate" title="滚动到当前朗读句子">↑ 定位</button>
    `;
    this.node.appendChild(this.miniPlayer);
  }

  bindEvents() {
    const playBtn = this.playerBar.querySelector('.reader-btn-play');
    const prevBtn = this.playerBar.querySelector('.reader-btn-prev');
    const nextBtn = this.playerBar.querySelector('.reader-btn-next');
    const loopBtn = this.playerBar.querySelector('.reader-loop-btn');
    const track = this.playerBar.querySelector('.reader-progress-track');

    playBtn.addEventListener('click', () => this.togglePlay());
    prevBtn.addEventListener('click', () => {
      if (this.activeIndex > 0) this.playSentence(this.activeIndex - 1, { single: false });
    });
    nextBtn.addEventListener('click', () => {
      if (this.activeIndex + 1 < this.sentences.length) {
        this.playSentence(this.activeIndex + 1, { single: false });
      }
    });
    loopBtn.addEventListener('click', () => this.cycleLoopMode());

    this.playerBar.querySelectorAll('.reader-speed-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const nextSpeed = parseFloat(btn.dataset.speed);
        if (!SPEED_OPTIONS.includes(nextSpeed)) return;
        this.speed = nextSpeed;
        this.audio.playbackRate = nextSpeed;
        try { localStorage.setItem('tts_article_speed', String(nextSpeed)); } catch { /* ignore */ }
        this.playerBar.querySelectorAll('.reader-speed-btn').forEach(b => b.classList.toggle('active', b === btn));
      });
    });

    track.addEventListener('click', event => {
      const rect = track.getBoundingClientRect();
      if (!rect.width || !Number.isFinite(this.audio.duration) || this.audio.duration <= 0) return;
      const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      this.audio.currentTime = pct * this.audio.duration;
      this.updateProgressUI();
    });

    // Sentence toolbar buttons
    this.sentenceToolbar.querySelector('.sentence-act-play').addEventListener('click', () => {
      const targetIdx = this.selectedIndex >= 0 ? this.selectedIndex : 0;
      this.playSentence(targetIdx, { single: false });
    });
    this.sentenceToolbar.querySelector('.sentence-act-loop').addEventListener('click', () => {
      const targetIdx = this.selectedIndex >= 0 ? this.selectedIndex : (this.activeIndex >= 0 ? this.activeIndex : 0);
      if (this.loopMode === 'off' || this.loopMode === 'all') {
        this.setLoopMode('3x');
      }
      this.playSentence(targetIdx, { single: false });
    });
    this.sentenceToolbar.querySelector('.sentence-act-explain').addEventListener('click', () => {
      const targetIdx = this.selectedIndex >= 0 ? this.selectedIndex : this.activeIndex;
      const item = this.sentences[targetIdx];
      if (item && this.onExplainSentence) this.onExplainSentence(item.text);
    });
    this.sentenceToolbar.querySelector('.sentence-act-fill').addEventListener('click', () => {
      const targetIdx = this.selectedIndex >= 0 ? this.selectedIndex : this.activeIndex;
      const item = this.sentences[targetIdx];
      if (item && this.fillInput) this.fillInput(item.text);
    });

    // Mini-player buttons
    this.miniPlayer.querySelector('.mini-btn-play').addEventListener('click', () => this.togglePlay());
    this.miniPlayer.querySelector('.mini-btn-loop').addEventListener('click', () => this.cycleLoopMode());
    this.miniPlayer.querySelector('.mini-btn-locate').addEventListener('click', () => {
      this.userScrolledUntil = 0;
      this.scrollToActiveSentence(true);
    });

    // Preview interactions: click sentence or click saved vocab highlight
    this.preview.addEventListener('click', event => {
      const vocabMark = event.target.closest('mark.article-vocab-highlight');
      if (vocabMark) {
        event.stopPropagation();
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) return;
        const sentenceEl = vocabMark.closest('.article-sentence');
        const sentenceText = sentenceEl ? sentenceEl.textContent.trim() : '';
        this.onOpenVocabCard?.({
          vocabId: vocabMark.dataset.vocabId,
          word: vocabMark.textContent,
          sentence: sentenceText,
          anchorRect: vocabMark.getBoundingClientRect(),
          onPlaySentence: sentenceEl ? () => {
            const idx = Number(sentenceEl.dataset.sentenceIndex);
            if (Number.isInteger(idx)) this.playSentence(idx, { single: true });
          } : null,
        });
        return;
      }

      const sentenceEl = event.target.closest('.article-sentence');
      if (!sentenceEl) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) return;

      const idx = Number(sentenceEl.dataset.sentenceIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= this.sentences.length) return;
      this.selectSentence(idx);
    });

    this.preview.addEventListener('dblclick', event => {
      const sentenceEl = event.target.closest('.article-sentence');
      if (!sentenceEl) return;
      const idx = Number(sentenceEl.dataset.sentenceIndex);
      if (Number.isInteger(idx) && idx >= 0 && idx < this.sentences.length) {
        window.getSelection()?.removeAllRanges();
        this.playSentence(idx, { single: false });
      }
    });

    const markUserScrolled = () => {
      if (this.isPlaying) {
        this.userScrolledUntil = Date.now() + 5000;
      }
    };
    this.preview.addEventListener('wheel', markUserScrolled, { passive: true });
    this.preview.addEventListener('touchmove', markUserScrolled, { passive: true });
    this.preview.addEventListener('scroll', () => this.updateMiniPlayerVisibility(), { passive: true });

    // Audio element events
    this.audio.addEventListener('play', () => {
      pauseAllPlayers(this.audio);
      this.isPlaying = true;
      this.syncControlsUI();
    });
    this.audio.addEventListener('pause', () => {
      if (!this.repeatTimer) {
        this.isPlaying = false;
        this.syncControlsUI();
      }
    });
    this.audio.addEventListener('timeupdate', () => this.updateProgressUI());
    this.audio.addEventListener('loadedmetadata', () => this.updateProgressUI());
    this.audio.addEventListener('ended', () => this.handleSentenceEnded());
  }

  setSentences(sentences) {
    this.stop();
    this.sentences = sentences || [];
    this.selectedIndex = -1;
    this.sentenceToolbar.hidden = true;
    this.syncControlsUI();
  }

  setModeVisible(isReadMode) {
    this.playerBar.hidden = !isReadMode;
    if (!isReadMode) {
      this.sentenceToolbar.hidden = true;
      this.miniPlayer.hidden = true;
      this.pause();
    } else {
      this.updateMiniPlayerVisibility();
    }
  }

  selectSentence(index) {
    this.selectedIndex = index;
    this.sentences.forEach((item, idx) => {
      item.element.classList.toggle('is-selected-sentence', idx === index);
    });
    const item = this.sentences[index];
    if (!item) {
      this.sentenceToolbar.hidden = true;
      return;
    }
    this.sentenceToolbar.querySelector('.sentence-toolbar-index').textContent = `第 ${index + 1} / ${this.sentences.length} 句`;
    this.sentenceToolbar.hidden = false;
  }

  cycleLoopMode() {
    const nextIdx = (LOOP_MODES.indexOf(this.loopMode) + 1) % LOOP_MODES.length;
    this.setLoopMode(LOOP_MODES[nextIdx]);
  }

  setLoopMode(mode) {
    if (!LOOP_MODES.includes(mode)) return;
    this.loopMode = mode;
    try { localStorage.setItem('tts_article_loop_mode', mode); } catch { /* ignore */ }
    if (this.activeIndex >= 0 && this.repeatCount === 0) {
      this.repeatCount = 1;
    }
    this.updateActiveSentenceDOM();
    this.syncControlsUI();
  }

  togglePlay() {
    if (this.isLoading) return;
    if (this.isPlaying) {
      this.pause();
      return;
    }
    if (this.activeIndex >= 0 && this.audioSentenceIndex === this.activeIndex && this.audio.src && this.audio.currentTime > 0 && !this.audio.ended) {
      this.audio.playbackRate = this.speed;
      this.audio.play().catch(err => this.notify?.(err.message || '无法开始播放'));
      return;
    }
    const startIdx = this.selectedIndex >= 0 ? this.selectedIndex : (this.activeIndex >= 0 ? this.activeIndex : 0);
    if (this.sentences.length > 0) {
      this.playSentence(startIdx, { single: false });
    }
  }

  pause() {
    this.playGeneration += 1;
    clearTimeout(this.repeatTimer);
    this.repeatTimer = null;
    this.isLoading = false;
    this.isPlaying = false;
    if (!this.audio.paused) this.audio.pause();
    this.syncControlsUI();
  }

  stop() {
    this.pause();
    this.prefetchController?.abort();
    this.prefetchController = null;
    this.activeIndex = -1;
    this.audioSentenceIndex = -1;
    this.repeatCount = 0;
    this.updateActiveSentenceDOM();
    this.syncControlsUI();
  }

  async synthesizeSentenceBlob(text, signal = null) {
    const trimmed = (text || '').trim();
    if (Array.from(trimmed).length > getMaxCharCount()) {
      throw new Error(`当前句超过 ${getMaxCharCount()} 字，未生成语音。请在编辑视图中将长句拆分后重试。`);
    }
    const engine = getSelectedEngine();
    const voice = getSelectedVoice() || '';
    const signature = `${engine}|${voice}|${trimmed}`;
    const cached = getCachedBlob(signature);
    if (cached) return cached;

    const headers = { 'Content-Type': 'application/json', 'X-Client-ID': getClientId() };
    const key = getApiKey();
    if (engine === 'gemini' && key) headers['X-Gemini-Api-Key'] = key;

    const response = await apiFetch('/api/tts', {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({ text: trimmed, engine, voice: voice || null }),
    });
    if (!response.ok) await handleResponseError(response);
    const cacheKey = response.headers.get('X-Cache-Key') || '';
    const blob = await response.blob();
    return setCachedBlob(signature, blob, cacheKey);
  }

  prefetchSentence(index) {
    if (index < 0 || index >= this.sentences.length) return;
    if (this.loopMode === 'inf' || this.singleSentenceOnly) return;
    const item = this.sentences[index];
    if (!item?.text) return;
    const engine = getSelectedEngine();
    const voice = getSelectedVoice() || '';
    const signature = `${engine}|${voice}|${item.text.trim()}`;
    if (audioBlobCache.has(signature)) return;

    this.prefetchController?.abort();
    const controller = new AbortController();
    this.prefetchController = controller;
    this.synthesizeSentenceBlob(item.text, controller.signal).catch(() => {
      // Silent background prefetch failure
    });
  }

  async playSentence(index, { single = false } = {}) {
    if (index < 0 || index >= this.sentences.length) return;
    // Stop the old source before changing its sentence identity or awaiting TTS.
    this.pause();
    const gen = this.playGeneration;
    this.audioSentenceIndex = -1;
    this.singleSentenceOnly = Boolean(single);
    this.activeIndex = index;
    this.selectedIndex = index;
    this.repeatCount = 1;
    this.isLoading = true;
    this.isPlaying = false;
    this.selectSentence(index);
    this.updateActiveSentenceDOM();
    this.syncControlsUI();
    this.scrollToActiveSentence(false);

    try {
      const sentence = this.sentences[index];
      const { blob } = await this.synthesizeSentenceBlob(sentence.text);
      if (gen !== this.playGeneration) return;

      if (this.currentObjectUrl) URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = URL.createObjectURL(blob);
      this.audio.src = this.currentObjectUrl;
      this.audioSentenceIndex = index;
      this.audio.playbackRate = this.speed;
      this.isLoading = false;
      this.isPlaying = true;
      this.syncControlsUI();
      try {
        await this.audio.play();
      } catch {
        if (gen === this.playGeneration && this.audio.paused) {
          this.isPlaying = false;
          this.syncControlsUI();
        }
      }
      if (gen === this.playGeneration) {
        this.prefetchSentence(index + 1);
      }
    } catch (error) {
      if (gen !== this.playGeneration) return;
      this.isLoading = false;
      this.isPlaying = false;
      this.syncControlsUI();
      this.notify?.(error.message || '句子语音生成失败，请重试。');
    }
  }

  handleSentenceEnded() {
    // An ended event queued by an old source must not advance the new sentence.
    if (this.isLoading || this.audioSentenceIndex !== this.activeIndex || !this.audio.ended) return;
    const gen = this.playGeneration;
    const mode = this.loopMode;
    const maxRepeats = mode === '3x' ? 3 : mode === '5x' ? 5 : mode === 'inf' ? Infinity : 1;

    if (this.repeatCount < maxRepeats) {
      this.repeatCount += 1;
      this.updateActiveSentenceDOM();
      this.syncControlsUI();
      this.repeatTimer = setTimeout(() => {
        if (gen !== this.playGeneration) return;
        this.repeatTimer = null;
        this.audio.currentTime = 0;
        this.audio.playbackRate = this.speed;
        this.audio.play().catch(() => {});
      }, 280);
      return;
    }

    if (this.singleSentenceOnly && mode === 'off') {
      this.isPlaying = false;
      this.syncControlsUI();
      return;
    }

    const nextIdx = this.activeIndex + 1;
    if (nextIdx < this.sentences.length) {
      this.playSentence(nextIdx, { single: false });
      return;
    }

    if (mode === 'all' && this.sentences.length > 0) {
      this.repeatTimer = setTimeout(() => {
        if (gen !== this.playGeneration) return;
        this.repeatTimer = null;
        this.playSentence(0, { single: false });
      }, 500);
      return;
    }

    this.isPlaying = false;
    this.syncControlsUI();
  }

  updateActiveSentenceDOM() {
    const activeBlockIdx = this.activeIndex >= 0 ? this.sentences[this.activeIndex]?.blockIndex : -1;
    this.preview.querySelectorAll('.article-reading-block').forEach(blockEl => {
      blockEl.classList.toggle('is-reading-block', Number(blockEl.dataset.blockIndex) === activeBlockIdx);
    });

    this.sentences.forEach((item, idx) => {
      const isCurrent = idx === this.activeIndex;
      item.element.classList.toggle('is-reading-sentence', isCurrent);
      if (isCurrent) {
        if (this.loopMode === '3x' || this.loopMode === '5x') {
          const target = this.loopMode === '3x' ? 3 : 5;
          item.element.setAttribute('data-loop-badge', ` (${this.repeatCount}/${target})`);
        } else if (this.loopMode === 'inf') {
          item.element.setAttribute('data-loop-badge', ' ∞');
        } else {
          item.element.removeAttribute('data-loop-badge');
        }
      } else {
        item.element.removeAttribute('data-loop-badge');
      }
    });
  }

  scrollToActiveSentence(force = false) {
    if (this.activeIndex < 0 || this.activeIndex >= this.sentences.length) return;
    if (!force && Date.now() < this.userScrolledUntil) return;
    const el = this.sentences[this.activeIndex]?.element;
    if (!el || this.preview.hidden) return;
    const previewRect = this.preview.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const outsideComfortZone = elRect.top < previewRect.top + 36 || elRect.bottom > previewRect.bottom - 36;
    if (force || outsideComfortZone) {
      const offsetTop = elRect.top - previewRect.top + this.preview.scrollTop;
      const targetScroll = Math.max(0, offsetTop - (this.preview.clientHeight / 2) + (elRect.height / 2));
      this.preview.scrollTo({ top: targetScroll, behavior: 'smooth' });
    }
  }

  updateProgressUI() {
    const duration = this.audio.duration;
    const current = this.audio.currentTime;
    const fill = this.playerBar.querySelector('.reader-progress-fill');
    const track = this.playerBar.querySelector('.reader-progress-track');
    const timeLabel = this.playerBar.querySelector('.reader-time-label');
    if (Number.isFinite(duration) && duration > 0) {
      const pct = Math.min(100, Math.max(0, (current / duration) * 100));
      fill.style.width = `${pct}%`;
      track.setAttribute('aria-valuenow', String(Math.round(pct)));
      timeLabel.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    } else {
      fill.style.width = '0%';
      timeLabel.textContent = `${formatTime(current)} / 0:00`;
    }
  }

  updateMiniPlayerVisibility() {
    const scrolledDown = this.preview.scrollTop > 100;
    const hasActiveSession = this.isPlaying || this.isLoading || this.activeIndex >= 0;
    this.miniPlayer.hidden = this.preview.hidden || !(scrolledDown && hasActiveSession);
  }

  syncControlsUI() {
    const total = this.sentences.length;
    const playIcon = this.playerBar.querySelector('.reader-play-icon');
    const prevBtn = this.playerBar.querySelector('.reader-btn-prev');
    const nextBtn = this.playerBar.querySelector('.reader-btn-next');
    const statusEl = this.playerBar.querySelector('.reader-sentence-status');
    const loopBtn = this.playerBar.querySelector('.reader-loop-btn');

    playIcon.textContent = this.isLoading ? '…' : this.isPlaying ? '❚❚' : '▶';
    prevBtn.disabled = total === 0 || this.activeIndex <= 0;
    nextBtn.disabled = total === 0 || this.activeIndex < 0 || this.activeIndex >= total - 1;

    loopBtn.dataset.loopMode = this.loopMode;
    loopBtn.classList.toggle('active', this.loopMode !== 'off');
    loopBtn.title = LOOP_META[this.loopMode].label;
    loopBtn.querySelector('.loop-text').textContent = LOOP_META[this.loopMode].short;

    let loopSuffix = '';
    if (this.activeIndex >= 0) {
      if (this.loopMode === '3x' || this.loopMode === '5x') {
        loopSuffix = ` · 重复 ${this.repeatCount}/${this.loopMode === '3x' ? 3 : 5}`;
      } else if (this.loopMode === 'inf') {
        loopSuffix = ' · 单句循环 ∞';
      }
    }

    if (total === 0) {
      statusEl.textContent = '暂无可朗读句子';
    } else if (this.isLoading) {
      statusEl.textContent = `正在合成第 ${this.activeIndex + 1} / ${total} 句…`;
    } else if (this.activeIndex >= 0) {
      statusEl.textContent = `${this.isPlaying ? '正在朗读' : '已暂停'} · 第 ${this.activeIndex + 1} / ${total} 句${loopSuffix}`;
    } else {
      statusEl.textContent = `共 ${total} 句 · 点击任意句子朗读或双击连读`;
    }

    // Mini player sync
    this.miniPlayer.querySelector('.mini-btn-play').textContent = this.isLoading ? '…' : this.isPlaying ? '❚❚' : '▶';
    this.miniPlayer.querySelector('.mini-status-text').textContent = this.activeIndex >= 0
      ? `第 ${this.activeIndex + 1}/${total} 句${loopSuffix}`
      : `共 ${total} 句`;
    this.miniPlayer.querySelector('.mini-btn-loop').textContent = `🔁 ${LOOP_META[this.loopMode].short}`;
    this.updateMiniPlayerVisibility();
  }

  dispose() {
    this.stop();
    this.unregisterAudio?.();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }
  }
}
