/**
 * TTS Web - Copilot Module
 * Manages AI explanation sessions, follow-up Q&A, markdown rendering, and streaming animations.
 */

import {
  apiFetch, getClientId, localizeErrorMessage, escapeHtml,
  getCopilotRequestTimeoutMs, setCopilotRequestTimeoutMs,
} from "./api.js";

const EXPLAIN_LANG_NAMES = { zh: "中文", ja: "日语", en: "英语" };

let availableCopilotModels = [];
let explainEnabled = localStorage.getItem("tts_explain_enabled") !== "0";
let explainLang = localStorage.getItem("tts_explain_lang") || "zh";
if (!EXPLAIN_LANG_NAMES[explainLang]) explainLang = "zh";
let explainModel = localStorage.getItem("tts_explain_model") || "";
let explainThinking = localStorage.getItem("tts_explain_mode") || "";

let currentExplainKey = null;
let currentExplainText = null;
let currentExplainContext = null;
let currentExplainLang = null;
let currentExplainModel = null;
let currentExplainThinking = null;

let explainLoading = false;
let chatPending = false;
let activeExplainReveal = null;
let explainRevealFrame = null;
let explainGeneration = 0;
let chatGeneration = 0;

let explainToggle = null;
let explainLangSelect = null;
let explainModelSelect = null;
let explainThinkingSelect = null;
let explainSection = null;
let explainMessages = null;
let explainChatInput = null;
let explainSendBtn = null;
let explainOptionsToggleBtn = null;
let explainOptionsPopover = null;
let explainOptionsCloseBtn = null;

export function setOptionsPopoverVisible(visible) {
  if (!explainOptionsPopover) return;
  if (visible) {
    explainOptionsPopover.removeAttribute("hidden");
    explainOptionsToggleBtn?.setAttribute("aria-expanded", "true");
    explainOptionsToggleBtn?.classList.add("active");
  } else {
    explainOptionsPopover.setAttribute("hidden", "");
    explainOptionsToggleBtn?.setAttribute("aria-expanded", "false");
    explainOptionsToggleBtn?.classList.remove("active");
  }
}

export function isExplainLoading() {
  return explainLoading;
}

export function isChatPending() {
  return chatPending;
}

export function getCurrentExplainText() {
  return currentExplainText;
}

export function setCurrentExplainText(text, contextId = null) {
  invalidateExplainSession();
  currentExplainText = text;
  currentExplainContext = contextId;
  updateExplainInputState();
}

export function getCurrentExplainKey() {
  return currentExplainKey;
}

export function clearExplainSession() {
  invalidateExplainSession();
  currentExplainKey = null;
  currentExplainText = null;
  currentExplainContext = null;
}

function invalidateExplainSession() {
  explainGeneration += 1;
  chatGeneration += 1;
  currentExplainKey = null;
  explainLoading = false;
  chatPending = false;
  cancelExplainReveal();
  updateExplainInputState();
  return explainGeneration;
}

export function resetExplanation() {
  clearExplainSession();
  renderExplainEmpty();
}

export function selectedCopilotModel() {
  return availableCopilotModels.find((model) => model.id === explainModel) || null;
}

export function populateReasoningModes(preferredMode = "") {
  const model = selectedCopilotModel();
  if (!explainThinkingSelect) return;
  explainThinkingSelect.replaceChildren();
  (model?.modes || []).forEach((mode) => {
    const option = document.createElement("option");
    option.value = mode.id;
    option.textContent = mode.name;
    option.title = mode.description || mode.name;
    explainThinkingSelect.appendChild(option);
  });
  const supported = model?.modes?.some((mode) => mode.id === preferredMode);
  explainThinking = supported ? preferredMode : (model?.modes?.[0]?.id || "");
  explainThinkingSelect.value = explainThinking;
  explainThinkingSelect.disabled = !model;
  if (explainThinking) localStorage.setItem("tts_explain_mode", explainThinking);
}

