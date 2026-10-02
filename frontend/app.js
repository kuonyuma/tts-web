/** Conversation coordinator. All asynchronous writes use captured message IDs. */
import { apiFetch, getClientId, handleResponseError, setRequestTimeoutMs, escapeHtml } from './api.js';
import { initSettings, loadEngines, getSelectedEngine, getSelectedVoice, getMinCharCount,
  getMaxCharCount, getApiKey, getVoiceLabel, closeSettingsModal,
  isSettingsModalOpen } from './settings.js';
import { initCopilot, loadCopilotModels, resetExplanation, setCurrentExplainText,
  renderExplainEmpty, requestExplanation } from './copilot.js';
import { ConversationStore } from './conversations.js';
import { MessagePlayer } from './message-player.js';
import { initSidebarResizers, adjustForAvailableSpace } from './sidebar-resizer.js';

const $ = id => document.getElementById(id);
const narrow = window.matchMedia('(max-width: 1100px)');
let store;
let activeId = null;
let aiTargetId = null;
let activeStorageKey;
let ready = false;
let provisionalId = null;
const cards = new Map();
const pending = new Set();
const drafts = new Map();
const scrollPositions = new Map();
let leftOpen = !narrow.matches && localStorage.getItem('tts_chat_left_open') !== '0';
let rightOpen = !narrow.matches && localStorage.getItem('tts_chat_right_open') !== '0';

