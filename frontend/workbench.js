import { ArticleAPI } from './articles-api.js';
import { ArticleState } from './articles-state.js';
import { ArticleViews } from './article-views.js';
import { claimDraftOwner } from './article-drafts.js';
import { VocabStore, InlineWordPopover, VocabWorkspaceView, flashWordInArticlePreview } from './vocab.js';
import { setCurrentExplainText, requestExplanation } from './copilot.js';

/** Only the right content changes; the AI instance and editor nodes remain mounted. */
export async function initWorkbench({ account, showPanel, fillInput, onExternalAITarget }) {
  const draftLease = account ? await claimDraftOwner() : null;
  const $ = id => document.getElementById(id);
  const tabs = $('workspaceTabs'), library = $('articleLibrary'), vocab = $('vocabWorkspace'), ai = $('aiWorkspace');
  const storageKey = `tts_workbench_v1:${account ? `account_${account.id}` : 'guest'}`;
  const opened = [];
  let selected = 'ai';
  let selectionGeneration = 0;
  let alive = true;
  let restoreState = null;
  try { restoreState = JSON.parse(localStorage.getItem(storageKey)); } catch { /* start at AI */ }
  const positions = new Map(Object.entries(restoreState?.positions || {}));
  const notify = message => {
    if (!alive) return;
    $('workspaceNotice').textContent = message; $('workspaceNotice').hidden = false;
  };
  const state = account ? new ArticleState({ api: new ArticleAPI(account.id), storage: localStorage, accountId: account.id, draftOwner: draftLease.owner,
    onChange: entry => {
      if (entry.removed) {
        const index = opened.indexOf(entry.id);
        if (index >= 0) opened.splice(index, 1);
        if (selected === entry.id) selected = 'library';
      }
      views?.update(entry); render(); persist();
      if (entry.localError && entry.removed) notify(entry.localError);
    },
  }) : null;
  let views;
  function capturePositions() {
    for (const [id, node] of views?.nodes || []) {
      if (!node.hidden) positions.set(id, views.captureViewState(id));
    }
  }
  function persist() {
    if (!alive) return;
    capturePositions();
    const savedPositions = Object.fromEntries(opened.map(id => [id, positions.get(id) || views.captureViewState(id)]));
    try { localStorage.setItem(storageKey, JSON.stringify({ opened, selected, positions: savedPositions })); }
    catch { notify('工作台位置无法保存，请检查浏览器存储空间。'); }
  }
  function render() {
    capturePositions();
    const vocabCount = vocabStore.items.length;
    const vocabTitle = vocabCount > 0 ? `★ 生词本 (${vocabCount})` : '★ 生词本';
    const descriptors = [{ id: 'library', title: '文章库' }, { id: 'vocab', title: vocabTitle }, { id: 'ai', title: '✧ AI 助手' },
      ...opened.map(id => ({ id, title: state.entries.get(id)?.title || '未命名文章' }))];
    const previousScroll = tabs.scrollLeft;
    const focusId = document.activeElement?.dataset.workspaceTab;
    tabs.replaceChildren();
    for (const item of descriptors) {
      const group = document.createElement('div'); group.className = 'workspace-tab-group';
      const tab = document.createElement('button');
      tab.id = `tab-${item.id}`; tab.dataset.workspaceTab = item.id;
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(selected === item.id));
      tab.setAttribute('aria-controls', item.id === 'ai' ? 'aiWorkspace' : item.id === 'library' ? 'articleLibrary' : item.id === 'vocab' ? 'vocabWorkspace' : `article-panel-${item.id}`);
      tab.tabIndex = selected === item.id ? 0 : -1;
      tab.title = item.title; tab.textContent = item.title;
      tab.addEventListener('click', () => activate(item.id)); group.appendChild(tab);
      if (!['ai', 'library', 'vocab'].includes(item.id)) {
        const close = document.createElement('button'); close.className = 'workspace-tab-close';
        close.textContent = '×'; close.dataset.closeArticle = item.id;
        close.setAttribute('aria-label', `关闭标签 ${item.title}`);
        close.addEventListener('click', () => closeTab(item.id)); group.appendChild(close);
      }
      tabs.appendChild(group);
    }
    tabs.scrollLeft = previousScroll;
    if (focusId) tabs.querySelector(`[data-workspace-tab="${focusId}"]`)?.focus({ preventScroll: true });
    ai.hidden = selected !== 'ai'; library.hidden = selected !== 'library';
    if (vocab) vocab.hidden = selected !== 'vocab';
    $('articleEditors').hidden = ['ai', 'library', 'vocab'].includes(selected);
    for (const [id, node] of views?.nodes || []) {
      const wasHidden = node.hidden;
      node.hidden = selected !== id;
      if (node.hidden) node.articleReader?.pause();
      else views.restoreScroll(id, wasHidden);
    }
  }
  function activate(id, reveal = false, generation = null) {
    if (!alive) return;
    if (generation !== null && generation !== selectionGeneration) return;
    if (generation === null) selectionGeneration++;
    if (selected !== id) state?.flush(selected);
    selected = id;
    $('workspaceNotice').hidden = true;
    render(); persist();
    tabs.querySelector(`[data-workspace-tab="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (reveal) showPanel();
    if (id === 'library') views.run(() => views.refresh());
  }
  async function open(id, reveal = true, restoring = false) {
    if (!state || !alive) return;
    const generation = restoring ? selectionGeneration : ++selectionGeneration;
    const entry = await state.open(id);
    if (!alive || !entry || entry.deleting) return;
    if (!opened.includes(id)) opened.push(id);
    views.mount(entry, positions.get(id));
    if (restoring) { render(); persist(); }
    else if (generation === selectionGeneration) activate(id, reveal, generation);
    else { render(); persist(); }
    return entry;
  }
  async function closeTab(id) {
    selectionGeneration++;
    const node = views.nodes.get(id);
    await node?.articleEditor.finishInput();
    if (!alive || views.nodes.get(id) !== node) return;
    state?.flush(id).then(() => { if (alive && !opened.includes(id)) state.releaseSaved(id); });
    const index = opened.indexOf(id);
    if (index >= 0) opened.splice(index, 1);
    views.nodes.get(id)?.articleReader?.dispose();
    views.nodes.get(id)?.articleEditor.dispose(); views.nodes.get(id)?.remove(); views.nodes.delete(id);
    positions.delete(id);
    if (selected === id) selected = opened[Math.max(0, index - 1)] || 'library';
    render(); persist();
    tabs.querySelector('[aria-selected="true"]')?.focus();
  }
  const vocabStore = new VocabStore({ accountId: account?.id || null, storage: localStorage });
  const wordPopover = new InlineWordPopover({ store: vocabStore, notify });
  const explainSentence = (text, articleId) => {
    if (!text?.trim()) return;
    onExternalAITarget?.();
    setCurrentExplainText(text, articleId ? `article_${articleId}` : null);
    if ($('explainChatInput')) $('explainChatInput').value = '';
    if ($('explainTarget')) $('explainTarget').textContent = text;
    activate('ai', true);
    requestExplanation(text, { manual: true });
  };
  views = new ArticleViews({ state, library, editors: $('articleEditors'), open,
    activateLibrary: () => activate('library'), fillInput, notify, onViewChange: persist,
    vocabStore, wordPopover, explainSentence });
  const vocabView = vocab ? new VocabWorkspaceView({
    container: vocab,
    store: vocabStore,
    notify,
    onLocateInArticle: async (articleId, word) => {
      if (!state || !articleId) return;
      try {
        await open(articleId, true);
        views.setMode(articleId, 'read');
        const node = views.nodes.get(articleId);
        const preview = node?.querySelector('.article-preview');
        if (preview) {
          requestAnimationFrame(() => flashWordInArticlePreview(preview, word));
        }
      } catch (err) {
        notify(err.message || '无法打开目标文章。');
      }
    },
  }) : null;
  const unsubVocabTab = vocabStore.subscribe(() => render());
  vocabStore.syncFromServer();
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...tabs.querySelectorAll('[role="tab"]')];
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length;
    event.preventDefault(); activate(buttons[next].dataset.workspaceTab); tabs.querySelector('[aria-selected="true"]').focus();
  });
  $('workspaceAddBtn').addEventListener('click', () => activate('library'));
  const online = () => state?.flushAll();
  const visibility = () => { if (document.visibilityState === 'hidden') { persist(); state?.flushAll(); } };
  const beforeUnload = event => {
    persist();
    if (state?.hasUnsaved) { state.flushAll(); event.preventDefault(); event.returnValue = ''; }
  };
  const dispose = () => {
    if (!alive) return;
    alive = false; unsubVocabTab?.(); vocabView?.dispose(); wordPopover?.dispose();
    state?.dispose(); draftLease?.dispose(); views.dispose(); opened.length = 0; tabs.replaceChildren();
    $('workspaceNotice').hidden = true; if (vocab) vocab.hidden = true; ai.hidden = false;
    window.removeEventListener('online', online); document.removeEventListener('visibilitychange', visibility);
    window.removeEventListener('beforeunload', beforeUnload);
  };
  const accountChanged = event => {
    if (event.key === 'tts_account_scope') dispose();
    else if (state && event.key?.startsWith(state.deletedKey()) && event.newValue) {
      state.markRemoved(event.key.slice(state.deletedKey().length));
    }
  };
  window.addEventListener('account-expired', dispose);
  window.addEventListener('storage', accountChanged);
  window.addEventListener('pagehide', dispose);
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  window.addEventListener('online', online); document.addEventListener('visibilitychange', visibility);
  window.addEventListener('beforeunload', beforeUnload);
  render();
  const restore = async () => {
    if (!state) return;
    const target = restoreState?.selected || 'ai';
    const restoreGeneration = selectionGeneration;
    const ids = [...new Set([...(Array.isArray(restoreState?.opened) ? restoreState.opened : []), ...state.draftIds()])];
    const errors = [];
    for (const id of ids) {
      if (!alive) return;
      try { await open(id, false, true); } catch (error) { errors.push(error.message); }
    }
    if (!alive) return;
    if (selectionGeneration === restoreGeneration) activate(['ai', 'library', 'vocab'].includes(target) || opened.includes(target) ? target : 'library');
    restoreState = null;
    if (errors.length) notify('部分文章未能恢复：' + [...new Set(errors)].join(' · '));
  };
  restore().catch(error => notify(error.message));
  return { state, activate, dispose, flush: () => state?.flushAll() };
}