export async function loadCopilotModels() {
  try {
    const response = await apiFetch("/api/copilot/models", {
      headers: { "X-Client-ID": getClientId() },
    }, getCopilotRequestTimeoutMs());
    if (!response.ok) throw new Error("model catalog unavailable");
    const data = await response.json();
    // Backend deadline covers queueing and generation; allow response transfer afterward.
    const budget = data.request_timeout_seconds;
    setCopilotRequestTimeoutMs(Number.isFinite(budget) && budget > 0 ? (budget + 15) * 1000 : 195000);
    availableCopilotModels = Array.isArray(data.models) ? data.models : [];
  } catch (error) {
    console.error("Copilot catalog error:", error);
    availableCopilotModels = [];
  }

  if (explainModelSelect) {
    explainModelSelect.replaceChildren();
    availableCopilotModels.forEach((model) => {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.name;
      explainModelSelect.appendChild(option);
    });
  }
  const preferred = availableCopilotModels.find((model) => model.id === explainModel);
  const fallback = availableCopilotModels.find((model) => model.default) || availableCopilotModels[0];
  explainModel = (preferred || fallback)?.id || "";
  if (explainModelSelect) {
    explainModelSelect.value = explainModel;
    explainModelSelect.disabled = !explainModel;
  }
  if (explainModel) localStorage.setItem("tts_explain_model", explainModel);
  populateReasoningModes(explainThinking);

  const available = !!explainModel;
  if (!available) {
    explainEnabled = false;
    if (explainToggle) {
      explainToggle.checked = false;
      explainToggle.disabled = true;
      explainToggle.title = "AI 讲解服务暂未配置";
    }
    hideExplainSection();
  }
  updateExplainInputState();
}

function getExplainHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Client-ID": getClientId(),
  };
}

export function updateExplainLangBadge() {
  if (explainSection) {
    explainSection.setAttribute("data-lang", explainLang);
  }
  if (explainMessages) {
    explainMessages.setAttribute("data-lang", explainLang);
  }
}

export function updateExplainInputState() {
  const busy = explainLoading || chatPending || !explainModel || !currentExplainText;
  if (explainSendBtn) explainSendBtn.disabled = busy;
  if (explainChatInput) explainChatInput.disabled = busy;
  const bubbleRetryBtns = document.querySelectorAll(".explain-retry-bubble-btn");
  bubbleRetryBtns.forEach((btn) => {
    btn.disabled = busy;
  });
  const emptyStartBtn = document.getElementById("explainEmptyStartBtn");
  if (emptyStartBtn) {
    emptyStartBtn.disabled = busy;
  }
  const suggestChips = document.querySelectorAll(".explain-suggestions .suggest-chip");
  suggestChips.forEach((chip) => {
    chip.disabled = busy;
  });
}

export function renderExplainEmpty() {
  if (!explainMessages) return;
  cancelExplainReveal();
  explainMessages.innerHTML = `
    <div class="explain-empty-card">
      <h4 class="explain-empty-title">${currentExplainText ? "读懂每一句话" : "从一段文字开始"}</h4>
      <p class="explain-empty-desc">${currentExplainText
        ? "查看翻译、理解语法，或围绕这段文本提问。"
        : "发送文本后，这里会关联最新一条原文。输入框里的草稿不会用于 AI 解说。"}</p>
      ${currentExplainText ? `<button type="button" class="explain-empty-start-btn" id="explainEmptyStartBtn"><span class="retry-icon">✧</span> 开始解说</button>` : ""}
    </div>`;
  const startBtn = document.getElementById("explainEmptyStartBtn");
  if (startBtn) {
    startBtn.addEventListener("click", () => {
      if (currentExplainText && !explainLoading && !chatPending) {
        requestExplanation(currentExplainText, { manual: true });
      }
    });
  }
}

export function hideExplainSection() {
  invalidateExplainSession();
  setOptionsPopoverVisible(false);
  renderExplainEmpty();
}

export function formatInlineMarkdown(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\\])\*([^*\s](?:[^*]*[^*\s])?)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\\])_([^_\s](?:[^_]*[^_\s])?)_/g, "$1<em>$2</em>");
  return s;
}

