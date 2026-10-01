/**
 * TTS Web - History Module
 * Manages history records, sidebar drawer, playback actions, and deletions.
 */

import { apiFetch, getClientId, escapeHtml } from "./api.js";

const cacheKeyToText = new Map();
const historyDockMedia = window.matchMedia("(min-width: 1200px)");

let historySection = null;
let historyList = null;
let historyEmpty = null;
let historyBadge = null;
let headerHistoryBadge = null;
let navHistoryBadge = null;
let clearHistoryBtn = null;
let historyBtn = null;
let sidebarCloseBtn = null;
let sidebarBackdrop = null;
let sidebarHistoryNavBtn = null;
let sidebarFavNavBtn = null;
let sidebarFilesNavBtn = null;

let callbacks = {
  onReplay: () => {},
  onRegenerate: () => {},
  onSelectText: () => {},
  onError: () => {},
  getEngineLabel: (id) => id,
  getVoiceLabel: (id) => id,
};

export function getTextForCacheKey(cacheKey) {
  return cacheKeyToText.get(cacheKey) || null;
}

export function setTextForCacheKey(cacheKey, text) {
  if (cacheKey && text) {
    cacheKeyToText.set(cacheKey, text);
  }
}

function truncateText(text, maxLen = 36) {
  return text.length > maxLen ? text.substring(0, maxLen) + "…" : text;
}

function parseHistoryDateTime(dateStr) {
  if (typeof dateStr !== "string") return new Date(NaN);
  const value = dateStr.trim();
  // APIs normalize historical SQLite values on the server and supply an ISO
  // timestamp with an offset. A naive value cannot identify an absolute instant.
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return new Date(NaN);
  return new Date(value);
}

function formatRelativeTime(dateStr) {
  const date = parseHistoryDateTime(dateStr);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHour < 24) return `${diffHour} 小时前`;
  if (diffDay < 7) return `${diffDay} 天前`;

  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function showSidebarToast(message) {
  let toast = document.getElementById("sidebarToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "sidebarToast";
    toast.className = "sidebar-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove("visible");
  }, 2000);
}

export function syncSidebarLayout() {
  const open = Boolean(historySection?.classList.contains("open"));
  const overlay = open && !historyDockMedia.matches;
  document.body.classList.toggle("history-open", open);
  document.body.classList.toggle("drawer-open", overlay);
  sidebarBackdrop?.classList.toggle("active", overlay);
  const mainArea = document.querySelector(".main-area");
  if (mainArea) mainArea.inert = overlay;
  if (historySection) {
    historySection.inert = !open;
    historySection.setAttribute("aria-hidden", String(!open));
  }
  if (historyBtn) {
    const label = open ? "收起历史侧栏" : "展开历史侧栏";
    historyBtn.setAttribute("aria-expanded", String(open));
    historyBtn.setAttribute("aria-label", label);
    historyBtn.title = label;
  }
}

export function openSidebar() {
  if (historySection) historySection.classList.add("open");
  syncSidebarLayout();
  if (historyDockMedia.matches) localStorage.setItem("tts_history_expanded", "1");
  loadHistory().catch(() => {});
}

export function closeSidebar() {
  if (historySection?.contains(document.activeElement)) historyBtn?.focus();
  if (historySection) historySection.classList.remove("open");
  syncSidebarLayout();
  if (historyDockMedia.matches) localStorage.setItem("tts_history_expanded", "0");
}

export function isSidebarOpen() {
  return Boolean(historySection?.classList.contains("open"));
}

