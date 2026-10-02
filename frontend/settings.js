/**
 * TTS Web - Settings Module
 * Manages engines, voices, theme switching, and BYOK Gemini API Key settings.
 */

import { apiFetch, localizeErrorMessage, escapeHtml } from "./api.js";

const THEME_STORAGE_KEY = "tts_theme";
const DEFAULT_THEME = "light";

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

let availableEngines = [];
let maxCharCount = 1000;
let minCharCount = 1;

let engineSelect = null;
let voiceSelect = null;
let engineBadge = null;
let settingsBtn = null;
let keyStatusBadge = null;

let settingsModal = null;
let modalCloseBtn = null;
let geminiApiKeyInput = null;
let toggleKeyVisibilityBtn = null;
let testKeyBtn = null;
let clearKeyBtn = null;
let saveKeyBtn = null;
let keyTestResult = null;
let themeOptionsGrid = null;

let callbacks = {
  onLimitsLoaded: () => {},
};

export function getEngineById(engineId = engineSelect?.value) {
  return availableEngines.find((engine) => engine.id === engineId) || null;
}

export function getEngineLabel(engineId, fallback = "语音引擎") {
  return ENGINE_LABELS[engineId] || fallback;
}

export function getVoiceLabel(voiceId, fallback = "默认声音") {
  return VOICE_LABELS[voiceId] || fallback;
}

export function getSelectedEngine() {
  return engineSelect ? engineSelect.value : "edge";
}

export function getSelectedVoice() {
  return voiceSelect ? voiceSelect.value : null;
}

export function getMaxCharCount() {
  return maxCharCount;
}

export function getMinCharCount() {
  return minCharCount;
}

export function updateEngineMeta() {
  const engine = getEngineById();
  if (engineBadge) {
    engineBadge.textContent = engine?.is_free ? "免费" : "高品质";
    engineBadge.classList.toggle("is-paid", !engine?.is_free);
  }
}

export function renderEngineSelect() {
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

export function renderVoicesForCurrentEngine() {
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

export async function loadEngines() {
  try {
    const res = await apiFetch("/api/engines");
    if (!res.ok) throw new Error("Failed to load engines list");
    availableEngines = await res.json();
    const limits = availableEngines[0];
    if (Number.isInteger(limits?.max_text_length)) maxCharCount = limits.max_text_length;
    if (Number.isInteger(limits?.min_text_length)) minCharCount = limits.min_text_length;
    
    renderEngineSelect();
    callbacks.onLimitsLoaded({
      minCharCount,
      maxCharCount,
      requestTimeoutSeconds: limits?.request_timeout_seconds,
      storageMode: limits?.storage_mode,
    });
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
          { id: "ja-JP-KeitaNeural", name: "圭太 · 日语男声" },
        ],
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
          { id: "Orus", name: "Orus · 男声 · 厚重" },
        ],
      },
    ];
    renderEngineSelect();
    callbacks.onLimitsLoaded({
      minCharCount,
      maxCharCount,
      requestTimeoutSeconds: 30,
      storageMode: "shared",
    });
  }
}

// ── Theme Management ─────────────────────────────────────────────

export function applyTheme(themeId) {
  const validTheme = themeId === "dark" ? "dark" : DEFAULT_THEME;
  document.documentElement.setAttribute("data-theme", validTheme);
  document.body.setAttribute("data-theme", validTheme);
  localStorage.setItem(THEME_STORAGE_KEY, validTheme);

  if (themeOptionsGrid) {
    const btns = themeOptionsGrid.querySelectorAll(".theme-option-btn");
    btns.forEach((btn) => {
      const isActive = btn.getAttribute("data-theme") === validTheme;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-checked", String(isActive));
    });
  }
}

export function getCurrentTheme() {
  return localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME;
}

