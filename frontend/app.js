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

  // Engine & Voice Selectors
  const engineSelect = document.getElementById("engineSelect");
  const voiceSelect = document.getElementById("voiceSelect");
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
  const progressBar = document.getElementById("progressBar");
  const speedBtn = document.getElementById("speedBtn");
  const volumeBtn = document.getElementById("volumeBtn");
  const iconVolHigh = volumeBtn ? volumeBtn.querySelector(".icon-volume-high") : null;
  const iconVolMuted = volumeBtn ? volumeBtn.querySelector(".icon-volume-muted") : null;
  const volumeBar = document.getElementById("volumeBar");
  const downloadBtn = document.getElementById("downloadBtn");

  // History & Sidebar Elements
  const historySection = document.getElementById("historySection");
  const historyList = document.getElementById("historyList");
  const historyEmpty = document.getElementById("historyEmpty");
  const historyBadge = document.getElementById("historyBadge");
  const mobileHistoryBadge = document.getElementById("mobileHistoryBadge");
  const clearHistoryBtn = document.getElementById("clearHistoryBtn");
  const sidebarToggleBtn = document.getElementById("sidebarToggleBtn");
  const sidebarCloseBtn = document.getElementById("sidebarCloseBtn");
  const sidebarBackdrop = document.getElementById("sidebarBackdrop");

  const MAX_CHAR_COUNT = 1000;
  const PLAYBACK_SPEEDS = [1.0, 1.25, 1.5, 2.0, 0.75];
  let currentSpeedIndex = 0;
  let currentAudioUrl = null;
  let currentAudioBlob = null;
  let activeCacheKey = null;
  let isSeeking = false;
  let previousVolume = 1;

  let availableEngines = [];

  // ── Engine & Voice Management ──────────────────────────────────

  async function loadEngines() {
    try {
      const res = await fetch("/api/engines");
      if (!res.ok) throw new Error("Failed to load engines list");
      availableEngines = await res.json();
      renderEngineSelect();
    } catch (err) {
      console.warn("Using fallback engine config:", err);
      availableEngines = [
        {
          id: "edge",
          name: "Edge TTS (無料・高速)",
          is_free: true,
          default_voice: "ja-JP-NanamiNeural",
          voices: [
            { id: "ja-JP-NanamiNeural", name: "七海 (Nanami - 女性・標準)" },
            { id: "ja-JP-KeitaNeural", name: "圭太 (Keita - 男性・自然)" }
          ]
        },
        {
          id: "gemini",
          name: "Gemini TTS (高品質・BYOK)",
          is_free: false,
          default_voice: "Kore",
          voices: [
            { id: "Kore", name: "Kore (女性・標準)" },
            { id: "Aoede", name: "Aoede (女性・柔らか)" },
            { id: "Leda", name: "Leda (女性・若々しい)" },
            { id: "Zephyr", name: "Zephyr (女性・明るい)" },
            { id: "Puck", name: "Puck (男性・活発)" },
            { id: "Charon", name: "Charon (男性・低音)" },
            { id: "Fenrir", name: "Fenrir (男性・力強い)" },
            { id: "Orus", name: "Orus (男性・重厚)" }
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
      .map((eng) => `<option value="${eng.id}">${escapeHtml(eng.name)}</option>`)
      .join("");

    if (availableEngines.some((e) => e.id === savedEngine)) {
      engineSelect.value = savedEngine;
    } else {
      engineSelect.value = availableEngines[0]?.id || "edge";
    }

    renderVoicesForCurrentEngine();
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
      .map((v) => `<option value="${v.id}">${escapeHtml(v.name)}</option>`)
      .join("");

    if (savedVoice && engineObj.voices.some((v) => v.id === savedVoice)) {
      voiceSelect.value = savedVoice;
    } else {
      voiceSelect.value = engineObj.default_voice || engineObj.voices[0].id;
    }
  }

  if (engineSelect) {
    engineSelect.addEventListener("change", () => {
      localStorage.setItem("tts_selected_engine", engineSelect.value);
      renderVoicesForCurrentEngine();
    });
  }

  if (voiceSelect) {
    voiceSelect.addEventListener("change", () => {
      const currentEngineId = engineSelect.value;
      localStorage.setItem(`tts_selected_voice_${currentEngineId}`, voiceSelect.value);
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
        showKeyTestResult("error", "テストする API Key を入力してください。");
        return;
      }

      showKeyTestResult("loading", "接続テスト中...");
      testKeyBtn.disabled = true;

      try {
        const res = await fetch("/api/tts/test-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: key }),
        });
        const data = await res.json();
        if (data.valid) {
          showKeyTestResult("success", data.message || "接続成功！Key は正常に使用できます。");
        } else {
          showKeyTestResult("error", data.message || "接続テストに失敗しました。");
        }
      } catch (err) {
        showKeyTestResult("error", "サーバーとの通信に失敗しました。");
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
      showKeyTestResult("loading", "API Key を削除しました。");
      setTimeout(hideKeyTestResult, 1500);
    });
  }

  // ── Character counter ──────────────────────────────────────────

  function updateCharCount() {
    const length = textInput.value.length;
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
      btnText.textContent = "生成中...";
    } else {
      generateBtn.disabled = false;
      generateBtn.classList.remove("loading");
      btnText.textContent = "音声を生成";
    }
  }

  // ── Custom Audio Player ────────────────────────────────────────

  function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0 || !isFinite(seconds)) {
      return "00:00";
    }
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }

  function updateProgressFill() {
    if (!progressBar) return;
    const val = Number(progressBar.value);
    progressBar.style.background = `linear-gradient(to right, var(--primary) 0%, var(--primary) ${val}%, #cbd5e1 ${val}%, #cbd5e1 100%)`;
  }

  function updateVolumeIcon() {
    if (!volumeBtn || !volumeBar) return;
    const isMuted = audioPlayer.muted || audioPlayer.volume === 0;
    if (iconVolHigh && iconVolMuted) {
      iconVolHigh.style.display = isMuted ? "none" : "block";
      iconVolMuted.style.display = isMuted ? "block" : "none";
    }
    volumeBar.value = audioPlayer.muted ? 0 : audioPlayer.volume;
  }

  function applyPlaybackSpeed() {
    const speed = PLAYBACK_SPEEDS[currentSpeedIndex];
    audioPlayer.playbackRate = speed;
    if (speedBtn) {
      speedBtn.textContent = `${speed.toFixed(speed % 1 === 0 ? 1 : 2)}x`;
    }
  }

  function playAudioBlob(blob, cacheKey = null) {
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

    progressBar.value = 0;
    updateProgressFill();
    currentTimeEl.textContent = "00:00";

    audioPlayer.play().catch((err) => {
      console.warn("Autoplay was blocked by browser policy:", err);
    });

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
            playBtn.setAttribute("title", "一時停止");
            playBtn.setAttribute("aria-label", "一時停止");
          }
        } else {
          item.classList.remove("is-playing");
          if (playBtn) {
            playBtn.innerHTML = `
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="6 4 20 12 6 20 6 4"></polygon>
              </svg>`;
            playBtn.setAttribute("title", "再生");
            playBtn.setAttribute("aria-label", "再生");
          }
        }
      } else {
        item.classList.remove("is-active", "is-playing");
        if (playBtn) {
          playBtn.innerHTML = `
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="6 4 20 12 6 20 6 4"></polygon>
            </svg>`;
          playBtn.setAttribute("title", "再生");
          playBtn.setAttribute("aria-label", "再生");
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
        showError("ダウンロード可能な音声がありません。");
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
    if (iconPlay && iconPause) {
      iconPlay.style.display = "none";
      iconPause.style.display = "block";
    }
    updateHistoryPlayingState();
  });

  audioPlayer.addEventListener("pause", () => {
    if (iconPlay && iconPause) {
      iconPlay.style.display = "block";
      iconPause.style.display = "none";
    }
    updateHistoryPlayingState();
  });

  audioPlayer.addEventListener("timeupdate", () => {
    if (!isSeeking && audioPlayer.duration) {
      const current = audioPlayer.currentTime;
      const duration = audioPlayer.duration;
      currentTimeEl.textContent = formatTime(current);
      const progressPercent = (current / duration) * 100;
      progressBar.value = progressPercent;
      updateProgressFill();
    }
  });

  audioPlayer.addEventListener("loadedmetadata", () => {
    totalDurationEl.textContent = formatTime(audioPlayer.duration);
    currentTimeEl.textContent = "00:00";
    progressBar.value = 0;
    updateProgressFill();
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
    progressBar.value = 0;
    updateProgressFill();
    currentTimeEl.textContent = "00:00";
    updateHistoryPlayingState();
  });

  if (progressBar) {
    progressBar.addEventListener("input", () => {
      isSeeking = true;
      if (audioPlayer.duration) {
        const previewTime = (progressBar.value / 100) * audioPlayer.duration;
        currentTimeEl.textContent = formatTime(previewTime);
      }
      updateProgressFill();
    });

    progressBar.addEventListener("change", () => {
      if (audioPlayer.duration) {
        audioPlayer.currentTime = (progressBar.value / 100) * audioPlayer.duration;
      }
      isSeeking = false;
    });
  }

  if (volumeBar) {
    volumeBar.addEventListener("input", (e) => {
      const vol = parseFloat(e.target.value);
      audioPlayer.volume = vol;
      audioPlayer.muted = vol === 0;
      if (vol > 0) {
        previousVolume = vol;
      }
      updateVolumeIcon();
    });
  }

  if (volumeBtn) {
    volumeBtn.addEventListener("click", () => {
      if (audioPlayer.muted || audioPlayer.volume === 0) {
        audioPlayer.muted = false;
        audioPlayer.volume = previousVolume > 0 ? previousVolume : 1;
      } else {
        previousVolume = audioPlayer.volume;
        audioPlayer.muted = true;
      }
      updateVolumeIcon();
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

    if (diffSec < 60) return "たった今";
    if (diffMin < 60) return `${diffMin}分前`;
    if (diffHour < 24) return `${diffHour}時間前`;
    if (diffDay < 7) return `${diffDay}日前`;

    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }

  // ── Text utilities ─────────────────────────────────────────────

  function truncateText(text, maxLen) {
    return text.length > maxLen ? text.substring(0, maxLen) + "…" : text;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // ── Sidebar Drawer (Mobile / Narrow screens) ───────────────────

  function openSidebar() {
    if (historySection) historySection.classList.add("open");
    if (sidebarBackdrop) sidebarBackdrop.classList.add("active");
  }

  function closeSidebar() {
    if (historySection) historySection.classList.remove("open");
    if (sidebarBackdrop) sidebarBackdrop.classList.remove("active");
  }

  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener("click", openSidebar);
  }

  if (sidebarCloseBtn) {
    sidebarCloseBtn.addEventListener("click", closeSidebar);
  }

  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener("click", closeSidebar);
  }

  // ── Client ID Management (Multi-tenant Isolation) ──────────────

  function getClientId() {
    let clientId = localStorage.getItem("tts_client_id");
    if (!clientId) {
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
      const response = await fetch("/api/history", {
        headers: { "X-Client-ID": getClientId() },
      });
      if (!response.ok) return;

      const records = await response.json();

      historySection.style.display = "flex";

      const countStr = String(records.length);
      if (historyBadge) historyBadge.textContent = countStr;
      if (mobileHistoryBadge) mobileHistoryBadge.textContent = countStr;

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
        <li class="history-item" data-id="${record.id}" data-cache-key="${record.cache_key}">
          <div class="history-item-main">
            <button class="history-play-btn history-replay-btn" title="再生" aria-label="再生" data-cache-key="${record.cache_key}">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="6 4 20 12 6 20 6 4"></polygon>
              </svg>
            </button>
            <div class="history-text" title="${escapeHtml(record.text)}">${escapeHtml(truncateText(record.text, 36))}</div>
          </div>
          <div class="history-item-meta">
            <span class="history-time">${formatRelativeTime(record.last_played_at)}</span>
            <button class="history-delete-btn" title="削除" aria-label="削除" data-id="${record.id}">
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

  async function replayFromHistory(cacheKey) {
    if (activeCacheKey === cacheKey && audioPlayer.src) {
      if (audioPlayer.paused) {
        audioPlayer.play();
      } else {
        audioPlayer.pause();
      }
      return;
    }

    hideError();
    try {
      const response = await fetch(`/api/tts/${cacheKey}`, {
        headers: { "X-Client-ID": getClientId() },
      });
      if (!response.ok) {
        showError("キャッシュされた音声が見つかりません。再生成してください。");
        await loadHistory();
        return;
      }

      const blob = await response.blob();
      playAudioBlob(blob, cacheKey);
    } catch (err) {
      console.error("Replay error:", err);
      showError("音声の再生に失敗しました。もう一度お試しください。");
    }
  }

  async function deleteFromHistory(historyId) {
    try {
      const response = await fetch(`/api/history/${historyId}`, {
        method: "DELETE",
        headers: { "X-Client-ID": getClientId() },
      });
      if (response.ok || response.status === 204) {
        await loadHistory();
      }
    } catch (err) {
      console.error("Delete history error:", err);
    }
  }

  async function clearAllHistory() {
    if (!window.confirm("すべての再生履歴を削除しますか？")) {
      return;
    }

    try {
      const response = await fetch("/api/history", {
        method: "DELETE",
        headers: { "X-Client-ID": getClientId() },
      });
      if (response.ok || response.status === 204) {
        activeCacheKey = null;
        await loadHistory();
      } else {
        throw new Error("削除リクエストに失敗しました。");
      }
    } catch (err) {
      console.error("Clear all history error:", err);
      showError("履歴の全件削除に失敗しました。");
    }
  }

  function fillTextFromHistory(text) {
    textInput.value = text;
    updateCharCount();
    textInput.focus();
  }

  // ── Main TTS generation ────────────────────────────────────────

  async function handleGenerateTTS() {
    const rawText = textInput.value;
    const text = rawText.trim();

    hideError();

    if (!text) {
      showError("テキストを入力してください。");
      textInput.focus();
      return;
    }

    if (text.length > MAX_CHAR_COUNT) {
      showError(`テキストの長さが上限を超えています（現在 ${text.length} 文字 / 上限 ${MAX_CHAR_COUNT} 文字）。`);
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

    setLoading(true);

    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers,
        body: JSON.stringify({
          text,
          engine: selectedEngine,
          voice: selectedVoice,
        }),
      });

      if (!response.ok) {
        let errorDetail = "音声の生成に失敗しました。もう一度お試しください。";
        try {
          const data = await response.json();
          if (data && data.detail) {
            errorDetail = data.detail;
          }
        } catch {
          if (response.status === 502) {
            errorDetail = "音声生成サービスが一時的に利用できません。時間をおいて再試行してください。";
          } else if (response.status === 504) {
            errorDetail = "リクエストがタイムアウトしました。テキストを短くして再試行してください。";
          }
        }

        // If it's a missing API key error, open settings modal automatically for user convenience
        if (response.status === 400 && errorDetail.includes("API Key")) {
          openSettingsModal();
        }

        throw new Error(errorDetail);
      }

      const cacheKey = response.headers.get("X-Cache-Key");
      const blob = await response.blob();
      playAudioBlob(blob, cacheKey);

      // Refresh history after successful generation
      await loadHistory();
    } catch (err) {
      console.error("TTS request error:", err);
      showError(err.message || "音声の生成に失敗しました。もう一度お試しください。");
    } finally {
      setLoading(false);
    }
  }

  // ── Event listeners ────────────────────────────────────────────

  historyList.addEventListener("click", (e) => {
    const replayBtn = e.target.closest(".history-replay-btn");
    if (replayBtn) {
      e.stopPropagation();
      replayFromHistory(replayBtn.dataset.cacheKey);
      return;
    }

    const deleteBtn = e.target.closest(".history-delete-btn");
    if (deleteBtn) {
      e.stopPropagation();
      deleteFromHistory(parseInt(deleteBtn.dataset.id, 10));
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

  textInput.addEventListener("input", updateCharCount);

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
  updateCharCount();
  updateProgressFill();
  updateKeyBadge();
  loadEngines();
  loadHistory();
});