export function renderMarkdown(rawText) {
  if (!rawText) return "";
  const lines = rawText.split("\n");
  const output = [];
  let inUl = false;
  let inOl = false;
  let inP = false;

  function closeList() {
    if (inUl) { output.push("</ul>"); inUl = false; }
    if (inOl) { output.push("</ol>"); inOl = false; }
  }

  function closeParagraph() {
    if (inP) { output.push("</p>"); inP = false; }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      closeParagraph();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      closeList();
      closeParagraph();
      const level = Math.min(headingMatch[1].length + 2, 4);
      output.push(`<h${level}>${formatInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    const boldHeadingMatch = trimmed.match(/^\*\*([^*]+)\*\*$/);
    if (boldHeadingMatch) {
      closeList();
      closeParagraph();
      output.push(`<h4>${formatInlineMarkdown(boldHeadingMatch[1])}</h4>`);
      continue;
    }

    const ulMatch = line.match(/^(\s*)[*-]\s+(.+)$/);
    if (ulMatch) {
      closeParagraph();
      if (inOl) { output.push("</ol>"); inOl = false; }
      if (!inUl) { output.push("<ul>"); inUl = true; }
      output.push(`<li>${formatInlineMarkdown(ulMatch[2])}</li>`);
      continue;
    }

    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (olMatch) {
      closeParagraph();
      if (inUl) { output.push("</ul>"); inUl = false; }
      if (!inOl) { output.push("<ol>"); inOl = true; }
      output.push(`<li>${formatInlineMarkdown(olMatch[2])}</li>`);
      continue;
    }

    const bqMatch = trimmed.match(/^>\s*(.+)$/);
    if (bqMatch) {
      closeList();
      closeParagraph();
      output.push(`<blockquote>${formatInlineMarkdown(bqMatch[1])}</blockquote>`);
      continue;
    }

    closeList();
    if (!inP) {
      output.push("<p>" + formatInlineMarkdown(trimmed));
      inP = true;
    } else {
      output.push("<br>" + formatInlineMarkdown(trimmed));
    }
  }

  closeList();
  closeParagraph();
  return output.join("");
}

export async function copyToClipboard(text) {
  if (!text) return false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fallback
    }
  }
  try {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.top = "-9999px";
    textArea.style.left = "-9999px";
    textArea.setAttribute("readonly", "");
    document.body.appendChild(textArea);
    textArea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textArea);
    return ok;
  } catch (err) {
    console.error("Copy failed:", err);
    return false;
  }
}

const COPY_ICON_SVG = `<svg class="action-icon icon-copy" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const CHECK_ICON_SVG = `<svg class="action-icon icon-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:none"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
const RETRY_ICON_SVG = `<svg class="action-icon icon-retry" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"></polyline><polyline points="23 20 23 14 17 14"></polyline><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path></svg>`;

export function appendExplainBubble(role, content, options = {}) {
  if (!explainMessages) return null;
  const div = document.createElement("div");
  div.className = "explain-msg " + (role === "user" ? "explain-msg-user" : "explain-msg-assistant");
  if (explainLang) {
    div.setAttribute("data-lang", explainLang);
  }
  if (role === "assistant") {
    const body = document.createElement("div");
    body.className = "explain-msg-body";
    body.innerHTML = renderMarkdown(content);
    div.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "explain-msg-actions";
    if (options.pendingStream) {
      actions.style.display = "none";
    }

    const copyBtn = document.createElement("button");
    copyBtn.className = "explain-action-btn explain-copy-btn";
    copyBtn.type = "button";
    copyBtn.title = "复制内容";
    copyBtn.setAttribute("aria-label", "复制内容");
    copyBtn.innerHTML = COPY_ICON_SVG + CHECK_ICON_SVG;
    copyBtn.addEventListener("click", async () => {
      const ok = await copyToClipboard(content);
      if (ok) {
        copyBtn.classList.add("is-copied");
        copyBtn.title = "已复制";
        copyBtn.setAttribute("aria-label", "已复制");
        const iconCopy = copyBtn.querySelector(".icon-copy");
        const iconCheck = copyBtn.querySelector(".icon-check");
        if (iconCopy) iconCopy.style.display = "none";
        if (iconCheck) iconCheck.style.display = "block";
        setTimeout(() => {
          copyBtn.classList.remove("is-copied");
          copyBtn.title = "复制内容";
          copyBtn.setAttribute("aria-label", "复制内容");
          if (iconCopy) iconCopy.style.display = "block";
          if (iconCheck) iconCheck.style.display = "none";
        }, 1800);
      }
    });
    actions.appendChild(copyBtn);

    if (options.onRetry || options.isMainExplanation) {
      const retryBtn = document.createElement("button");
      retryBtn.className = "explain-action-btn explain-retry-bubble-btn";
      retryBtn.type = "button";
      retryBtn.title = "重新生成";
      retryBtn.setAttribute("aria-label", "重新生成");
      retryBtn.disabled = explainLoading || chatPending || !explainModel || !currentExplainText;
      retryBtn.innerHTML = RETRY_ICON_SVG;
      const retryHandler = options.onRetry || (() => {
        if (currentExplainText && !explainLoading && !chatPending) {
          requestExplanation(currentExplainText, { manual: true });
        }
      });
      retryBtn.addEventListener("click", () => {
        if (!explainLoading && !chatPending) {
          retryHandler();
        }
      });
      actions.appendChild(retryBtn);
    }

    div.appendChild(actions);
  } else {
    div.textContent = content;
  }
  explainMessages.appendChild(div);
  explainMessages.scrollTop = explainMessages.scrollHeight;
  return div;
}

export function cancelExplainReveal() {
  if (!activeExplainReveal) return;
  if (explainRevealFrame !== null) cancelAnimationFrame(explainRevealFrame);
  activeExplainReveal.element.classList.remove("is-streaming");
  if (activeExplainReveal.actionsEl) {
    activeExplainReveal.actionsEl.style.display = "";
  }
  const resolve = activeExplainReveal.resolve;
  activeExplainReveal = null;
  explainRevealFrame = null;
  resolve();
}

export function streamExplainBubble(content, generation = explainGeneration, options = {}) {
  if (generation !== explainGeneration) return Promise.resolve();
  cancelExplainReveal();
  const div = appendExplainBubble("assistant", content, { ...options, pendingStream: true });
  if (!div) return Promise.resolve();

  const bodyEl = div.querySelector(".explain-msg-body") || div;
  const actionsEl = div.querySelector(".explain-msg-actions");

  const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT);
  const segments = [];
  let node = walker.nextNode();
  let totalChars = 0;
  while (node) {
    const chars = Array.from(node.textContent || "");
    segments.push({ node, chars });
    totalChars += chars.length;
    node.textContent = "";
    node = walker.nextNode();
  }
  if (!totalChars) {
    if (actionsEl) actionsEl.style.display = "";
    return Promise.resolve();
  }

  div.classList.add("is-streaming");
  const shouldFollow =
    explainMessages.scrollHeight - explainMessages.scrollTop - explainMessages.clientHeight < 80;
  const duration = Math.min(9000, Math.max(2400, totalChars * 14));

  return new Promise((resolve) => {
    const startedAt = performance.now();
    let revealed = 0;
    let segmentIndex = 0;
    let charIndex = 0;
    let lastPaintAt = 0;
    activeExplainReveal = { element: div, resolve, actionsEl };

    function revealFrame(now) {
      if (generation !== explainGeneration || !activeExplainReveal || activeExplainReveal.element !== div) return;
      if (lastPaintAt && now - lastPaintAt < 28) {
        explainRevealFrame = requestAnimationFrame(revealFrame);
        return;
      }
      lastPaintAt = now;
      const elapsedRatio = Math.min(1, (now - startedAt) / duration);
      const target = Math.min(
        totalChars,
        Math.max(revealed + 1, Math.floor(elapsedRatio * totalChars))
      );

      while (revealed < target && segmentIndex < segments.length) {
        const segment = segments[segmentIndex];
        const take = Math.min(target - revealed, segment.chars.length - charIndex);
        if (take > 0) {
          segment.node.appendData(segment.chars.slice(charIndex, charIndex + take).join(""));
          charIndex += take;
          revealed += take;
        }
        if (charIndex >= segment.chars.length) {
          segmentIndex += 1;
          charIndex = 0;
        }
      }

      if (shouldFollow) explainMessages.scrollTop = explainMessages.scrollHeight;
      if (revealed < totalChars) {
        explainRevealFrame = requestAnimationFrame(revealFrame);
        return;
      }
      div.classList.remove("is-streaming");
      if (actionsEl) actionsEl.style.display = "";
      activeExplainReveal = null;
      explainRevealFrame = null;
      resolve();
    }

    explainRevealFrame = requestAnimationFrame(revealFrame);
  });
}

export async function renderExplainMessages(explanation, messages, options = {}) {
  const generation = options.generation ?? explainGeneration;
  if (!explainMessages || generation !== explainGeneration) return;
  cancelExplainReveal();
  explainMessages.innerHTML = "";
  if (explainLang) {
    explainMessages.setAttribute("data-lang", explainLang);
  }
  if (explanation) {
    const mainOpts = { isMainExplanation: true };
    if (options.stream) await streamExplainBubble(explanation, generation, mainOpts);
    else appendExplainBubble("assistant", explanation, mainOpts);
  }
  if (generation !== explainGeneration) return;
  let lastUserMsg = null;
  (messages || []).forEach((m) => {
    if (m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") {
      if (m.role === "user") {
        lastUserMsg = m.content;
        appendExplainBubble("user", m.content);
      } else {
        const question = lastUserMsg;
        appendExplainBubble("assistant", m.content, {
          onRetry: question ? () => sendExplainChat(question, { isRetry: true }) : null,
        });
      }
    }
  });
}

export function showExplainLoading() {
  if (!explainMessages) return;
  cancelExplainReveal();
  explainMessages.innerHTML = "";
  const div = document.createElement("div");
  div.className = "explain-loading";
  div.appendChild(document.createTextNode("AI 正在理解这句话"));
  const dots = document.createElement("span");
  dots.className = "explain-loading-dots";
  div.appendChild(dots);
  explainMessages.appendChild(div);
}

export async function requestExplanation(text, opts = {}) {
  const manual = !!opts.manual;
  if (!text?.trim() || (!explainEnabled && !manual) || !explainModel || !explainThinking) return;
  const lang = explainLang;
  const model = explainModel;
  const thinking = explainThinking;

  const sameExplanation =
    currentExplainText === text &&
    currentExplainLang === lang &&
    currentExplainModel === model &&
    currentExplainThinking === thinking;
  if (!manual && sameExplanation && (currentExplainKey || explainLoading)) return;

  const generation = invalidateExplainSession();
  currentExplainText = text;
  currentExplainLang = lang;
  currentExplainModel = model;
  currentExplainThinking = thinking;
  currentExplainKey = null;
  updateExplainLangBadge();
  showExplainLoading();
  explainLoading = true;
  updateExplainInputState();
  try {
    const response = await apiFetch("/api/explain", {
      method: "POST",
      headers: getExplainHeaders(),
      body: JSON.stringify({ text, lang, model_id: model, mode_id: thinking, context_id: currentExplainContext }),
    }, getCopilotRequestTimeoutMs());
    if (generation !== explainGeneration) return;
    if (!response.ok) {
      let detail = "解说生成失败，请重试。";
      try {
        const data = await response.json();
        if (data && data.detail) detail = localizeErrorMessage(data.detail, detail);
      } catch {
        // keep default message
      }
      throw new Error(localizeErrorMessage(detail, "解说生成失败，请重试。"));
    }
    const data = await response.json();
    if (generation !== explainGeneration) return;
    currentExplainKey = data.explain_key;
    await renderExplainMessages(data.explanation, data.messages, { stream: !data.cached, generation });
  } catch (err) {
    if (generation !== explainGeneration) return;
    console.error("Explain request error:", err);
    await renderExplainMessages(`解说获取失败：${err.message || ""}`, [], { generation });
  } finally {
    if (generation === explainGeneration) {
      explainLoading = false;
      updateExplainInputState();
    }
  }
}

export async function sendExplainChat(customMessage = null, options = {}) {
  const isRetry = Boolean(options && options.isRetry);
  const isExplicitString = typeof customMessage === "string";
  const rawMessage = isExplicitString
    ? customMessage
    : (explainChatInput ? explainChatInput.value : "");
  const message = (typeof rawMessage === "string" ? rawMessage : "").trim();

  if (!message || chatPending || explainLoading) return;
  if (!currentExplainKey) {
    if (!currentExplainText) return;
    const targetGeneration = explainGeneration;
    await requestExplanation(currentExplainText, { manual: true });
    // requestExplanation creates exactly one new generation. A target/settings
    // change during the request invalidates this pending question as well.
    if (explainGeneration !== targetGeneration + 1 || !currentExplainKey) return;
    return sendExplainChat(message, { isRetry });
  }
  const sessionGeneration = explainGeneration;
  const generation = ++chatGeneration;
  const explainKey = currentExplainKey;
  const ownsSession = () => sessionGeneration === explainGeneration && generation === chatGeneration && explainKey === currentExplainKey;
  chatPending = true;
  updateExplainInputState();
  if (!isRetry) {
    appendExplainBubble("user", message);
    if (explainChatInput) explainChatInput.value = "";
  }
  try {
    const response = await apiFetch("/api/explain/chat", {
      method: "POST",
      headers: getExplainHeaders(),
      body: JSON.stringify({
        explain_key: explainKey,
        message,
        mode_id: explainThinking,
      }),
    }, getCopilotRequestTimeoutMs());
    if (!ownsSession()) return;
    if (!response.ok) {
      let detail = "发送失败，请重试。";
      try {
        const data = await response.json();
        if (data && data.detail) detail = localizeErrorMessage(data.detail, detail);
      } catch {
        // keep default message
      }
      throw new Error(localizeErrorMessage(detail, "发送失败，请重试。"));
    }
    const data = await response.json();
    if (!ownsSession()) return;
    await streamExplainBubble(data.answer, sessionGeneration, {
      onRetry: () => sendExplainChat(message, { isRetry: true }),
    });
  } catch (err) {
    if (!ownsSession()) return;
    console.error("Explain chat error:", err);
    appendExplainBubble("assistant", `发送失败：${err.message || ""}`, {
      onRetry: () => sendExplainChat(message, { isRetry: true }),
    });
  } finally {
    if (ownsSession()) {
      chatPending = false;
      updateExplainInputState();
    }
  }
}

export function initCopilot() {
  explainToggle = document.getElementById("explainToggle");
  explainLangSelect = document.getElementById("explainLangSelect");
  explainModelSelect = document.getElementById("explainModelSelect");
  explainThinkingSelect = document.getElementById("explainThinkingSelect");
  explainSection = document.getElementById("explainSection");
  explainMessages = document.getElementById("explainMessages");
  explainChatInput = document.getElementById("explainChatInput");
  explainSendBtn = document.getElementById("explainSendBtn");
  explainOptionsToggleBtn = document.getElementById("explainOptionsToggleBtn");
  explainOptionsPopover = document.getElementById("explainOptionsPopover");
  explainOptionsCloseBtn = document.getElementById("explainOptionsCloseBtn");

  if (explainOptionsToggleBtn) {
    explainOptionsToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isHidden = explainOptionsPopover ? explainOptionsPopover.hasAttribute("hidden") : true;
      setOptionsPopoverVisible(isHidden);
    });
  }

  if (explainOptionsCloseBtn) {
    explainOptionsCloseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setOptionsPopoverVisible(false);
    });
  }

  document.addEventListener("click", (e) => {
    if (
      explainOptionsPopover &&
      !explainOptionsPopover.hasAttribute("hidden") &&
      !explainOptionsPopover.contains(e.target) &&
      !explainOptionsToggleBtn?.contains(e.target)
    ) {
      setOptionsPopoverVisible(false);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && explainOptionsPopover && !explainOptionsPopover.hasAttribute("hidden")) {
      setOptionsPopoverVisible(false);
      explainOptionsToggleBtn?.focus();
    }
  });

  if (explainToggle) {
    explainToggle.checked = explainEnabled;
    explainToggle.addEventListener("change", () => {
      explainEnabled = explainToggle.checked;
      localStorage.setItem("tts_explain_enabled", explainEnabled ? "1" : "0");
      hideExplainSection();
      if (explainEnabled && currentExplainText) requestExplanation(currentExplainText);
      updateExplainInputState();
    });
  }

  if (explainLangSelect) {
    explainLangSelect.value = explainLang;
    explainLangSelect.addEventListener("change", () => {
      const v = explainLangSelect.value;
      if (EXPLAIN_LANG_NAMES[v]) {
        explainLang = v;
        localStorage.setItem("tts_explain_lang", v);
        hideExplainSection();
        updateExplainLangBadge();
        if (currentExplainText) requestExplanation(currentExplainText);
      }
    });
  }

  if (explainModelSelect) {
    explainModelSelect.addEventListener("change", () => {
      explainModel = explainModelSelect.value;
      localStorage.setItem("tts_explain_model", explainModel);
      populateReasoningModes("");
      hideExplainSection();
      if (currentExplainText) requestExplanation(currentExplainText);
    });
  }

  if (explainThinkingSelect) {
    explainThinkingSelect.addEventListener("change", () => {
      const v = explainThinkingSelect.value;
      if (selectedCopilotModel()?.modes?.some((mode) => mode.id === v)) {
        explainThinking = v;
        localStorage.setItem("tts_explain_mode", v);
        hideExplainSection();
        if (currentExplainText) requestExplanation(currentExplainText);
      }
    });
  }

  updateExplainLangBadge();
  renderExplainEmpty();

  if (explainSendBtn) {
    explainSendBtn.addEventListener("click", () => sendExplainChat());
  }

  if (explainChatInput) {
    explainChatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendExplainChat();
      }
    });
  }

  const explainSuggestions = document.querySelector(".explain-suggestions");
  if (explainSuggestions) {
    explainSuggestions.addEventListener("click", (e) => {
      const chip = e.target.closest(".suggest-chip");
      if (!chip || chip.disabled) return;
      const prompt = chip.getAttribute("data-prompt");
      if (prompt) {
        sendExplainChat(prompt);
      }
    });
  }
}