export function initThemeSelector() {
  const rawTheme = localStorage.getItem(THEME_STORAGE_KEY);
  // Migrate legacy daytime themes to "light"
  const savedTheme = rawTheme === "dark" ? "dark" : DEFAULT_THEME;
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

function initMotionSelector() {
  const select = document.getElementById("motionSelect");
  const hint = document.getElementById("motionHint");
  const systemMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const stored = localStorage.getItem("tts_motion");
  let preference = ["system", "full", "reduced"].includes(stored) ? stored : "system";
  const apply = () => {
    document.body.dataset.motion = preference;
    if (select) select.value = preference;
    if (hint) hint.textContent = preference === "system"
      ? `当前跟随系统：${systemMotion.matches ? "关闭" : "开启"}动效。即时生效并自动保存。`
      : preference === "full"
        ? "已开启侧栏滑动与遮罩渐变，不受系统偏好影响。自动保存。"
        : "已关闭界面动效。自动保存。";
  };
  select?.addEventListener("change", () => {
    preference = select.value;
    localStorage.setItem("tts_motion", preference);
    apply();
  });
  systemMotion.addEventListener("change", apply);
  apply();
}

// ── BYOK API Key Modal & Management ──────────────────────────────

export function updateKeyBadge() {
  const key = localStorage.getItem("tts_gemini_api_key");
  if (keyStatusBadge) {
    keyStatusBadge.style.display = key && key.trim() ? "inline-block" : "none";
  }
}

export function getApiKey() {
  return localStorage.getItem("tts_gemini_api_key") || "";
}

export function isSettingsModalOpen() {
  return Boolean(settingsModal && settingsModal.style.display !== "none");
}

export function openSettingsModal() {
  if (!settingsModal) return;
  const storedKey = getApiKey();
  if (geminiApiKeyInput) {
    geminiApiKeyInput.value = storedKey;
    geminiApiKeyInput.type = "password";
  }
  const currentTheme = getCurrentTheme();
  applyTheme(currentTheme);
  hideKeyTestResult();
  settingsModal.style.display = "flex";
  geminiApiKeyInput?.focus();
}

export function closeSettingsModal() {
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

export function initSettings(userCallbacks = {}) {
  callbacks = { ...callbacks, ...userCallbacks };

  engineSelect = document.getElementById("engineSelect");
  voiceSelect = document.getElementById("voiceSelect");
  engineBadge = document.getElementById("engineBadge");
  settingsBtn = document.getElementById("settingsBtn");
  keyStatusBadge = document.getElementById("keyStatusBadge");

  settingsModal = document.getElementById("settingsModal");
  modalCloseBtn = document.getElementById("modalCloseBtn");
  geminiApiKeyInput = document.getElementById("geminiApiKeyInput");
  toggleKeyVisibilityBtn = document.getElementById("toggleKeyVisibilityBtn");
  testKeyBtn = document.getElementById("testKeyBtn");
  clearKeyBtn = document.getElementById("clearKeyBtn");
  saveKeyBtn = document.getElementById("saveKeyBtn");
  keyTestResult = document.getElementById("keyTestResult");
  themeOptionsGrid = document.getElementById("themeOptionsGrid");

  if (engineSelect) {
    engineSelect.addEventListener("change", () => {
      localStorage.setItem("tts_selected_engine", engineSelect.value);
      renderVoicesForCurrentEngine();
    });
  }

  if (voiceSelect) {
    voiceSelect.addEventListener("change", () => {
      const currentEngineId = engineSelect?.value || "edge";
      localStorage.setItem(`tts_selected_voice_${currentEngineId}`, voiceSelect.value);
      updateEngineMeta();
    });
  }

  initThemeSelector();
  initMotionSelector();

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
      if (!geminiApiKeyInput) return;
      geminiApiKeyInput.type = geminiApiKeyInput.type === "password" ? "text" : "password";
    });
  }

  if (testKeyBtn) {
    testKeyBtn.addEventListener("click", async () => {
      const key = geminiApiKeyInput?.value.trim() || "";
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
      const key = geminiApiKeyInput?.value.trim() || "";
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
      if (geminiApiKeyInput) geminiApiKeyInput.value = "";
      localStorage.removeItem("tts_gemini_api_key");
      updateKeyBadge();
      showKeyTestResult("loading", "API Key 已删除。");
      setTimeout(hideKeyTestResult, 1500);
    });
  }

  updateKeyBadge();
}