export function showError(message) {
  $('errorMessage').textContent = message;
  $('errorAlert').style.display = 'flex';
}
function hideError() { $('errorAlert').style.display = 'none'; }
function safely(action) {
  try { return action(); } catch (error) { showError(error.message); return null; }
}
function activeConversation() { return store?.get(activeId); }
function nearBottom() {
  const list = $('messageList');
  return list.scrollHeight - list.scrollTop - list.clientHeight < 90;
}
function followBottom(follow) {
  if (follow) $('messageList').scrollTop = $('messageList').scrollHeight;
  $('jumpToLatestBtn').hidden = nearBottom();
}
function updateCounter() {
  const length = Array.from($('textInput').value.trim()).length;
  $('charCounter').textContent = `${length} / ${getMaxCharCount()} 字`;
  $('charCounter').style.color = length > getMaxCharCount() ? 'var(--error-text)' : '';
  $('generateBtn').disabled = !ready || length < getMinCharCount() || length > getMaxCharCount();
}
function formatTimestamp(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function formatFullTimestamp(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function updateNewConversationBtnState() {
  const btn = $('newConversationBtn');
  if (!btn) return;
  const current = activeConversation();
  const hasEmpty = current && current.messages.length === 0;
  if (hasEmpty) {
    btn.title = '当前已是新会话，输入文字即可开始';
    btn.classList.add('is-idle');
  } else {
    btn.title = '新建会话';
    btn.classList.remove('is-idle');
  }
}

function renderConversations() {
  const conversations = store.list();
  $('conversationCount').textContent = conversations.length;
  $('conversationList').innerHTML = conversations.map(c => {
    const timeFormatted = formatTimestamp(c.createdAt);
    const fullTime = formatFullTimestamp(c.createdAt);
    const timeDisplay = timeFormatted ? `创建于 ${timeFormatted}` : '';
    const tooltip = fullTime ? `创建时间：${fullTime}` : escapeHtml(c.title);
    return `
    <div class="conversation-row ${c.id === activeId ? 'active' : ''}" title="${escapeHtml(tooltip)}">
      <button class="conversation-select" data-conversation-id="${escapeHtml(c.id)}" ${c.id === activeId ? 'aria-current="true"' : ''} title="${escapeHtml(tooltip)}">
        <strong title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</strong>
        <div class="conversation-meta">
          <small class="conversation-count-text">${c.messages.length} 条文本 · ${c.messages.length ? '语音会话' : '等待第一条文本'}</small>
          <small class="conversation-time-hover">${escapeHtml(timeDisplay)}</small>
        </div>
      </button><button class="delete-conversation" data-delete-id="${escapeHtml(c.id)}" aria-label="删除会话 ${escapeHtml(c.title)}" title="删除会话">×</button>
    </div>`;
  }).join('');
  $('conversationTitle').textContent = activeConversation()?.title || '新会话';
  updateNewConversationBtnState();
}
function clearCards() {
  cards.forEach(card => card.player?.dispose());
  cards.clear();
  $('messageList').replaceChildren();
}
function renderAudio(conversationId, message, card, blob = null) {
  const signature = JSON.stringify(message.audio);
  if (card.signature === signature) return;
  card.signature = signature;
  card.player?.dispose();
  card.player = null;
  const body = card.node.querySelector('.audio-card');
  const engineId = message.engine || 'edge';
  const engineName = engineId === 'gemini' ? 'Gemini TTS' : 'Edge TTS';
  const voiceRaw = message.voice || 'ja-JP-NanamiNeural';
  const voiceLabel = getVoiceLabel(voiceRaw, voiceRaw || '默认音色');

  let langTag = '日本語';
  if (voiceRaw.startsWith('zh') || voiceLabel.includes('中文')) langTag = '中文';
  else if (voiceRaw.startsWith('en') || voiceLabel.includes('英语')) langTag = 'English';
  else if (voiceRaw.startsWith('ja') || voiceLabel.includes('日')) langTag = '日本語';
  else if (engineId === 'gemini') langTag = '多语言';

  const charCount = Array.from(message.text || '').length;

  body.innerHTML = `
    <div class="audio-meta audio-card-header">
      <div class="audio-card-voice-info">
        <span class="voice-icon" aria-hidden="true">♫</span>
        <div class="voice-details">
          <strong class="voice-name" title="${escapeHtml(voiceLabel)}">${escapeHtml(voiceLabel)}</strong>
          <div class="voice-tags">
            <span class="tag-pill tag-lang">${escapeHtml(langTag)}</span>
            <span class="tag-pill tag-chars">${charCount} 字</span>
          </div>
        </div>
      </div>
      <div class="audio-card-engine-info">
        <span class="engine-badge ${engineId === 'gemini' ? 'badge-gemini' : 'badge-edge'}" title="${escapeHtml(engineName)}">
          ${escapeHtml(engineName)}
        </span>
      </div>
    </div>`;
  const status = message.audio.status;
  if (status === 'ready') {
    card.player = new MessagePlayer(body, message, () => safely(() => {
      if (store.updateAudio(conversationId, message.id, { status: 'expired', error: '' })) renderMessages();
    }), blob);
  } else if (status === 'pending') {
    body.insertAdjacentHTML('beforeend', '<div class="audio-status" role="status"><span class="pending-dot"></span>正在生成语音…</div>');
  } else {
    const label = status === 'expired' ? '音频已失效，原文和生成参数仍然保留。' : message.audio.error || '生成失败，请重试。';
    body.insertAdjacentHTML('beforeend', `<div class="audio-status ${status === 'error' ? 'is-error' : ''}" role="status">${escapeHtml(label)}</div>`);
    const retry = document.createElement('button');
    retry.className = 'audio-action retry-audio';
    retry.textContent = status === 'expired' ? '↻ 重新生成' : '↻ 重试生成';
    retry.addEventListener('click', () => generate(conversationId, message.id));
    body.appendChild(retry);
  }
}
function renderMessages(blobMessageId = null, blob = null) {
  const follow = nearBottom();
  const conversation = activeConversation();
  const list = $('messageList');
  if (!conversation?.messages.length) {
    clearCards();
    list.innerHTML = `<div class="chat-empty"><div class="empty-eyebrow">A SPACE FOR YOUR WORDS</div><h2>写下来，听见它。</h2><p>从一句问候、一段故事，开始你的语音会话。<br>选择声音，发送文字，让每一句都被听见。</p><div class="sample-chips"><button data-sample="こんにちは。今日も良い一日をお過ごしください。">日常问候 ↗</button><button data-sample="東京へようこそ。ゆっくりと街の景色を楽しんでください。">旅行日语 ↗</button><button data-sample="むかしむかし、ある山奥に、小さな美しい花が咲いていました。">故事朗读 ↗</button></div></div>`;
    return;
  }
  list.querySelector('.chat-empty')?.remove();
  for (const message of conversation.messages) {
    let card = cards.get(message.id);
    if (!card) {
      const node = document.createElement('article');
      node.className = 'message-pair';
      node.dataset.messageId = message.id;
      const time = new Date(message.createdAt);
      const label = Number.isFinite(time.getTime()) ? time.toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
      node.innerHTML = `<div class="message-time">你 · ${escapeHtml(label)}</div><div class="user-message">${escapeHtml(message.text)}</div><div class="audio-response"><span class="assistant-avatar" aria-hidden="true">言</span><div class="audio-card"></div></div>`;
      card = { node, signature: null, player: null };
      cards.set(message.id, card);
      list.appendChild(node);
    }
    renderAudio(conversation.id, message, card, message.id === blobMessageId ? blob : null);
  }
  followBottom(follow);
}
function bindAI(force = false) {
  const message = activeConversation()?.messages.at(-1);
  const targetId = message ? `${activeId}:${message.id}` : null;
  if (!force && targetId === aiTargetId) return;
  aiTargetId = targetId;
  resetExplanation();
  setCurrentExplainText(message?.text || null, message ? `${activeId}_${message.id}` : null);
  $('explainChatInput').value = '';
  $('explainTarget').textContent = message?.text || '发送一段文本，开始阅读。';
  renderExplainEmpty();
  if (message) requestExplanation(message.text);
}
function selectConversation(id) {
  if (activeId) {
    drafts.set(activeId, $('textInput').value);
    scrollPositions.set(activeId, $('messageList').scrollTop);
  }
  activeId = id;
  localStorage.setItem(activeStorageKey, id);
  $('textInput').value = drafts.get(id) || '';
  clearCards();
  renderConversations();
  renderMessages();
  $('messageList').scrollTop = scrollPositions.get(id) ?? $('messageList').scrollHeight;
  followBottom(false);
  bindAI();
  updateCounter();
  if (narrow.matches) { leftOpen = false; syncPanels(); }
}
function createConversation() {
  const current = activeConversation();
  if (current && current.messages.length === 0) {
    $('textInput').focus();
    return current;
  }
  const emptyExisting = store.list().find(c => c.messages.length === 0);
  if (emptyExisting) {
    selectConversation(emptyExisting.id);
    $('textInput').focus();
    return emptyExisting;
  }
  const conversation = store.create();
  selectConversation(conversation.id);
  $('textInput').focus();
  return conversation;
}
async function generate(conversationId, messageId) {
  const token = `${conversationId}:${messageId}`;
  if (pending.has(token)) return;
  const message = store.get(conversationId)?.messages.find(m => m.id === messageId);
  if (!message) return;
  pending.add(token);
  try {
    store.updateAudio(conversationId, messageId, { status: 'pending', error: '' });
    if (activeId === conversationId) renderMessages();
    const headers = { 'Content-Type': 'application/json', 'X-Client-ID': getClientId() };
    const key = getApiKey();
    if (message.engine === 'gemini' && key) headers['X-Gemini-Api-Key'] = key;
    const response = await apiFetch('/api/tts', { method: 'POST', headers,
      body: JSON.stringify({ text: message.text, engine: message.engine, voice: message.voice || null }) });
    if (!response.ok) await handleResponseError(response);
    const cacheKey = response.headers.get('X-Cache-Key');
    if (!/^(?:[a-f0-9]{16}|[a-f0-9]{64})$/.test(cacheKey || '')) throw new Error('服务器未返回有效的音频标识，请重试。');
    const blob = await response.blob();
    const saved = store.updateAudio(conversationId, messageId, { status: 'ready', cacheKey, error: '' });
    if (saved && activeId === conversationId) renderMessages(messageId, blob);
  } catch (error) {
    try {
      if (store.updateAudio(conversationId, messageId, { status: 'error', error: error.message || '生成失败，请重试。' }) && activeId === conversationId) renderMessages();
    } catch (storageError) { showError(storageError.message); }
  } finally { pending.delete(token); }
}
function sendText(event) {
  event?.preventDefault();
  const text = $('textInput').value.trim();
  const length = Array.from(text).length;
  if (!ready) return;
  if (length < getMinCharCount() || length > getMaxCharCount()) {
    showError(`请输入 ${getMinCharCount()} 至 ${getMaxCharCount()} 字。`);
    return;
  }
  safely(() => {
    let currentConv = activeConversation();
    if (!currentConv) {
      currentConv = store.create();
      activeId = currentConv.id;
      localStorage.setItem(activeStorageKey, activeId);
    }
    const message = store.append(activeId, text, { engine: getSelectedEngine(), voice: getSelectedVoice() });
    $('textInput').value = '';
    drafts.delete(activeId);
    hideError();
    renderConversations();
    renderMessages();
    bindAI();
    updateCounter();
    generate(activeId, message.id);
  });
}
function syncPanels() {
  const left = $('conversationSidebar');
  const right = $('explainSection');
  const overlay = narrow.matches && (leftOpen || rightOpen);
  $('chatMain').inert = overlay;
  if (!leftOpen && left.contains(document.activeElement)) $('historyBtn').focus();
  if (!rightOpen && right.contains(document.activeElement)) $('aiPanelBtn').focus();
  left.hidden = !leftOpen;
  right.hidden = !rightOpen;
  left.inert = !leftOpen;
  right.inert = !rightOpen;
  left.setAttribute('aria-hidden', String(!leftOpen));
  right.setAttribute('aria-hidden', String(!rightOpen));
  $('historyBtn').setAttribute('aria-expanded', String(leftOpen));
  $('aiPanelBtn').setAttribute('aria-expanded', String(rightOpen));
  $('sidebarBackdrop').hidden = !overlay;
  adjustForAvailableSpace();
  if (overlay && !((leftOpen ? left : right).contains(document.activeElement))) {
    (leftOpen ? $('sidebarCloseBtn') : $('aiCloseBtn')).focus();
  }
}
function togglePanel(side) {
  if (side === 'left') {
    leftOpen = !leftOpen;
    if (narrow.matches && leftOpen) rightOpen = false;
  } else {
    rightOpen = !rightOpen;
    if (narrow.matches && rightOpen) leftOpen = false;
  }
  if (!narrow.matches) {
    localStorage.setItem('tts_chat_left_open', leftOpen ? '1' : '0');
    localStorage.setItem('tts_chat_right_open', rightOpen ? '1' : '0');
  }
  syncPanels();
}
async function migrateHistory() {
  if (store.migrated) return;
  try {
    const response = await apiFetch('/api/history', { headers: { 'X-Client-ID': getClientId() } });
    if (!response.ok) throw new Error('历史记录暂时无法导入，原有数据仍然保留。');
    store.migrate(await response.json());
    $('migrationRetryBtn').hidden = true;
    const imported = store.list().find(c => c.id !== provisionalId);
    if (provisionalId && activeId === provisionalId && !activeConversation()?.messages.length && !$('textInput').value && imported) {
      store.remove(provisionalId);
      selectConversation(imported.id);
    } else renderConversations();
    provisionalId = null;
    hideError();
  } catch (error) {
    $('migrationRetryBtn').hidden = false;
    showError(error.message);
  }
}
async function init() {
  $('generateBtn').disabled = true;
  initSettings({ onLimitsLoaded: limits => {
    setRequestTimeoutMs((limits.requestTimeoutSeconds + 15) * 1000);
    updateCounter();
  } });
  initCopilot();
  initSidebarResizers({
    isLeftOpen: () => leftOpen,
    isRightOpen: () => rightOpen,
  });
  $('composer').addEventListener('submit', sendText);
  $('textInput').addEventListener('input', updateCounter);
  $('textInput').addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) sendText(event);
  });
  $('newConversationBtn').addEventListener('click', () => safely(createConversation));
  $('conversationList').addEventListener('click', event => {
    const remove = event.target.closest('[data-delete-id]');
    if (remove) {
      const id = remove.dataset.deleteId;
      if (!confirm('删除这个会话及其中的文本记录？此操作无法撤销。')) return;
      safely(() => {
        store.remove(id);
        drafts.delete(id);
        if (id === activeId) selectConversation(store.list()[0]?.id || store.create().id);
        else renderConversations();
      });
      return;
    }
    const button = event.target.closest('[data-conversation-id]');
    if (button) safely(() => selectConversation(button.dataset.conversationId));
  });
  $('messageList').addEventListener('scroll', () => { $('jumpToLatestBtn').hidden = nearBottom(); });
  $('messageList').addEventListener('click', event => {
    const sample = event.target.closest('[data-sample]');
    if (sample) { $('textInput').value = sample.dataset.sample; updateCounter(); $('textInput').focus(); }
  });
  $('jumpToLatestBtn').addEventListener('click', () => followBottom(true));
  $('historyBtn').addEventListener('click', () => togglePanel('left'));
  $('sidebarCloseBtn').addEventListener('click', () => togglePanel('left'));
  $('aiPanelBtn').addEventListener('click', () => togglePanel('right'));
  $('aiCloseBtn').addEventListener('click', () => togglePanel('right'));
  $('sidebarBackdrop').addEventListener('click', () => { leftOpen = false; rightOpen = false; syncPanels(); });
  $('errorCloseBtn').addEventListener('click', hideError);
  $('migrationRetryBtn').addEventListener('click', migrateHistory);
  narrow.addEventListener('change', () => {
    leftOpen = !narrow.matches && localStorage.getItem('tts_chat_left_open') !== '0';
    rightOpen = !narrow.matches && localStorage.getItem('tts_chat_right_open') !== '0';
    syncPanels();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (isSettingsModalOpen()) closeSettingsModal();
      else { leftOpen = false; rightOpen = false; syncPanels(); }
    }
    if (event.key === 'Tab' && narrow.matches && (leftOpen || rightOpen)) {
      const panel = leftOpen ? $('conversationSidebar') : $('explainSection');
      const focusable = [...panel.querySelectorAll('button,select,input,textarea,a[href]')].filter(el => !el.disabled && el.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  syncPanels();
  const clientId = getClientId();
  activeStorageKey = `tts_active_conversation:${clientId}`;
  store = new ConversationStore(localStorage, clientId);
  store.recoverPending();
  const saved = localStorage.getItem(activeStorageKey);
  const initial = store.get(saved)?.id || store.list()[0]?.id;
  if (!initial) provisionalId = store.create().id;
  selectConversation(initial || provisionalId);
  // Optional services cannot block restored text or TTS readiness.
  loadCopilotModels().then(() => bindAI(true)).catch(error => showError(error.message));
  migrateHistory();
  await loadEngines();
  ready = true;
  updateCounter();
  document.body.dataset.ready = 'true';
  window.addEventListener('storage', event => {
    if (event.key === store.key) safely(() => {
      if (!activeConversation()) selectConversation(store.list()[0]?.id || store.create().id);
      else { renderConversations(); renderMessages(); bindAI(); }
    });
    if (event.key === 'tts_client_id') location.reload();
  });
}
init().catch(error => showError(error.message || '页面初始化失败，请刷新重试。'));
