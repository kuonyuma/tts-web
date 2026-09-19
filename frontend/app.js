/**
 * Japanese TTS Frontend Logic
 * Supports Multi-Engine (Edge TTS Free & Gemini TTS BYOK)
 */

document.addEventListener("DOMContentLoaded", () => {
  const textInput = document.getElementById("textInput");
  const charCounter = document.getElementById("charCounter");
  const generateBtn = document.getElementById("generateBtn");
  const btnText = document.getElementById("btnText");
  const errorAlert = document.getElementById("errorAlert");
  const errorMessage = document.getElementById("errorMessage");
  const errorCloseBtn = document.getElementById("errorCloseBtn");
  const workspace = document.querySelector(".workspace");
  const workspaceSplitter = document.getElementById("workspaceSplitter");
  const syncStatus = document.getElementById("syncStatus");
  const samplePrompts = document.querySelectorAll(".sample-chip");

  // Engine & Voice Selectors
  const engineSelect = document.getElementById("engineSelect");
  const voiceSelect = document.getElementById("voiceSelect");
  const engineBadge = document.getElementById("engineBadge");
  const settingsBtn = document.getElementById("settingsBtn");
  const keyStatusBadge = document.getElementById("keyStatusBadge");

  // Settings Modal Elements
  const settingsModal = document.getElementById("settingsModal");
  const modalCloseBtn = document.getElementById("modalCloseBtn");
  const geminiApiKeyInput = document.getElementById("geminiApiKeyInput");
  const toggleKeyVisibilityBtn = document.getElementById("toggleKeyVisibilityBtn");
  const testKeyBtn = document.getElementById("testKeyBtn");
  const clearKeyBtn = document.getElementById("clearKeyBtn");
  const saveKeyBtn = document.getElementById("saveKeyBtn");
  const keyTestResult = document.getElementById("keyTestResult");

  // Audio Player Elements
  const playerContainer = document.getElementById("playerContainer");
  const audioPlayer = document.getElementById("audioPlayer");
  const playPauseBtn = document.getElementById("playPauseBtn");
  const iconPlay = playPauseBtn ? playPauseBtn.querySelector(".icon-play") : null;
  const iconPause = playPauseBtn ? playPauseBtn.querySelector(".icon-pause") : null;
  const currentTimeEl = document.getElementById("currentTime");
  const totalDurationEl = document.getElementById("totalDuration");
  const waveformContainer = document.getElementById("waveformContainer");
  const waveformBars = document.getElementById("waveformBars");
  const waveformHoverLine = document.getElementById("waveformHoverLine");
  const waveformTooltip = document.getElementById("waveformTooltip");
  const speedBtn = document.getElementById("speedBtn");
  const downloadBtn = document.getElementById("downloadBtn");

  // Sentence Flow Elements & State
  const sentenceFlow = document.getElementById("sentenceFlow");
  const sentenceList = document.getElementById("sentenceList");
  let activeTimeline = [];
  let activeSentenceIndex = -1;
  let sentenceSyncFrame = null;
  let ttsRequestId = 0;
  let previewDebounceTimer = null;

  // Cache key -> original text (used to resolve replay text for explanations)
  const cacheKeyToText = new Map();

  // AI Explanation (Agent) Elements & State
  const explainToggle = document.getElementById("explainToggle");
  const explainLangSelect = document.getElementById("explainLangSelect");
  const explainModelSelect = document.getElementById("explainModelSelect");
  const explainThinkingSelect = document.getElementById("explainThinkingSelect");
  const explainSection = document.getElementById("explainSection");
  const explainMessages = document.getElementById("explainMessages");
  const explainLangBadge = document.getElementById("explainLangBadge");
  const explainRetryBtn = document.getElementById("explainRetryBtn");
  const explainChatInput = document.getElementById("explainChatInput");
  const explainSendBtn = document.getElementById("explainSendBtn");

  const EXPLAIN_LANG_NAMES = { zh: "中文", ja: "日语", en: "英语" };
  let availableCopilotModels = [];
  // Toggle defaults to ON; only an explicit "0" disables it.
  let explainEnabled = localStorage.getItem("tts_explain_enabled") !== "0";
  let explainLang = localStorage.getItem("tts_explain_lang") || "zh";
  if (!EXPLAIN_LANG_NAMES[explainLang]) explainLang = "zh";
  let explainModel = localStorage.getItem("tts_explain_model") || "";
  let explainThinking = localStorage.getItem("tts_explain_mode") || "";
  let currentExplainKey = null;
  let currentExplainText = null;
  let currentExplainLang = null;
  let currentExplainModel = null;
  let currentExplainThinking = null;
  let explainLoading = false;
  let chatPending = false;
  let ttsPending = false;
  let playbackFusionPulse = false;
  let fusionStartedAt = 0;
  let fusionReleaseTimer = null;
  let playbackFusionTimer = null;
  let explainRevealFrame = null;
  let activeExplainReveal = null;

  // History & Sidebar Elements
  const historySection = document.getElementById("historySection");
  const historyList = document.getElementById("historyList");
  const historyEmpty = document.getElementById("historyEmpty");
  const historyBadge = document.getElementById("historyBadge");
  const headerHistoryBadge = document.getElementById("headerHistoryBadge");
  const clearHistoryBtn = document.getElementById("clearHistoryBtn");
  const historyBtn = document.getElementById("historyBtn");
  const sidebarCloseBtn = document.getElementById("sidebarCloseBtn");
  const sidebarBackdrop = document.getElementById("sidebarBackdrop");

  let MAX_CHAR_COUNT = 1000;
  let MIN_CHAR_COUNT = 1;
  let requestTimeoutMs = 45000;
  const PLAYBACK_SPEEDS = [0.75, 1.0, 1.25];
  const FUSION_APPROACH_MS = 2200;
  const FUSION_HOLD_MS = 600;
  let currentSpeedIndex = 1;
  let currentAudioUrl = null;
  let currentAudioBlob = null;
  let activeCacheKey = null;
  let isSeeking = false;
  let workspaceState = "idle";
  let draftText = "";
  let activeAudioText = "";
  let activeAudioEngine = null;
  let activeAudioVoice = null;

  const WORKSPACE_SPLIT_STORAGE_KEY = "tts_workspace_split_ratio";
  const DEFAULT_WORKSPACE_SPLIT = 0.565;
  const MIN_WORKSPACE_SPLIT = 0.3;
  const MAX_WORKSPACE_SPLIT = 0.75;
  const MIN_LEFT_PANE_WIDTH = 360;
  const MIN_RIGHT_PANE_WIDTH = 340;
  const workspaceSplitMedia = window.matchMedia("(min-width: 961px)");
  let workspaceSplitRatio = DEFAULT_WORKSPACE_SPLIT;
  let activeSplitterPointerId = null;

  let availableEngines = [];

  const ENGINE_LABELS = {
    edge: "Edge TTS（免费·快速）",
    gemini: "Gemini TTS（高品质·需 Key）",
  };

  const VOICE_LABELS = {
    "ja-JP-NanamiNeural": "七海 · 日语女声",
    "ja-JP-KeitaNeural": "圭太 · 日语男声",
    "zh-CN-XiaoxiaoNeural": "晓晓 · 中文女声",
    "zh-CN-YunxiNeural": "云希 · 中文男声",
    "en-US-AvaNeural": "Ava · 英语女声",
    "en-US-AndrewNeural": "Andrew · 英语男声",
    Kore: "Kore · 女声 · 标准",
    Aoede: "Aoede · 女声 · 柔和",
    Leda: "Leda · 女声 · 年轻",
    Zephyr: "Zephyr · 女声 · 明亮",
    Puck: "Puck · 男声 · 活泼",
    Charon: "Charon · 男声 · 低沉",
    Fenrir: "Fenrir · 男声 · 有力",
    Orus: "Orus · 男声 · 厚重",
  };

  function getEngineById(engineId = engineSelect?.value) {
    return availableEngines.find((engine) => engine.id === engineId) || null;
  }

  function getEngineLabel(engineId, fallback = "语音引擎") {
    return ENGINE_LABELS[engineId] || fallback;
  }

  function getVoiceLabel(voiceId, fallback = "默认声音") {
    return VOICE_LABELS[voiceId] || fallback;
  }

  function updateEngineMeta() {
    const engine = getEngineById();
    if (engineBadge) {
      engineBadge.textContent = engine?.is_free ? "免费" : "高品质";
      engineBadge.classList.toggle("is-paid", !engine?.is_free);
    }
  }

  function isAudioConfigDirty() {
    return Boolean(
      activeAudioText &&
      (activeAudioEngine !== (engineSelect?.value || "edge") ||
        activeAudioVoice !== (voiceSelect?.value || null))
    );
  }

  function isDraftDirty() {
    return Boolean(activeAudioText && (draftText !== activeAudioText || isAudioConfigDirty()));
  }

  function hasActiveFusionWork() {
    return ttsPending || explainLoading || chatPending || playbackFusionPulse;
  }

  function startFusion() {
    if (fusionReleaseTimer) {
      clearTimeout(fusionReleaseTimer);
      fusionReleaseTimer = null;
    }
    if (!document.body.classList.contains("is-fusing")) {
      fusionStartedAt = performance.now();
      document.body.classList.add("is-fusing");
    }
    if (workspace) workspace.dataset.fusion = "active";
  }

  function scheduleFusionRelease() {
    if (!document.body.classList.contains("is-fusing")) {
      if (workspace) workspace.dataset.fusion = "idle";
      return;
    }
    if (fusionReleaseTimer) return;
    const delay = Math.max(
      0,
      fusionStartedAt + FUSION_APPROACH_MS + FUSION_HOLD_MS - performance.now()
    );
    fusionReleaseTimer = setTimeout(() => {
      fusionReleaseTimer = null;
      if (hasActiveFusionWork()) {
        startFusion();
        return;
      }
      document.body.classList.remove("is-fusing");
      if (workspace) workspace.dataset.fusion = "idle";
    }, delay);
  }

  function refreshFusionState() {
    if (hasActiveFusionWork()) startFusion();
    else scheduleFusionRelease();
  }

  function triggerFusionPulse() {
    if (playbackFusionTimer) clearTimeout(playbackFusionTimer);
    playbackFusionPulse = true;
    refreshFusionState();
    playbackFusionTimer = setTimeout(() => {
      playbackFusionPulse = false;
      playbackFusionTimer = null;
      refreshFusionState();
    }, 160);
  }

  function setWorkspaceState(state) {
    workspaceState = state;
    if (workspace) {
      workspace.dataset.state = state;
    }
    const editorStatus = {
      idle: "等待一句话",
      draft: "待生成",
      generating: "正在生成",
      linked: "已同步",
      playing: "正在播放",
      dirty: "需要重新生成",
      error: "生成失败",
    }[state] || "等待一句话";
    if (syncStatus) {
      syncStatus.className = `sync-status ${state === "idle" ? "is-idle" : `is-${state}`}`;
      syncStatus.innerHTML = `<span class="sync-status-dot" aria-hidden="true"></span>${editorStatus}`;
    }
  }

  function refreshWorkspaceState() {
    if (workspaceState === "generating") return;
    if (isDraftDirty()) {
      setWorkspaceState("dirty");
      return;
    }
    if (audioPlayer?.src && !audioPlayer.paused && !audioPlayer.ended) {
      setWorkspaceState("playing");
      return;
    }
    if (activeAudioText) {
      setWorkspaceState("linked");
      return;
    }
    setWorkspaceState(draftText ? "draft" : "idle");
  }

  function syncDraftState() {
    draftText = textInput.value.trim();
    if (activeAudioText && draftText !== activeAudioText) {
      currentExplainText = null;
      currentExplainKey = null;
    }
    refreshWorkspaceState();
  }

  function clampWorkspaceSplit(ratio, min = MIN_WORKSPACE_SPLIT, max = MAX_WORKSPACE_SPLIT) {
    return Math.min(max, Math.max(min, ratio));
  }

  function applyWorkspaceSplit(ratio, persist = false) {
    if (!workspace || !workspaceSplitter) return;
    workspaceSplitRatio = clampWorkspaceSplit(ratio);
    workspace.style.setProperty("--workspace-left-track", `${workspaceSplitRatio}fr`);
    workspace.style.setProperty("--workspace-right-track", `${1 - workspaceSplitRatio}fr`);
    const percentage = Math.round(workspaceSplitRatio * 100);
    workspaceSplitter.setAttribute("aria-valuenow", String(percentage));
    workspaceSplitter.setAttribute("aria-valuetext", `左侧 ${percentage}%，右侧 ${100 - percentage}%`);
    if (persist) {
      localStorage.setItem(WORKSPACE_SPLIT_STORAGE_KEY, workspaceSplitRatio.toFixed(3));
    }
  }

  function getWorkspaceSplitGeometry() {
    if (!workspace || !workspaceSplitter) return null;
    const workspaceRect = workspace.getBoundingClientRect();
    const splitterRect = workspaceSplitter.getBoundingClientRect();
    const styles = getComputedStyle(workspace);
    const numberValue = (value) => Number.parseFloat(value) || 0;
    const borderLeft = numberValue(styles.borderLeftWidth);
    const borderRight = numberValue(styles.borderRightWidth);
    const paddingLeft = numberValue(styles.paddingLeft);
    const paddingRight = numberValue(styles.paddingRight);
    const gap = numberValue(styles.columnGap);
    const contentLeft = workspaceRect.left + borderLeft + paddingLeft;
    const contentWidth =
      workspaceRect.width - borderLeft - borderRight - paddingLeft - paddingRight;
    const paneWidth = contentWidth - splitterRect.width - gap * 2;
    if (paneWidth <= 0) return null;

    let minimumRatio = Math.max(MIN_WORKSPACE_SPLIT, MIN_LEFT_PANE_WIDTH / paneWidth);
    let maximumRatio = Math.min(MAX_WORKSPACE_SPLIT, 1 - MIN_RIGHT_PANE_WIDTH / paneWidth);
    if (minimumRatio > maximumRatio) {
      const midpoint = clampWorkspaceSplit((minimumRatio + maximumRatio) / 2);
      minimumRatio = midpoint;
      maximumRatio = midpoint;
    }
    return {
      contentLeft,
      gap,
      splitterWidth: splitterRect.width,
      paneWidth,
      minimumRatio,
      maximumRatio,
    };
  }

  function resizeWorkspaceFromPointer(clientX) {
    const geometry = getWorkspaceSplitGeometry();
    if (!geometry) return;
    const leftPaneWidth =
      clientX - geometry.contentLeft - geometry.gap - geometry.splitterWidth / 2;
    const ratio = clampWorkspaceSplit(
      leftPaneWidth / geometry.paneWidth,
      geometry.minimumRatio,
      geometry.maximumRatio
    );
    applyWorkspaceSplit(ratio);
  }

  function finishWorkspaceResize(event) {
    if (activeSplitterPointerId === null) return;
    if (event?.pointerId !== undefined && event.pointerId !== activeSplitterPointerId) return;
    const pointerId = activeSplitterPointerId;
    activeSplitterPointerId = null;
    workspaceSplitter?.classList.remove("is-dragging");
    document.body.classList.remove("workspace-resizing");
    applyWorkspaceSplit(workspaceSplitRatio, true);
    if (workspaceSplitter?.hasPointerCapture(pointerId)) {
      workspaceSplitter.releasePointerCapture(pointerId);
    }
  }

  function initWorkspaceSplitter() {
    if (!workspace || !workspaceSplitter) return;
    const savedRatio = Number.parseFloat(localStorage.getItem(WORKSPACE_SPLIT_STORAGE_KEY));
    applyWorkspaceSplit(Number.isFinite(savedRatio) ? savedRatio : DEFAULT_WORKSPACE_SPLIT);

    workspaceSplitter.addEventListener("pointerdown", (event) => {
      if (!workspaceSplitMedia.matches || event.button !== 0) return;
      event.preventDefault();
      activeSplitterPointerId = event.pointerId;
      workspaceSplitter.setPointerCapture(event.pointerId);
      workspaceSplitter.classList.add("is-dragging");
      document.body.classList.add("workspace-resizing");
      resizeWorkspaceFromPointer(event.clientX);
    });

    workspaceSplitter.addEventListener("pointermove", (event) => {
      if (event.pointerId !== activeSplitterPointerId) return;
      resizeWorkspaceFromPointer(event.clientX);
    });
    workspaceSplitter.addEventListener("pointerup", finishWorkspaceResize);
    workspaceSplitter.addEventListener("pointercancel", finishWorkspaceResize);
    workspaceSplitter.addEventListener("lostpointercapture", finishWorkspaceResize);

    workspaceSplitter.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 0.05 : 0.02;
      let nextRatio = workspaceSplitRatio;
      if (event.key === "ArrowLeft") nextRatio -= step;
      else if (event.key === "ArrowRight") nextRatio += step;
      else if (event.key === "Home") nextRatio = MIN_WORKSPACE_SPLIT;
      else if (event.key === "End") nextRatio = MAX_WORKSPACE_SPLIT;
      else return;
      event.preventDefault();
      applyWorkspaceSplit(nextRatio, true);
    });

    workspaceSplitter.addEventListener("dblclick", () => {
      applyWorkspaceSplit(DEFAULT_WORKSPACE_SPLIT, true);
    });

    workspaceSplitMedia.addEventListener("change", () => {
      if (!workspaceSplitMedia.matches) finishWorkspaceResize();
    });
  }

  function localizeErrorMessage(detail, fallback) {
    const raw = typeof detail === "string" ? detail.trim() : "";
    if (!raw) return fallback;
    const lower = raw.toLowerCase();
    if (raw.includes("API Key") || raw.includes("API key")) {
      return "当前功能需要 Gemini API Key，请打开右上角设置进行配置。";
    }
    if (raw.includes("Edge TTS synthesis error") || lower.includes("no audio was received")) {
      return "Edge TTS 没有返回音频，请检查文本和声音设置后重试。";
    }
    if (lower.includes("timeout") || raw.includes("超时")) {
      return "请求超时，请缩短文本后重试。";
    }
    if (raw.includes("cache") && lower.includes("not found")) {
      return "找不到缓存的音频，请重新生成。";
    }
    return raw;
  }

  async function apiFetch(url, options = {}) {
    const target = new URL(url, window.location.href);
    if (target.origin !== window.location.origin) throw new Error("响应地址无效。");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let reader;
    try {
      const response = await fetch(target.href, { ...options, signal: controller.signal });
      // Keep the deadline active while receiving the body, including audio.
      const chunks = [];
      let size = 0;
      if (response.body) {
        reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 32 * 1024 * 1024) {
            controller.abort();
            throw new Error("服务器响应超过大小限制。");
          }
          chunks.push(value);
        }
      }
      return new Response([204, 205, 304].includes(response.status) ? null : new Blob(chunks), {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    } catch (error) {
      if (error.name === "AbortError") throw new Error("请求超时，请稍后重试。");
      throw error;
    } finally {
      clearTimeout(timer);
      reader?.releaseLock();
    }
  }

  // ── Engine & Voice Management ──────────────────────────────────

  async function loadEngines() {
    try {
      const res = await apiFetch("/api/engines");
      if (!res.ok) throw new Error("Failed to load engines list");
      availableEngines = await res.json();
      const limits = availableEngines[0];
      if (Number.isInteger(limits?.max_text_length)) MAX_CHAR_COUNT = limits.max_text_length;
      if (Number.isInteger(limits?.min_text_length)) MIN_CHAR_COUNT = limits.min_text_length;
      if (Number.isFinite(limits?.request_timeout_seconds)) requestTimeoutMs = (limits.request_timeout_seconds + 15) * 1000;
      // HTML maxlength counts UTF-16 units; validation below counts Unicode characters.
      textInput.maxLength = MAX_CHAR_COUNT * 2;
      updateCharCount();
      renderEngineSelect();
    } catch (err) {
      console.warn("Using fallback engine config:", err);
      availableEngines = [
        {
          id: "edge",
          name: "Edge TTS（免费·快速）",
          is_free: true,
          default_voice: "ja-JP-NanamiNeural",
          voices: [
            { id: "ja-JP-NanamiNeural", name: "七海 · 日语女声" },
            { id: "ja-JP-KeitaNeural", name: "圭太 · 日语男声" }
          ]
        },
        {
          id: "gemini",
          name: "Gemini TTS（高品质·需 Key）",
          is_free: false,
          default_voice: "Kore",
          voices: [
            { id: "Kore", name: "Kore · 女声 · 标准" },
            { id: "Aoede", name: "Aoede · 女声 · 柔和" },
            { id: "Leda", name: "Leda · 女声 · 年轻" },
            { id: "Zephyr", name: "Zephyr · 女声 · 明亮" },
            { id: "Puck", name: "Puck · 男声 · 活泼" },
            { id: "Charon", name: "Charon · 男声 · 低沉" },
            { id: "Fenrir", name: "Fenrir · 男声 · 有力" },
            { id: "Orus", name: "Orus · 男声 · 厚重" }
          ]
        }
      ];
      renderEngineSelect();
    }
  }

  function renderEngineSelect() {
    if (!engineSelect) return;
    const savedEngine = localStorage.getItem("tts_selected_engine") || "edge";

    engineSelect.innerHTML = availableEngines
      .map((eng) => `<option value="${escapeHtml(eng.id)}">${escapeHtml(getEngineLabel(eng.id, eng.name))}</option>`)
      .join("");

    if (availableEngines.some((e) => e.id === savedEngine)) {
      engineSelect.value = savedEngine;
    } else {
      engineSelect.value = availableEngines[0]?.id || "edge";
    }

    renderVoicesForCurrentEngine();
    updateEngineMeta();
  }

  function renderVoicesForCurrentEngine() {
    if (!voiceSelect) return;
    const currentEngineId = engineSelect.value;
    const engineObj = availableEngines.find((e) => e.id === currentEngineId);

    if (!engineObj || !engineObj.voices || engineObj.voices.length === 0) {
      voiceSelect.innerHTML = "";
      return;
    }

    const savedVoice = localStorage.getItem(`tts_selected_voice_${currentEngineId}`);

    voiceSelect.innerHTML = engineObj.voices
      .map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(getVoiceLabel(v.id, v.name))}</option>`)
      .join("");

    if (savedVoice && engineObj.voices.some((v) => v.id === savedVoice)) {
      voiceSelect.value = savedVoice;
    } else {
      voiceSelect.value = engineObj.default_voice || engineObj.voices[0].id;
    }
    updateEngineMeta();
  }

  if (engineSelect) {
    engineSelect.addEventListener("change", () => {
      localStorage.setItem("tts_selected_engine", engineSelect.value);
      renderVoicesForCurrentEngine();
      refreshWorkspaceState();
    });
  }

  if (voiceSelect) {
    voiceSelect.addEventListener("change", () => {
      const currentEngineId = engineSelect.value;
      localStorage.setItem(`tts_selected_voice_${currentEngineId}`, voiceSelect.value);
      updateEngineMeta();
      refreshWorkspaceState();
    });
  }

  // ── Theme Management (Default / Sakura / Dark) ──────────────────
  const THEME_STORAGE_KEY = "tts_theme";
  const DEFAULT_THEME = "sakura";
  const themeOptionsGrid = document.getElementById("themeOptionsGrid");
  const sakuraDecor = document.getElementById("sakuraDecor");

  function applyTheme(themeId) {
    const validTheme = ["default", "sakura", "dark"].includes(themeId) ? themeId : DEFAULT_THEME;
    document.documentElement.setAttribute("data-theme", validTheme);
    document.body.setAttribute("data-theme", validTheme);
    localStorage.setItem(THEME_STORAGE_KEY, validTheme);

    if (sakuraDecor) {
      sakuraDecor.style.display = validTheme === "sakura" ? "block" : "none";
    }

    if (themeOptionsGrid) {
      const btns = themeOptionsGrid.querySelectorAll(".theme-option-btn");
      btns.forEach((btn) => {
        const isActive = btn.getAttribute("data-theme") === validTheme;
        btn.classList.toggle("active", isActive);
        btn.setAttribute("aria-checked", String(isActive));
      });
    }
  }

  function initThemeSelector() {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME;
    applyTheme(savedTheme);

    if (themeOptionsGrid) {
      themeOptionsGrid.addEventListener("click", (e) => {
        const btn = e.target.closest(".theme-option-btn");
        if (!btn) return;
        const targetTheme = btn.getAttribute("data-theme");
        if (targetTheme) {
          applyTheme(targetTheme);
        }
      });
    }
  }

  // ── Sidebar Navigation ──────────────────────────────────────────
  const clearTextBtn = document.getElementById("clearTextBtn");
  const sidebarHistoryNavBtn = document.getElementById("sidebarHistoryNavBtn");
  const sidebarFavNavBtn = document.getElementById("sidebarFavNavBtn");
  const sidebarFilesNavBtn = document.getElementById("sidebarFilesNavBtn");

  function clearDraft() {
    textInput.value = "";
    updateCharCount();
    draftText = "";
    setWorkspaceState("idle");
    updateSentencePreview();
    if (errorAlert) errorAlert.style.display = "none";
    textInput.focus();
  }

  if (clearTextBtn) {
    clearTextBtn.addEventListener("click", clearDraft);
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

  // ── BYOK API Key Settings Modal ───────────────────────────────

  function updateKeyBadge() {
    const key = localStorage.getItem("tts_gemini_api_key");
    if (keyStatusBadge) {
      keyStatusBadge.style.display = key && key.trim() ? "inline-block" : "none";
    }
  }

  function openSettingsModal() {
    if (!settingsModal) return;
    const storedKey = localStorage.getItem("tts_gemini_api_key") || "";
    geminiApiKeyInput.value = storedKey;
    geminiApiKeyInput.type = "password";
    const currentTheme = localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME;
    applyTheme(currentTheme);
    hideKeyTestResult();
    settingsModal.style.display = "flex";
    geminiApiKeyInput.focus();
  }

  function closeSettingsModal() {
    if (!settingsModal) return;
    settingsModal.style.display = "none";
  }

  function showKeyTestResult(type, text) {
    if (!keyTestResult) return;
    keyTestResult.className = `key-test-result ${type}`;
    keyTestResult.textContent = text;
    keyTestResult.style.display = "block";
  }

  function hideKeyTestResult() {
    if (!keyTestResult) return;
    keyTestResult.style.display = "none";
    keyTestResult.textContent = "";
  }

  if (settingsBtn) {
    settingsBtn.addEventListener("click", openSettingsModal);
  }

  if (modalCloseBtn) {
    modalCloseBtn.addEventListener("click", closeSettingsModal);
  }

  if (settingsModal) {
    settingsModal.addEventListener("click", (e) => {
      if (e.target === settingsModal) {
        closeSettingsModal();
      }
    });
  }

  if (toggleKeyVisibilityBtn) {
    toggleKeyVisibilityBtn.addEventListener("click", () => {
      if (geminiApiKeyInput.type === "password") {
        geminiApiKeyInput.type = "text";
      } else {
        geminiApiKeyInput.type = "password";
      }
    });
  }

  if (testKeyBtn) {
    testKeyBtn.addEventListener("click", async () => {
      const key = geminiApiKeyInput.value.trim();
      if (!key) {
        showKeyTestResult("error", "请输入要测试的 API Key。");
        return;
      }

      showKeyTestResult("loading", "正在测试连接…");
      testKeyBtn.disabled = true;

      try {
        const res = await apiFetch("/api/tts/test-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: key }),
        });
        const data = await res.json();
        if (data.valid) {
          showKeyTestResult("success", data.message || "连接成功，Key 可以正常使用。");
        } else {
          showKeyTestResult("error", data.message || localizeErrorMessage(data.detail, "连接测试失败。"));
        }
      } catch (err) {
        showKeyTestResult("error", err.message || "与服务器通信失败。");
      } finally {
        testKeyBtn.disabled = false;
      }
    });
  }

  if (saveKeyBtn) {
    saveKeyBtn.addEventListener("click", () => {
      const key = geminiApiKeyInput.value.trim();
      if (key) {
        localStorage.setItem("tts_gemini_api_key", key);
      } else {
        localStorage.removeItem("tts_gemini_api_key");
      }
      updateKeyBadge();
      closeSettingsModal();
    });
  }

  if (clearKeyBtn) {
    clearKeyBtn.addEventListener("click", () => {
      geminiApiKeyInput.value = "";
      localStorage.removeItem("tts_gemini_api_key");
      updateKeyBadge();
      showKeyTestResult("loading", "API Key 已删除。");
      setTimeout(hideKeyTestResult, 1500);
    });
  }

  // ── Character counter ──────────────────────────────────────────

  function updateCharCount() {
    const length = Array.from(textInput.value).length;
    charCounter.textContent = `${length} / ${MAX_CHAR_COUNT} 字`;

    if (length > MAX_CHAR_COUNT) {
      charCounter.className = "char-counter limit-exceeded";
    } else if (length >= MAX_CHAR_COUNT * 0.9) {
      charCounter.className = "char-counter limit-warning";
    } else {
      charCounter.className = "char-counter";
    }
  }

  // ── Error display ──────────────────────────────────────────────

  function showError(msg) {
    errorMessage.textContent = msg;
    errorAlert.style.display = "flex";
  }

  function hideError() {
    errorAlert.style.display = "none";
    errorMessage.textContent = "";
  }

  if (errorCloseBtn) {
    errorCloseBtn.addEventListener("click", hideError);
  }

  // ── Loading state ──────────────────────────────────────────────

  function setLoading(isLoading) {
    if (isLoading) {
      generateBtn.disabled = true;
      generateBtn.classList.add("loading");
      btnText.textContent = "正在生成音频…";
    } else {
      generateBtn.disabled = false;
      generateBtn.classList.remove("loading");
      btnText.textContent = "生成语音";
    }
  }

  // ── Custom Audio Player & Ambient Waveform ─────────────────────

  const NUM_WAVEFORM_BARS = 48;
  let audioContext = null;

  function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0 || !isFinite(seconds)) {
      return "00:00";
    }
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

  function formatTimeWithSubseconds(seconds) {
    if (isNaN(seconds) || seconds < 0 || !isFinite(seconds)) {
      return "00:00.0";
    }
    const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
    const secs = (seconds % 60).toFixed(1).padStart(4, "0");
    return `${mins}:${secs}`;
  }

  function generateDefaultPeaks(numBars = NUM_WAVEFORM_BARS) {
    const peaks = [];
    for (let i = 0; i < numBars; i++) {
      const t = i / numBars;
      const base = Math.sin(t * Math.PI);
      const harmonic = 0.28 * Math.sin(t * Math.PI * 4.5) + 0.16 * Math.cos(t * Math.PI * 8.2);
      const val = Math.max(0.18, Math.min(0.95, base * 0.72 + harmonic + 0.16));
      peaks.push(Math.round(val * 100));
    }
    return peaks;
  }

  function renderWaveformBars(peaks) {
    if (!waveformBars) return;
    waveformBars.innerHTML = peaks
      .map(
        (h, i) =>
          `<div class="waveform-bar" style="height: ${h}%;" data-index="${i}"></div>`
      )
      .join("");
  }

  async function extractWaveformPeaks(blob, numBars = NUM_WAVEFORM_BARS) {
    try {
      if (!window.AudioContext && !window.webkitAudioContext) return null;
      if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioContext.state === "suspended") {
        await audioContext.resume().catch(() => {});
      }
      const buffer = await blob.arrayBuffer();
      const decoded = await audioContext.decodeAudioData(buffer.slice(0));
      const raw = decoded.getChannelData(0);
      const blockSize = Math.floor(raw.length / numBars);
      if (blockSize <= 0) return null;
      const peaks = [];
      for (let i = 0; i < numBars; i++) {
        const start = i * blockSize;
        let sum = 0;
        let sampleCount = 0;
        // A small stride keeps the visual waveform while avoiding a long
        // main-thread loop for longer audio files.
        const stride = Math.max(1, Math.floor(blockSize / 160));
        for (let j = 0; j < blockSize; j += stride) {
          sum += Math.abs(raw[start + j] || 0);
          sampleCount += 1;
        }
        peaks.push(sum / Math.max(1, sampleCount));
      }
      const max = Math.max(...peaks) || 1;
      return peaks.map((p) => Math.max(14, Math.round((p / max) * 92 + 8)));
    } catch {
      return null;
    }
  }

  function updateWaveformProgress() {
    if (!waveformBars) return;
    const duration = audioPlayer.duration || 0;
    const currentTime = audioPlayer.currentTime || 0;
    const progress = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0;
    const bars = waveformBars.children;
    const count = bars.length;
    const currentIdx = Math.floor(progress * count);
    for (let i = 0; i < count; i++) {
      if (i < currentIdx) {
        bars[i].className = "waveform-bar is-played";
      } else if (i === currentIdx && !audioPlayer.paused && !audioPlayer.ended) {
        bars[i].className = "waveform-bar is-current";
      } else {
        bars[i].className = "waveform-bar";
      }
    }
    if (waveformContainer) {
      waveformContainer.setAttribute("aria-valuenow", Math.round(progress * 100));
    }
  }

  function applyPlaybackSpeed() {
    const speed = PLAYBACK_SPEEDS[currentSpeedIndex];
    audioPlayer.playbackRate = speed;
    if (speedBtn) {
      speedBtn.textContent = `${speed.toFixed(speed % 1 === 0 ? 1 : 2)}x`;
    }
  }

  // ── Sentence Flow & Synchronized Highlighting ──────────────────

  function segmentText(text) {
    if (!text || !text.trim()) return [];
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      try {
        const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
        return [...segmenter.segment(text)]
          .map((item) => item.segment.trim())
          .filter(Boolean);
      } catch (e) {
        // Fallback below
      }
    }
    const matches = text.match(/[^。！？!?…\n]+[。！？!?…\n]*/g);
    return matches ? matches.map((s) => s.trim()).filter(Boolean) : [text.trim()];
  }

  function updateSentencePreview() {
    if (!sentenceFlow || !sentenceList) return;
    const currentVal = textInput.value.trim();
    if (!currentVal) {
      if (activeTimeline.length === 0) {
        sentenceFlow.hidden = true;
        sentenceList.innerHTML = "";
      }
      return;
    }

    // If active audio is loaded and unchanged, keep server timeline intact
    if (activeAudioText && currentVal === activeAudioText && activeTimeline.length > 0) {
      return;
    }

    const previewSentences = segmentText(currentVal);
    if (!previewSentences.length) {
      sentenceFlow.hidden = true;
      sentenceList.innerHTML = "";
      return;
    }

    sentenceList.innerHTML = previewSentences
      .map(
        (s, idx) => `
        <div class="sentence-row is-preview" data-index="${idx}">
          <span class="sentence-index">${idx + 1}</span>
          <span class="sentence-text">${escapeHtml(s)}</span>
        </div>
      `
      )
      .join("");
    sentenceFlow.hidden = false;
  }

  function renderSentenceRows(sentences) {
    if (!sentenceFlow || !sentenceList) return;
    if (!sentences || !sentences.length) {
      sentenceFlow.hidden = true;
      sentenceList.innerHTML = "";
      return;
    }
    sentenceList.innerHTML = sentences
      .map(
        (s, idx) => `
        <button class="sentence-row" data-index="${idx}" type="button">
          <span class="sentence-index">${idx + 1}</span>
          <span class="sentence-text">${escapeHtml(s.text)}</span>
        </button>
      `
      )
      .join("");
    sentenceFlow.hidden = false;
  }

  function findSentenceIndex(currentTimeMs) {
    if (!activeTimeline || !activeTimeline.length) return -1;
    if (currentTimeMs < activeTimeline[0].start_ms) return -1;

    let low = 0;
    let high = activeTimeline.length - 1;
    let best = -1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (activeTimeline[mid].start_ms <= currentTimeMs) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best;
  }

  function setActiveSentence(nextIndex) {
    if (nextIndex === activeSentenceIndex) return;

    const rows = sentenceList ? sentenceList.querySelectorAll(".sentence-row") : [];
    if (activeSentenceIndex >= 0 && activeSentenceIndex < rows.length) {
      rows[activeSentenceIndex].classList.remove("is-active");
    }

    activeSentenceIndex = nextIndex;

    if (activeSentenceIndex >= 0 && activeSentenceIndex < rows.length) {
      const activeRow = rows[activeSentenceIndex];
      activeRow.classList.add("is-active");
      activeRow.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function startSentenceSync() {
    stopSentenceSync();
    if (!activeTimeline || !activeTimeline.length) return;

    function step() {
      if (!audioPlayer.paused && !audioPlayer.ended) {
        const currentMs = audioPlayer.currentTime * 1000;
        const nextIndex = findSentenceIndex(currentMs);
        setActiveSentence(nextIndex);
        sentenceSyncFrame = requestAnimationFrame(step);
      }
    }
    sentenceSyncFrame = requestAnimationFrame(step);
  }

  function stopSentenceSync() {
    if (sentenceSyncFrame !== null) {
      cancelAnimationFrame(sentenceSyncFrame);
      sentenceSyncFrame = null;
    }
  }

  if (sentenceList) {
    sentenceList.addEventListener("click", (e) => {
      const row = e.target.closest(".sentence-row");
      if (!row || row.classList.contains("is-preview")) return;
      const idx = parseInt(row.dataset.index, 10);
      if (!isNaN(idx) && activeTimeline[idx] && typeof activeTimeline[idx].start_ms === "number") {
        audioPlayer.currentTime = activeTimeline[idx].start_ms / 1000;
        setActiveSentence(idx);
        audioPlayer.play().catch(() => {});
      }
    });
  }

  function playAudioBlob(blob, cacheKey = null, metadata = {}) {
    const resolvedEngine = metadata.engine || engineSelect?.value || "edge";
    const resolvedVoice =
      metadata.voice || voiceSelect?.value || getEngineById(resolvedEngine)?.default_voice || null;
    activeAudioText = metadata.text || activeAudioText || draftText;
    activeAudioEngine = resolvedEngine;
    activeAudioVoice = resolvedVoice;
    stopSentenceSync();
    setActiveSentence(-1);

    if (currentAudioUrl) {
      URL.revokeObjectURL(currentAudioUrl);
      currentAudioUrl = null;
    }
    currentAudioBlob = blob;
    currentAudioUrl = URL.createObjectURL(blob);
    audioPlayer.src = currentAudioUrl;
    applyPlaybackSpeed();

    if (cacheKey) {
      activeCacheKey = cacheKey;
    }

    if (playerContainer) {
      playerContainer.style.display = "block";
    }

    currentTimeEl.textContent = "00:00";
    updateWaveformProgress();

    // Populate waveform with harmonic baseline and decode actual audio peaks
    renderWaveformBars(generateDefaultPeaks());
    extractWaveformPeaks(blob).then((peaks) => {
      if (peaks && peaks.length) {
        renderWaveformBars(peaks);
        updateWaveformProgress();
      }
    });

    audioPlayer.play().catch((err) => {
      console.warn("Autoplay was blocked by browser policy:", err);
    });

    if (workspaceState === "generating") {
      workspaceState = "linked";
    }
    refreshWorkspaceState();
    updateHistoryPlayingState();
  }

  function updateHistoryPlayingState() {
    if (!historyList) return;
    const isPlaying = !audioPlayer.paused && !audioPlayer.ended && audioPlayer.currentTime >= 0;

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

  if (playPauseBtn) {
    playPauseBtn.addEventListener("click", () => {
      if (!audioPlayer.src) return;
      if (audioPlayer.paused) {
        audioPlayer.play();
      } else {
        audioPlayer.pause();
      }
    });
  }

  if (speedBtn) {
    speedBtn.addEventListener("click", () => {
      currentSpeedIndex = (currentSpeedIndex + 1) % PLAYBACK_SPEEDS.length;
      applyPlaybackSpeed();
    });
  }

  if (downloadBtn) {
    downloadBtn.addEventListener("click", () => {
      if (!currentAudioUrl && !currentAudioBlob) {
        showError("当前没有可下载的音频。");
        return;
      }
      const a = document.createElement("a");
      a.href = currentAudioUrl;
      const dateStr = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
      a.download = `tts_${dateStr}.mp3`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  }

  audioPlayer.addEventListener("play", () => {
    triggerFusionPulse();
    if (iconPlay && iconPause) {
      iconPlay.style.display = "none";
      iconPause.style.display = "block";
    }
    startSentenceSync();
    refreshWorkspaceState();
    updateHistoryPlayingState();
    updateWaveformProgress();
  });

  audioPlayer.addEventListener("pause", () => {
    if (iconPlay && iconPause) {
      iconPlay.style.display = "block";
      iconPause.style.display = "none";
    }
    stopSentenceSync();
    refreshWorkspaceState();
    updateHistoryPlayingState();
    updateWaveformProgress();
  });

  audioPlayer.addEventListener("timeupdate", () => {
    if (!isSeeking && audioPlayer.duration) {
      const current = audioPlayer.currentTime;
      currentTimeEl.textContent = formatTime(current);
      updateWaveformProgress();
    }
  });

  audioPlayer.addEventListener("seeking", () => {
    if (activeTimeline.length) {
      const nextIndex = findSentenceIndex(audioPlayer.currentTime * 1000);
      setActiveSentence(nextIndex);
    }
  });

  audioPlayer.addEventListener("seeked", () => {
    if (activeTimeline.length) {
      const nextIndex = findSentenceIndex(audioPlayer.currentTime * 1000);
      setActiveSentence(nextIndex);
    }
  });

  audioPlayer.addEventListener("loadedmetadata", () => {
    totalDurationEl.textContent = formatTime(audioPlayer.duration);
    currentTimeEl.textContent = "00:00";
    setActiveSentence(-1);
    updateWaveformProgress();
    applyPlaybackSpeed();
  });

  audioPlayer.addEventListener("durationchange", () => {
    totalDurationEl.textContent = formatTime(audioPlayer.duration);
  });

  audioPlayer.addEventListener("ended", () => {
    if (iconPlay && iconPause) {
      iconPlay.style.display = "block";
      iconPause.style.display = "none";
    }
    stopSentenceSync();
    setActiveSentence(-1);
    currentTimeEl.textContent = "00:00";
    refreshWorkspaceState();
    updateWaveformProgress();
    updateHistoryPlayingState();
  });

  if (waveformContainer) {
    waveformContainer.addEventListener("mousemove", (e) => {
      if (!audioPlayer.duration) return;
      const rect = waveformContainer.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const previewTime = fraction * audioPlayer.duration;
      const percent = fraction * 100;
      if (waveformHoverLine) {
        waveformHoverLine.style.left = `${percent}%`;
      }
      if (waveformTooltip) {
        waveformTooltip.textContent = formatTimeWithSubseconds(previewTime);
        waveformTooltip.style.left = `${percent}%`;
      }
    });

    waveformContainer.addEventListener("click", (e) => {
      if (!audioPlayer.duration) return;
      const rect = waveformContainer.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      audioPlayer.currentTime = fraction * audioPlayer.duration;
      currentTimeEl.textContent = formatTime(audioPlayer.currentTime);
      updateWaveformProgress();
    });

    waveformContainer.addEventListener("keydown", (e) => {
      if (!audioPlayer.duration) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - 2);
        updateWaveformProgress();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        audioPlayer.currentTime = Math.min(audioPlayer.duration, audioPlayer.currentTime + 2);
        updateWaveformProgress();
      }
    });
  }

  // ── Relative time formatting (Japanese) ────────────────────────

  function parseLocalDateTime(dateStr) {
    const [datePart, timePart] = dateStr.split(" ");
    const [year, month, day] = datePart.split("-").map(Number);
    const [hour, minute, second] = timePart.split(":").map(Number);
    return new Date(year, month - 1, day, hour, minute, second);
  }

  function formatRelativeTime(dateStr) {
    const date = parseLocalDateTime(dateStr);
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

  // ── Text utilities ─────────────────────────────────────────────

  function truncateText(text, maxLen) {
    return text.length > maxLen ? text.substring(0, maxLen) + "…" : text;
  }

  function escapeHtml(str) {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(str ?? "").replace(/[&<>"']/g, (character) => entities[character]);
  }

  // ── Collapsible left history; narrow screens use an overlay. ──
  const historyDockMedia = window.matchMedia("(min-width: 1200px)");

  function syncSidebarLayout() {
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

  function openSidebar() {
    if (historySection) historySection.classList.add("open");
    syncSidebarLayout();
    if (historyDockMedia.matches) localStorage.setItem("tts_history_expanded", "1");
    loadHistory().catch(() => {});
  }

  function closeSidebar() {
    if (historySection?.contains(document.activeElement)) historyBtn?.focus();
    if (historySection) historySection.classList.remove("open");
    syncSidebarLayout();
    if (historyDockMedia.matches) localStorage.setItem("tts_history_expanded", "0");
  }

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

  // ── Client ID Management (Multi-tenant Isolation) ──────────────

  function getClientId() {
    let clientId = localStorage.getItem("tts_client_id");
    if (!clientId || clientId === "default" || !/^[A-Za-z0-9_-]{1,128}$/.test(clientId)) {
      clientId = (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
        ? crypto.randomUUID()
        : "c_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem("tts_client_id", clientId);
    }
    return clientId;
  }

  // ── History ────────────────────────────────────────────────────

  async function loadHistory() {
    try {
      const response = await apiFetch("/api/history", {
        headers: { "X-Client-ID": getClientId() },
      });
      if (!response.ok) return;

      const records = await response.json();

      // Keep cacheKey -> original text for resolving replay text.
      cacheKeyToText.clear();
      records.forEach((record) => {
        if (record.cache_key && typeof record.text === "string") {
          cacheKeyToText.set(record.cache_key, record.text);
        }
      });

      const countStr = String(records.length);
      if (historyBadge) historyBadge.textContent = countStr;
      if (headerHistoryBadge) headerHistoryBadge.textContent = countStr;
      const navHistoryBadge = document.getElementById("navHistoryBadge");
      if (navHistoryBadge) navHistoryBadge.textContent = countStr;

      if (clearHistoryBtn) {
        clearHistoryBtn.style.display = records.length > 0 ? "inline-block" : "none";
      }

      if (records.length === 0) {
        historyList.style.display = "none";
        historyEmpty.style.display = "block";
        return;
      }

      historyList.style.display = "flex";
      historyEmpty.style.display = "none";

      historyList.innerHTML = records
        .map(
          (record) => `
        <li class="history-item" data-id="${escapeHtml(record.id)}" data-cache-key="${escapeHtml(record.cache_key)}" data-engine="${escapeHtml(record.engine || "edge")}" data-voice="${escapeHtml(record.voice || "")}">
          <div class="history-item-main">
            <button class="history-play-btn history-replay-btn" title="播放" aria-label="播放" data-cache-key="${escapeHtml(record.cache_key)}">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="6 4 20 12 6 20 6 4"></polygon>
              </svg>
            </button>
            <div class="history-text-wrap">
              <div class="history-text" title="${escapeHtml(record.text)}">${escapeHtml(truncateText(record.text, 36))}</div>
              <div class="history-detail">${escapeHtml(getEngineLabel(record.engine, record.engine || "语音引擎"))} · ${escapeHtml(getVoiceLabel(record.voice))}</div>
            </div>
          </div>
          <div class="history-item-meta">
            <span class="history-time">${formatRelativeTime(record.last_played_at)}</span>
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

      updateHistoryPlayingState();
    } catch (err) {
      console.error("Failed to load history:", err);
    }
  }

  async function replayFromHistory(cacheKey, triggerBtn = null) {
    if (activeCacheKey === cacheKey && audioPlayer.src) {
      if (audioPlayer.paused) {
        audioPlayer.play();
      } else {
        audioPlayer.pause();
      }
      return;
    }

    const targetBtn =
      triggerBtn ||
      (historyList
        ? historyList.querySelector(`.history-play-btn[data-cache-key="${CSS.escape(cacheKey)}"]`)
        : null);
    if (targetBtn) {
      targetBtn.classList.add("is-loading");
    }

    hideError();
    try {
      let manifest = null;
      try {
        const flowResponse = await apiFetch(`/api/tts/flow/${cacheKey}`, {
          headers: { "X-Client-ID": getClientId() },
        });
        if (flowResponse.ok) {
          manifest = await flowResponse.json();
        }
      } catch (e) {
        // Fallback to direct audio replay on error
      }

      const audioUrl = manifest?.audio_url || `/api/tts/${cacheKey}`;
      const response = await apiFetch(audioUrl, {
        headers: { "X-Client-ID": getClientId() },
      });
      if (!response.ok) {
        showError("找不到缓存的音频，请重新生成。");
        await loadHistory();
        return;
      }

      const blob = await response.blob();
      // Resolve replay text: prefer history map, fall back to the DOM title.
      let replayText = cacheKeyToText.get(cacheKey) || null;
      const historyItem = historyList
        ? historyList.querySelector(`.history-item[data-cache-key="${CSS.escape(cacheKey)}"]`)
        : null;
      if (!replayText && historyItem) {
        const itemText = historyItem.querySelector(".history-text");
        if (itemText) replayText = itemText.getAttribute("title") || itemText.textContent || null;
      }

      if (manifest && manifest.timeline_available && manifest.sentences && manifest.sentences.length) {
        activeTimeline = manifest.sentences;
        renderSentenceRows(activeTimeline);
      } else {
        activeTimeline = [];
        setActiveSentence(-1);
        if (sentenceFlow) sentenceFlow.hidden = true;
        if (sentenceList) sentenceList.innerHTML = "";
      }

      playAudioBlob(blob, cacheKey, {
        text: replayText || "",
        engine: manifest?.engine || historyItem?.dataset.engine || engineSelect?.value || "edge",
        voice: manifest?.voice || historyItem?.dataset.voice || voiceSelect?.value || null,
      });
      // Replaying a sentence loads its stored explanation (read-only, no LLM call).
      currentExplainText = replayText;
      if (explainEnabled && replayText) {
        loadExplanationForReplay(replayText);
      } else {
        currentExplainKey = null;
        hideExplainSection();
      }
    } catch (err) {
      console.error("Replay error:", err);
      showError("音频播放失败，请重试。");
    } finally {
      if (targetBtn) {
        targetBtn.classList.remove("is-loading");
      }
    }
  }

  async function deleteFromHistory(historyId, itemEl = null) {
    if (!historyId) return;

    if (itemEl) {
      itemEl.classList.add("is-deleting");
      const remainingItems = historyList
        ? historyList.querySelectorAll(".history-item:not(.is-deleting)").length
        : 0;
      const countStr = String(remainingItems);
      if (historyBadge) historyBadge.textContent = countStr;
      if (headerHistoryBadge) headerHistoryBadge.textContent = countStr;
      const navHistoryBadge = document.getElementById("navHistoryBadge");
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
      showError("删除历史记录失败。");
      await loadHistory();
    }
  }

  async function clearAllHistory() {
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
        activeCacheKey = null;
        setTimeout(async () => {
          await loadHistory();
        }, 220);
      } else {
        throw new Error("清空历史请求失败。");
      }
    } catch (err) {
      console.error("Clear all history error:", err);
      showError("清空全部历史失败。");
      await loadHistory();
    }
  }

  function fillTextFromHistory(text) {
    if (!text) return;
    textInput.value = text;
    updateCharCount();
    syncDraftState();
    textInput.focus();
    textInput.classList.remove("text-input-flash");
    void textInput.offsetWidth;
    textInput.classList.add("text-input-flash");
  }

  // ── AI Explanation Agent ───────────────────────────────────────
  // When enabled, generating speech for a new sentence also asks the LLM
  // to explain it (fire-and-forget, never blocks playback). Replaying a
  // sentence loads its stored explanation + follow-up history read-only.

  function selectedCopilotModel() {
    return availableCopilotModels.find((model) => model.id === explainModel) || null;
  }

  function populateReasoningModes(preferredMode = "") {
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

  async function loadCopilotModels() {
    try {
      const response = await apiFetch("/api/copilot/models", {
        headers: { "X-Client-ID": getClientId() },
      });
      if (!response.ok) throw new Error("model catalog unavailable");
      const data = await response.json();
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
      renderExplainEmpty();
    }
    updateExplainInputState();
  }

  function getExplainHeaders() {
    return {
      "Content-Type": "application/json",
      "X-Client-ID": getClientId(),
    };
  }

  function updateExplainLangBadge() {
    if (explainLangBadge) {
      explainLangBadge.textContent = EXPLAIN_LANG_NAMES[explainLang] || "中文";
    }
    if (explainSection) {
      explainSection.setAttribute("data-lang", explainLang);
    }
    if (explainMessages) {
      explainMessages.setAttribute("data-lang", explainLang);
    }
  }

  function updateExplainInputState() {
    const busy = explainLoading || chatPending || !explainModel;
    if (explainSendBtn) explainSendBtn.disabled = busy;
    if (explainChatInput) explainChatInput.disabled = busy;
    if (explainRetryBtn) explainRetryBtn.disabled = busy;
  }

  function openExplainSection() {
    if (explainSection) explainSection.style.display = "flex";
  }

  function renderExplainEmpty() {
    if (!explainMessages) return;
    cancelExplainReveal();
    explainMessages.innerHTML = `
      <div class="explain-empty-card" id="explainEmptyCard">
        <div class="explain-empty-art">
          <svg viewBox="0 0 130 90" width="116" height="80" fill="none" xmlns="http://www.w3.org/2000/svg">
            <!-- Sparkle Star -->
            <path d="M102 20 Q104 14 106 20 Q112 22 106 24 Q104 30 102 24 Q96 22 102 20 Z" fill="#f48fb1" opacity="0.9"/>
            <!-- Stack of books next to cat -->
            <rect x="86" y="56" width="32" height="9" rx="2.5" fill="#ffd1dc" stroke="#f48fb1" stroke-width="1.3"/>
            <line x1="90" y1="61" x2="114" y2="61" stroke="#ffffff" stroke-width="1.2" stroke-linecap="round"/>
            <rect x="90" y="48" width="28" height="8" rx="2.5" fill="#e1bee7" stroke="#ce93d8" stroke-width="1.3"/>
            <line x1="94" y1="52" x2="114" y2="52" stroke="#ffffff" stroke-width="1.2" stroke-linecap="round"/>
            <!-- Chibi Cat Body -->
            <ellipse cx="50" cy="52" rx="22" ry="18" fill="#ffffff" stroke="#e0cbd4" stroke-width="1.6"/>
            <!-- Cat Head -->
            <circle cx="50" cy="35" r="16" fill="#ffffff" stroke="#e0cbd4" stroke-width="1.6"/>
            <!-- Ears with brown/pink patches -->
            <path d="M37 24 L42 14 L47 22 Z" fill="#8d6e63" stroke="#e0cbd4" stroke-width="1.2"/>
            <path d="M39 22 L42 16 L45 21 Z" fill="#ffcdd2"/>
            <path d="M63 24 L58 14 L53 22 Z" fill="#8d6e63" stroke="#e0cbd4" stroke-width="1.2"/>
            <path d="M61 22 L58 16 L55 21 Z" fill="#ffcdd2"/>
            <!-- Eyes -->
            <ellipse cx="44" cy="34" rx="2" ry="2.6" fill="#42303a"/>
            <ellipse cx="56" cy="34" rx="2" ry="2.6" fill="#42303a"/>
            <!-- Blush -->
            <circle cx="41" cy="38" r="3" fill="#ffb6c1" opacity="0.7"/>
            <circle cx="59" cy="38" r="3" fill="#ffb6c1" opacity="0.7"/>
            <!-- Mouth / Nose -->
            <circle cx="50" cy="36" r="1" fill="#ff80ab"/>
            <path d="M47 38 Q50 40 53 38" stroke="#42303a" stroke-width="1.1" stroke-linecap="round" fill="none"/>
            <!-- Open Book held by paws -->
            <path d="M28 58 C38 52 46 53 50 56 C54 53 62 52 72 58 L72 44 C62 39 54 40 50 43 C46 40 38 39 28 44 Z" fill="#ede7f6" stroke="#9575cd" stroke-width="1.5"/>
            <path d="M50 43 L50 56" stroke="#9575cd" stroke-width="1.5"/>
            <!-- Paws -->
            <ellipse cx="36" cy="46" rx="3.5" ry="2.5" fill="#ffffff" stroke="#e0cbd4" stroke-width="1.2"/>
            <ellipse cx="64" cy="46" rx="3.5" ry="2.5" fill="#ffffff" stroke="#e0cbd4" stroke-width="1.2"/>
          </svg>
        </div>
        <h4 class="explain-empty-title">${explainEnabled ? "AI 解说已就绪" : "AI 解说已关闭"}</h4>
        <p class="explain-empty-desc">
          ${explainEnabled
            ? "生成语音后，可以查看当前句子的翻译和语法分析。<br />你的 AI 阅读伙伴，随时为你答疑解惑。"
            : "打开开关后，可以查看当前句子的翻译和语法分析。<br />你的 AI 阅读伙伴，随时为你答疑解惑。"}
        </p>
        <div class="explain-quick-actions" role="region" aria-label="快捷分析入口">
          <button type="button" class="explain-action-card" data-action="translate">
            <span class="action-card-icon">📄</span>
            <div class="action-card-text">
              <span class="action-card-title">翻译解析</span>
              <span class="action-card-sub">多语言对照</span>
            </div>
          </button>
          <button type="button" class="explain-action-card" data-action="summary">
            <span class="action-card-icon">📑</span>
            <div class="action-card-text">
              <span class="action-card-title">要点总结</span>
              <span class="action-card-sub">提炼核心内容</span>
            </div>
          </button>
          <button type="button" class="explain-action-card" data-action="grammar">
            <span class="action-card-icon">💡</span>
            <div class="action-card-text">
              <span class="action-card-title">语法分析</span>
              <span class="action-card-sub">深入讲解</span>
            </div>
          </button>
        </div>
      </div>
    `;
  }

  function hideExplainSection() {
    // The right panel is permanent: "hiding" means showing the empty state.
    currentExplainKey = null;
    renderExplainEmpty();
  }

  function formatInlineMarkdown(text) {
    let s = escapeHtml(text);
    // Inline code: `code`
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    // Bold: **text** or __text__
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    // Italic: *text* or _text_
    s = s.replace(/(^|[^\\])\*([^*\s](?:[^*]*[^*\s])?)\*/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^\\])_([^_\s](?:[^_]*[^_\s])?)_/g, "$1<em>$2</em>");
    return s;
  }

  function renderMarkdown(rawText) {
    if (!rawText) return "";
    const lines = rawText.split("\n");
    const output = [];
    let inUl = false;
    let inOl = false;
    let inP = false;
    let staggerIndex = 0;

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

      // Empty line closes open blocks
      if (!trimmed) {
        closeList();
        closeParagraph();
        continue;
      }

      // Headings: #, ##, ###, ####
      const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        closeList();
        closeParagraph();
        const level = Math.min(headingMatch[1].length + 2, 4);
        output.push(`<h${level} style="--stagger: ${staggerIndex++}">${formatInlineMarkdown(headingMatch[2])}</h${level}>`);
        continue;
      }

      // Standalone bold heading line: e.g. **1. 中文翻译**
      const boldHeadingMatch = trimmed.match(/^\*\*([^*]+)\*\*$/);
      if (boldHeadingMatch) {
        closeList();
        closeParagraph();
        output.push(`<h4 style="--stagger: ${staggerIndex++}">${formatInlineMarkdown(boldHeadingMatch[1])}</h4>`);
        continue;
      }

      // Unordered list item: * or -
      const ulMatch = line.match(/^(\s*)[*-]\s+(.+)$/);
      if (ulMatch) {
        closeParagraph();
        if (inOl) { output.push("</ol>"); inOl = false; }
        if (!inUl) { output.push(`<ul style="--stagger: ${staggerIndex++}">`); inUl = true; }
        output.push(`<li>${formatInlineMarkdown(ulMatch[2])}</li>`);
        continue;
      }

      // Ordered list item: 1. 2. etc.
      const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
      if (olMatch) {
        closeParagraph();
        if (inUl) { output.push("</ul>"); inUl = false; }
        if (!inOl) { output.push(`<ol style="--stagger: ${staggerIndex++}">`); inOl = true; }
        output.push(`<li>${formatInlineMarkdown(olMatch[2])}</li>`);
        continue;
      }

      // Blockquote: >
      const bqMatch = trimmed.match(/^>\s*(.+)$/);
      if (bqMatch) {
        closeList();
        closeParagraph();
        output.push(`<blockquote style="--stagger: ${staggerIndex++}">${formatInlineMarkdown(bqMatch[1])}</blockquote>`);
        continue;
      }

      // Regular text inside paragraph
      closeList();
      if (!inP) {
        output.push(`<p style="--stagger: ${staggerIndex++}">` + formatInlineMarkdown(trimmed));
        inP = true;
      } else {
        output.push("<br>" + formatInlineMarkdown(trimmed));
      }
    }

    closeList();
    closeParagraph();
    return output.join("");
  }

  function appendExplainBubble(role, content) {
    if (!explainMessages) return null;
    const div = document.createElement("div");
    div.className = "explain-msg " + (role === "user" ? "explain-msg-user" : "explain-msg-assistant");
    if (explainLang) {
      div.setAttribute("data-lang", explainLang);
    }
    if (role === "assistant") {
      div.innerHTML = renderMarkdown(content);
    } else {
      div.textContent = content;
    }
    explainMessages.appendChild(div);
    explainMessages.scrollTop = explainMessages.scrollHeight;
    return div;
  }

  function cancelExplainReveal(complete = false) {
    if (!activeExplainReveal) return;
    if (explainRevealFrame !== null) cancelAnimationFrame(explainRevealFrame);
    if (complete) {
      activeExplainReveal.segments.forEach(({ node, chars }) => {
        node.textContent = chars.join("");
      });
    }
    activeExplainReveal.element.classList.remove("is-streaming");
    const resolve = activeExplainReveal.resolve;
    activeExplainReveal = null;
    explainRevealFrame = null;
    resolve();
  }

  function streamExplainBubble(content) {
    cancelExplainReveal();
    const div = appendExplainBubble("assistant", content);
    if (!div) return Promise.resolve();

    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
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
    if (!totalChars) return Promise.resolve();

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
      activeExplainReveal = { element: div, segments, resolve };

      function revealFrame(now) {
        if (!activeExplainReveal || activeExplainReveal.element !== div) return;
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
        activeExplainReveal = null;
        explainRevealFrame = null;
        resolve();
      }

      explainRevealFrame = requestAnimationFrame(revealFrame);
    });
  }

  async function renderExplainMessages(explanation, messages, options = {}) {
    if (!explainMessages) return;
    cancelExplainReveal();
    explainMessages.innerHTML = "";
    if (explainLang) {
      explainMessages.setAttribute("data-lang", explainLang);
    }
    if (explanation) {
      if (options.stream) await streamExplainBubble(explanation);
      else appendExplainBubble("assistant", explanation);
    }
    (messages || []).forEach((m) => {
      if (m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") {
        appendExplainBubble(m.role, m.content);
      }
    });
  }

  function showExplainLoading() {
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

  async function requestExplanation(text, opts = {}) {
    const manual = !!opts.manual;
    if ((!explainEnabled && !manual) || !explainModel || !explainThinking) return;
    const lang = explainLang;
    const model = explainModel;
    const thinking = explainThinking;
    // Replaying audio must not reset the matching explanation or its reveal.
    const sameExplanation =
      currentExplainText === text &&
      currentExplainLang === lang &&
      currentExplainModel === model &&
      currentExplainThinking === thinking;
    if (!manual && sameExplanation && (currentExplainKey || explainLoading)) return;

    currentExplainText = text;
    currentExplainLang = lang;
    currentExplainModel = model;
    currentExplainThinking = thinking;
    currentExplainKey = null;
    updateExplainLangBadge();
    openExplainSection();
    showExplainLoading();
    explainLoading = true;
    refreshFusionState();
    updateExplainInputState();
    try {
      const response = await apiFetch("/api/explain", {
        method: "POST",
        headers: getExplainHeaders(),
        body: JSON.stringify({ text, lang, model_id: model, mode_id: thinking }),
      });
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
      // Stale guard: another sentence may have been generated meanwhile.
      if (
        currentExplainText !== text ||
        currentExplainLang !== lang ||
        currentExplainModel !== model ||
        currentExplainThinking !== thinking
      )
        return;
      currentExplainKey = data.explain_key;
      await renderExplainMessages(data.explanation, data.messages, { stream: !data.cached });
    } catch (err) {
      console.error("Explain request error:", err);
      if (
        currentExplainText !== text ||
        currentExplainLang !== lang ||
        currentExplainModel !== model ||
        currentExplainThinking !== thinking
      )
        return;
      await renderExplainMessages(`解说获取失败：${err.message || ""}`, []);
    } finally {
      explainLoading = false;
      refreshFusionState();
      updateExplainInputState();
    }
  }

  async function loadExplanationForReplay(text) {
    const lang = explainLang;
    const model = explainModel;
    const thinking = explainThinking;
    if (!model || !thinking) return;
    currentExplainText = text;
    currentExplainLang = lang;
    currentExplainModel = model;
    currentExplainThinking = thinking;
    currentExplainKey = null;
    updateExplainLangBadge();
    explainLoading = true;
    refreshFusionState();
    updateExplainInputState();
    try {
      const response = await apiFetch(
        `/api/explain?text=${encodeURIComponent(text)}&lang=${encodeURIComponent(lang)}&model_id=${encodeURIComponent(model)}&mode_id=${encodeURIComponent(thinking)}`,
        { headers: { "X-Client-ID": getClientId() } }
      );
      if (!response.ok) {
        hideExplainSection();
        return;
      }
      const data = await response.json();
      if (
        currentExplainText !== text ||
        currentExplainLang !== lang ||
        currentExplainModel !== model ||
        currentExplainThinking !== thinking
      )
        return;
      currentExplainKey = data.explain_key;
      openExplainSection();
      await renderExplainMessages(data.explanation, data.messages);
    } catch (err) {
      console.error("Explain fetch error:", err);
      hideExplainSection();
    } finally {
      explainLoading = false;
      refreshFusionState();
      updateExplainInputState();
    }
  }

  async function sendExplainChat() {
    const message = explainChatInput ? explainChatInput.value.trim() : "";
    if (!message || chatPending || explainLoading) return;
    if (!currentExplainKey) {
      // No session yet (e.g. toggled on later): explain the current sentence first.
      if (currentExplainText) requestExplanation(currentExplainText, { manual: true });
      return;
    }
    chatPending = true;
    refreshFusionState();
    updateExplainInputState();
    appendExplainBubble("user", message);
    if (explainChatInput) explainChatInput.value = "";
    try {
      const response = await apiFetch("/api/explain/chat", {
        method: "POST",
        headers: getExplainHeaders(),
        body: JSON.stringify({
          explain_key: currentExplainKey,
          message,
          mode_id: explainThinking,
        }),
      });
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
      await streamExplainBubble(data.answer);
    } catch (err) {
      console.error("Explain chat error:", err);
      appendExplainBubble("assistant", `发送失败：${err.message || ""}`);
    } finally {
      chatPending = false;
      refreshFusionState();
      updateExplainInputState();
    }
  }

  function initExplainControls() {
    if (explainToggle) {
      explainToggle.checked = explainEnabled;
      explainToggle.addEventListener("change", () => {
        explainEnabled = explainToggle.checked;
        localStorage.setItem("tts_explain_enabled", explainEnabled ? "1" : "0");
        if (explainEnabled) {
          renderExplainEmpty();
        } else {
          hideExplainSection();
        }
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
          updateExplainLangBadge();
        }
      });
    }
    if (explainModelSelect) {
      explainModelSelect.addEventListener("change", () => {
        explainModel = explainModelSelect.value;
        localStorage.setItem("tts_explain_model", explainModel);
        populateReasoningModes("");
        currentExplainKey = null;
        currentExplainModel = null;
      });
    }
    if (explainThinkingSelect) {
      explainThinkingSelect.addEventListener("change", () => {
        const v = explainThinkingSelect.value;
        if (selectedCopilotModel()?.modes?.some((mode) => mode.id === v)) {
          explainThinking = v;
          localStorage.setItem("tts_explain_mode", v);
          currentExplainKey = null;
        }
      });
    }
    updateExplainLangBadge();
    renderExplainEmpty();
    if (explainRetryBtn) {
      explainRetryBtn.addEventListener("click", () => {
        if (currentExplainText && !explainLoading && !chatPending) {
          requestExplanation(currentExplainText, { manual: true });
        }
      });
    }
    if (explainSendBtn) {
      explainSendBtn.addEventListener("click", sendExplainChat);
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
        if (!chip) return;
        const prompt = chip.getAttribute("data-prompt");
        if (prompt && explainChatInput) {
          explainChatInput.value = prompt;
          explainChatInput.focus();
        }
      });
    }

    if (explainMessages) {
      explainMessages.addEventListener("click", (e) => {
        const actionBtn = e.target.closest(".explain-action-card");
        if (!actionBtn) return;
        const action = actionBtn.getAttribute("data-action");
        const currentText = currentExplainText || textInput.value.trim();
        if (!currentText) {
          textInput.focus();
          return;
        }
        if (action === "translate") {
          if (!currentExplainKey) {
            requestExplanation(currentText, { manual: true });
          } else if (explainChatInput) {
            explainChatInput.value = "请给出这段文本的翻译和对齐解析";
            sendExplainChat();
          }
        } else if (action === "summary") {
          if (!currentExplainKey) {
            requestExplanation(currentText, { manual: true });
          } else if (explainChatInput) {
            explainChatInput.value = "请提炼总结这句话的核心要点与主旨";
            sendExplainChat();
          }
        } else if (action === "grammar") {
          if (!currentExplainKey) {
            requestExplanation(currentText, { manual: true });
          } else if (explainChatInput) {
            explainChatInput.value = "请深入细致讲解这句话的语法结构与词汇搭配";
            sendExplainChat();
          }
        }
      });
    }
  }

  // ── Main TTS generation ────────────────────────────────────────

  async function handleResponseError(response) {
    let errorDetail = "音频生成失败，请重试。";
    try {
      const data = await response.json();
      if (data && data.detail) {
        errorDetail = localizeErrorMessage(data.detail, errorDetail);
      }
    } catch {
      if (response.status === 502) {
        errorDetail = "音频生成服务暂时不可用，请稍后重试。";
      } else if (response.status === 504) {
        errorDetail = "请求超时，请缩短文本后重试。";
      }
    }

    // If it's a missing API key error, open settings modal automatically for user convenience
    if (response.status === 400 && errorDetail.includes("API Key")) {
      openSettingsModal();
    }

    throw new Error(errorDetail);
  }

  async function handleGenerateTTS() {
    if (ttsPending) return;
    const rawText = textInput.value;
    const text = rawText.trim();

    hideError();

    if (!text) {
      showError("请输入要朗读的文本。");
      textInput.focus();
      return;
    }

    const characterCount = Array.from(text).length;
    if (characterCount < MIN_CHAR_COUNT || characterCount > MAX_CHAR_COUNT) {
      showError(`文本长度需为 ${MIN_CHAR_COUNT} 至 ${MAX_CHAR_COUNT} 字（当前 ${characterCount} 字）。`);
      return;
    }

    const selectedEngine = engineSelect ? engineSelect.value : "edge";
    const selectedVoice = voiceSelect ? voiceSelect.value : null;

    // Headers
    const headers = {
      "Content-Type": "application/json",
      "X-Client-ID": getClientId(),
    };

    // If Gemini engine is chosen, attach BYOK key if available
    if (selectedEngine === "gemini") {
      const userKey = localStorage.getItem("tts_gemini_api_key");
      if (userKey && userKey.trim()) {
        headers["X-Gemini-Api-Key"] = userKey.trim();
      }
    }

    const thisRequestId = ++ttsRequestId;
    draftText = text;
    setWorkspaceState("generating");
    setLoading(true);
    ttsPending = true;
    refreshFusionState();
    let generationSucceeded = false;

    try {
      let cacheKey = null;
      let blob = null;
      let engineUsed = selectedEngine;
      let voiceUsed = selectedVoice;

      if (selectedEngine === "edge") {
        const flowResponse = await apiFetch("/api/tts/flow", {
          method: "POST",
          headers,
          body: JSON.stringify({
            text,
            engine: selectedEngine,
            voice: selectedVoice,
          }),
        });

        if (thisRequestId !== ttsRequestId) return;

        if (flowResponse.ok) {
          const manifest = await flowResponse.json();
          if (thisRequestId !== ttsRequestId) return;

          cacheKey = manifest.cache_key;
          engineUsed = manifest.engine;
          voiceUsed = manifest.voice;
          activeTimeline = manifest.timeline_available ? (manifest.sentences || []) : [];

          // Fetch the MP3 audio
          const audioResponse = await apiFetch(manifest.audio_url, {
            headers: { "X-Client-ID": getClientId() },
          });
          if (thisRequestId !== ttsRequestId) return;

          if (!audioResponse.ok) {
            throw new Error("音频下载失败，请重试。");
          }
          blob = await audioResponse.blob();
          if (thisRequestId !== ttsRequestId) return;

        } else if (flowResponse.status === 422) {
          // Fallback to /api/tts
          activeTimeline = [];
          const response = await apiFetch("/api/tts", {
            method: "POST",
            headers,
            body: JSON.stringify({ text, engine: selectedEngine, voice: selectedVoice }),
          });
          if (thisRequestId !== ttsRequestId) return;
          if (!response.ok) {
            await handleResponseError(response);
          }
          cacheKey = response.headers.get("X-Cache-Key");
          blob = await response.blob();
          if (thisRequestId !== ttsRequestId) return;
        } else {
          await handleResponseError(flowResponse);
        }
      } else {
        // Gemini or other engines without timeline support
        activeTimeline = [];
        const response = await apiFetch("/api/tts", {
          method: "POST",
          headers,
          body: JSON.stringify({
            text,
            engine: selectedEngine,
            voice: selectedVoice,
          }),
        });
        if (thisRequestId !== ttsRequestId) return;
        if (!response.ok) {
          await handleResponseError(response);
        }
        cacheKey = response.headers.get("X-Cache-Key");
        blob = await response.blob();
        if (thisRequestId !== ttsRequestId) return;
      }

      if (cacheKey) cacheKeyToText.set(cacheKey, text);

      if (activeTimeline.length > 0) {
        renderSentenceRows(activeTimeline);
      } else {
        if (sentenceFlow) sentenceFlow.hidden = true;
        if (sentenceList) sentenceList.innerHTML = "";
      }

      playAudioBlob(blob, cacheKey, {
        text,
        engine: engineUsed,
        voice: voiceUsed,
      });
      generationSucceeded = true;

      // AI explanation runs in parallel and never blocks playback/history.
      if (explainEnabled) {
        requestExplanation(text);
      } else {
        currentExplainText = text;
        currentExplainKey = null;
      }

      // Refresh history after successful generation
      await loadHistory();
    } catch (err) {
      if (thisRequestId !== ttsRequestId) return;
      console.error("TTS request error:", err);
      showError(err.message || "音频生成失败，请重试。");
      setWorkspaceState("error");
    } finally {
      if (thisRequestId === ttsRequestId) {
        setLoading(false);
        ttsPending = false;
        refreshFusionState();
        if (!generationSucceeded) {
          refreshWorkspaceState();
        }
      }
    }
  }

  // ── Event listeners ────────────────────────────────────────────

  historyList.addEventListener("click", (e) => {
    const replayBtn = e.target.closest(".history-replay-btn");
    if (replayBtn) {
      e.stopPropagation();
      replayFromHistory(replayBtn.dataset.cacheKey, replayBtn);
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
        fillTextFromHistory(textEl.getAttribute("title"));
      }
    }
  });

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener("click", clearAllHistory);
  }

  samplePrompts.forEach((prompt) => {
    prompt.addEventListener("click", () => {
      textInput.value = prompt.dataset.sample || "";
      updateCharCount();
      syncDraftState();
      updateSentencePreview();
      textInput.focus();
      textInput.classList.remove("text-input-flash");
      void textInput.offsetWidth;
      textInput.classList.add("text-input-flash");
    });
  });

  // Escape key to smoothly close sidebar or settings modal
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (historySection && historySection.classList.contains("open")) {
        closeSidebar();
      } else if (settingsModal && settingsModal.style.display !== "none") {
        closeSettingsModal();
      }
    }
  });

  textInput.addEventListener("input", () => {
    updateCharCount();
    syncDraftState();
    clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(updateSentencePreview, 120);
  });

  // Keyboard shortcut: Ctrl+Enter or Cmd+Enter to generate
  textInput.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      if (!generateBtn.disabled) {
        handleGenerateTTS();
      }
    }
  });

  generateBtn.addEventListener("click", handleGenerateTTS);

  // ── Initialize ─────────────────────────────────────────────────
  const storedExpanded = localStorage.getItem("tts_history_expanded");
  if (historyDockMedia.matches && storedExpanded === "1") {
    historySection?.classList.add("open");
  }
  syncSidebarLayout();
  initThemeSelector();
  initWorkspaceSplitter();
  document.body.classList.add("motion-enabled");
  draftText = textInput.value.trim();
  setWorkspaceState("idle");
  updateCharCount();
  if (draftText) {
    updateSentencePreview();
  }
  renderWaveformBars(generateDefaultPeaks());
  updateWaveformProgress();
  updateKeyBadge();
  initExplainControls();
  loadCopilotModels();
  loadEngines();
  loadHistory();
});