export async function loadHistory() {
  try {
    const response = await apiFetch("/api/history", {
      headers: { "X-Client-ID": getClientId() },
    });
    if (!response.ok) return;

    const records = await response.json();

    cacheKeyToText.clear();
    records.forEach((record) => {
      if (record.cache_key && typeof record.text === "string") {
        cacheKeyToText.set(record.cache_key, record.text);
      }
    });

    const countStr = String(records.length);
    if (historyBadge) historyBadge.textContent = countStr;
    if (headerHistoryBadge) headerHistoryBadge.textContent = countStr;
    if (navHistoryBadge) navHistoryBadge.textContent = countStr;

    if (clearHistoryBtn) {
      clearHistoryBtn.style.display = records.length > 0 ? "inline-block" : "none";
    }

    if (records.length === 0) {
      if (historyList) historyList.style.display = "none";
      if (historyEmpty) historyEmpty.style.display = "block";
      return;
    }

    if (historyList) historyList.style.display = "flex";
    if (historyEmpty) historyEmpty.style.display = "none";

    if (historyList) {
      historyList.innerHTML = records
        .map(
          (record) => `
        <li class="history-item" data-id="${escapeHtml(record.id)}" data-cache-key="${escapeHtml(record.cache_key)}" data-engine="${escapeHtml(record.engine || "edge")}" data-voice="${escapeHtml(record.voice || "")}">
          <div class="history-item-main">
            <button class="history-play-btn history-replay-btn" title="播放" aria-label="播放" ${record.audio_status === "unavailable" ? "disabled" : ""} data-cache-key="${escapeHtml(record.cache_key)}">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="6 4 20 12 6 20 6 4"></polygon>
              </svg>
            </button>
            <div class="history-text-wrap">
              <div class="history-text" title="${escapeHtml(record.text)}">${escapeHtml(truncateText(record.text, 36))}</div>
              <div class="history-detail">${escapeHtml(callbacks.getEngineLabel(record.engine, record.engine || "语音引擎"))} · ${escapeHtml(callbacks.getVoiceLabel(record.voice))}</div>
            </div>
          </div>
          <div class="history-item-meta">
            <span class="history-time">${record.audio_status === "unavailable" ? "音频不可用" : formatRelativeTime(record.last_played_at)}</span>
            ${record.audio_status === "unavailable" ? '<button type="button" class="history-regenerate-btn" title="使用当前模型重新合成；Gemini 需要 API Key 并消耗配额">重新生成</button>' : ""}
            <button class="history-delete-btn" title="删除" aria-label="删除" data-id="${escapeHtml(record.id)}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>
        </li>
      `
        )
        .join("");
    }
  } catch (err) {
    console.error("Failed to load history:", err);
  }
}

export function updateHistoryPlayingState(activeCacheKey, isPlaying) {
  if (!historyList) return;

  const items = historyList.querySelectorAll(".history-item");
  items.forEach((item) => {
    const key = item.dataset.cacheKey;
    const playBtn = item.querySelector(".history-play-btn");
    const isActive = key === activeCacheKey;

    if (isActive) {
      item.classList.add("is-active");
      if (isPlaying) {
        item.classList.add("is-playing");
        if (playBtn) {
          playBtn.innerHTML = `
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16"></rect>
              <rect x="14" y="4" width="4" height="16"></rect>
            </svg>`;
          playBtn.setAttribute("title", "暂停");
          playBtn.setAttribute("aria-label", "暂停");
        }
      } else {
        item.classList.remove("is-playing");
        if (playBtn) {
          playBtn.innerHTML = `
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6 4 20 12 6 20 6 4"></polygon>
            </svg>`;
          playBtn.setAttribute("title", "播放");
          playBtn.setAttribute("aria-label", "播放");
        }
      }
    } else {
      item.classList.remove("is-active", "is-playing");
      if (playBtn) {
        playBtn.innerHTML = `
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="6 4 20 12 6 20 6 4"></polygon>
          </svg>`;
        playBtn.setAttribute("title", "播放");
        playBtn.setAttribute("aria-label", "播放");
      }
    }
  });
}

export async function deleteFromHistory(historyId, itemEl = null) {
  if (!historyId) return;

  if (itemEl) {
    itemEl.classList.add("is-deleting");
    const remainingItems = historyList
      ? historyList.querySelectorAll(".history-item:not(.is-deleting)").length
      : 0;
    const countStr = String(remainingItems);
    if (historyBadge) historyBadge.textContent = countStr;
    if (headerHistoryBadge) headerHistoryBadge.textContent = countStr;
    if (navHistoryBadge) navHistoryBadge.textContent = countStr;
    if (remainingItems === 0 && clearHistoryBtn) {
      clearHistoryBtn.style.display = "none";
    }

    setTimeout(() => {
      if (itemEl && itemEl.parentNode) {
        itemEl.remove();
      }
      if (remainingItems === 0 && historyEmpty && historyList) {
        historyList.style.display = "none";
        historyEmpty.style.display = "block";
      }
    }, 240);
  }

  try {
    const response = await apiFetch(`/api/history/${historyId}`, {
      method: "DELETE",
      headers: { "X-Client-ID": getClientId() },
    });
    if (!response.ok && response.status !== 204) {
      throw new Error("Failed to delete record");
    }
  } catch (err) {
    console.error("Delete history error:", err);
    callbacks.onError("删除历史记录失败。");
    await loadHistory();
  }
}

export async function clearAllHistory() {
  if (!window.confirm("确定要清空全部播放历史吗？")) {
    return;
  }

  const items = historyList ? historyList.querySelectorAll(".history-item") : [];
  items.forEach((item) => item.classList.add("is-deleting"));

  try {
    const response = await apiFetch("/api/history", {
      method: "DELETE",
      headers: { "X-Client-ID": getClientId() },
    });
    if (response.ok || response.status === 204) {
      setTimeout(async () => {
        await loadHistory();
      }, 220);
    } else {
      throw new Error("清空历史请求失败。");
    }
  } catch (err) {
    console.error("Clear all history error:", err);
    callbacks.onError("清空全部历史失败。");
    await loadHistory();
  }
}

export function initHistory(userCallbacks = {}) {
  callbacks = { ...callbacks, ...userCallbacks };

  historySection = document.getElementById("historySection");
  historyList = document.getElementById("historyList");
  historyEmpty = document.getElementById("historyEmpty");
  historyBadge = document.getElementById("historyBadge");
  headerHistoryBadge = document.getElementById("headerHistoryBadge");
  navHistoryBadge = document.getElementById("navHistoryBadge");
  clearHistoryBtn = document.getElementById("clearHistoryBtn");
  historyBtn = document.getElementById("historyBtn");
  sidebarCloseBtn = document.getElementById("sidebarCloseBtn");
  sidebarBackdrop = document.getElementById("sidebarBackdrop");
  sidebarHistoryNavBtn = document.getElementById("sidebarHistoryNavBtn");
  sidebarFavNavBtn = document.getElementById("sidebarFavNavBtn");
  sidebarFilesNavBtn = document.getElementById("sidebarFilesNavBtn");

  if (historyBtn) {
    historyBtn.addEventListener("click", () => {
      if (historySection?.classList.contains("open")) closeSidebar();
      else openSidebar();
    });
  }

  if (sidebarCloseBtn) {
    sidebarCloseBtn.addEventListener("click", closeSidebar);
  }

  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener("click", closeSidebar);
  }

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener("click", clearAllHistory);
  }

  if (sidebarFavNavBtn) {
    sidebarFavNavBtn.addEventListener("click", () => {
      showSidebarToast("收藏功能即将上线，敬请期待 ✨");
    });
  }

  if (sidebarFilesNavBtn) {
    sidebarFilesNavBtn.addEventListener("click", () => {
      showSidebarToast("文件管理功能即将上线，敬请期待 ✨");
    });
  }

  if (sidebarHistoryNavBtn) {
    sidebarHistoryNavBtn.addEventListener("click", () => {
      if (historySection) {
        const scrollable = historySection.querySelector(".sidebar-scrollable");
        if (scrollable) scrollable.scrollTop = 0;
      }
    });
  }

  if (historyList) {
    historyList.addEventListener("click", (e) => {
      const regenerateBtn = e.target.closest(".history-regenerate-btn");
      if (regenerateBtn) {
        e.stopPropagation();
        const item = regenerateBtn.closest(".history-item");
        const text = cacheKeyToText.get(item.dataset.cacheKey);
        if (!text) return;
        callbacks.onRegenerate({
          text,
          engine: item.dataset.engine,
          voice: item.dataset.voice,
        });
        return;
      }

      const replayBtn = e.target.closest(".history-replay-btn");
      if (replayBtn) {
        e.stopPropagation();
        callbacks.onReplay(replayBtn.dataset.cacheKey, replayBtn);
        return;
      }

      const deleteBtn = e.target.closest(".history-delete-btn");
      if (deleteBtn) {
        e.stopPropagation();
        const historyItem = deleteBtn.closest(".history-item");
        deleteFromHistory(parseInt(deleteBtn.dataset.id, 10), historyItem);
        return;
      }

      const historyItem = e.target.closest(".history-item");
      if (historyItem) {
        const textEl = historyItem.querySelector(".history-text");
        if (textEl) {
          callbacks.onSelectText(textEl.getAttribute("title"));
        }
      }
    });
  }

  historyDockMedia.addEventListener("change", () => {
    syncSidebarLayout();
    if (document.body.classList.contains("drawer-open")) historyBtn?.focus();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || !document.body.classList.contains("drawer-open")) return;
    const controls = [historyBtn, ...historySection.querySelectorAll(
      'button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]'
    )].filter((element) => element && element.getClientRects().length);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });

  const storedExpanded = localStorage.getItem("tts_history_expanded");
  if (historyDockMedia.matches && storedExpanded === "1") {
    historySection?.classList.add("open");
  }
  syncSidebarLayout();
}
