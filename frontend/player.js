/**
 * TTS Web - Audio Player Module
 * Handles audio playback, decoding waveform peaks, seeking, speed, and downloads.
 */

const PLAYBACK_SPEEDS = [0.75, 1.0, 1.25];
const NUM_WAVEFORM_BARS = 48;

let currentSpeedIndex = 1;
let currentAudioUrl = null;
let currentAudioBlob = null;
let activeCacheKey = null;
let activeMetadata = { text: "", engine: null, voice: null };
let audioContext = null;
let isSeeking = false;

let playerContainer = null;
let audioPlayer = null;
let playPauseBtn = null;
let iconPlay = null;
let iconPause = null;
let currentTimeEl = null;
let totalDurationEl = null;
let waveformContainer = null;
let waveformBars = null;
let waveformHoverLine = null;
let waveformTooltip = null;
let speedBtn = null;
let downloadBtn = null;

let callbacks = {
  onPlay: () => {},
  onPause: () => {},
  onEnded: () => {},
  onTimeUpdate: () => {},
  onStateChange: () => {},
  onError: () => {},
};

export function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0 || !isFinite(seconds)) {
    return "00:00";
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export function formatTimeWithSubseconds(seconds) {
  if (isNaN(seconds) || seconds < 0 || !isFinite(seconds)) {
    return "00:00.0";
  }
  const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
  const secs = (seconds % 60).toFixed(1).padStart(4, "0");
  return `${mins}:${secs}`;
}

export function generateDefaultPeaks(numBars = NUM_WAVEFORM_BARS) {
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

export function renderWaveformBars(peaks) {
  if (!waveformBars) return;
  waveformBars.innerHTML = peaks
    .map((h, i) => `<div class="waveform-bar" style="height: ${h}%;" data-index="${i}"></div>`)
    .join("");
}

export async function extractWaveformPeaks(blob, numBars = NUM_WAVEFORM_BARS) {
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

export function updateWaveformProgress() {
  if (!waveformBars || !audioPlayer) return;
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

export function applyPlaybackSpeed() {
  if (!audioPlayer) return;
  const speed = PLAYBACK_SPEEDS[currentSpeedIndex];
  audioPlayer.playbackRate = speed;
  if (speedBtn) {
    speedBtn.textContent = `${speed.toFixed(speed % 1 === 0 ? 1 : 2)}x`;
  }
}

export function playAudioBlob(blob, cacheKey = null, metadata = {}) {
  activeMetadata = {
    text: metadata.text || "",
    engine: metadata.engine || "edge",
    voice: metadata.voice || null,
  };

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

  if (currentTimeEl) currentTimeEl.textContent = "00:00";
  updateWaveformProgress();

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

  callbacks.onStateChange();
}

export function togglePlayPause() {
  if (!audioPlayer?.src) return;
  if (audioPlayer.paused) {
    audioPlayer.play();
  } else {
    audioPlayer.pause();
  }
}

export function pause() {
  if (audioPlayer && !audioPlayer.paused) {
    audioPlayer.pause();
  }
}

export function isPlaying() {
  return Boolean(audioPlayer && !audioPlayer.paused && !audioPlayer.ended && audioPlayer.currentTime >= 0);
}

export function isAudioLoaded() {
  return Boolean(audioPlayer && audioPlayer.src);
}

export function getActiveCacheKey() {
  return activeCacheKey;
}

export function setActiveCacheKey(key) {
  activeCacheKey = key;
  callbacks.onStateChange();
}

export function getActiveMetadata() {
  return { ...activeMetadata };
}

export function getCurrentAudioBlob() {
  return currentAudioBlob;
}

export function getCurrentAudioUrl() {
  return currentAudioUrl;
}

export function initPlayer(userCallbacks = {}) {
  callbacks = { ...callbacks, ...userCallbacks };

  playerContainer = document.getElementById("playerContainer");
  audioPlayer = document.getElementById("audioPlayer");
  playPauseBtn = document.getElementById("playPauseBtn");
  iconPlay = playPauseBtn ? playPauseBtn.querySelector(".icon-play") : null;
  iconPause = playPauseBtn ? playPauseBtn.querySelector(".icon-pause") : null;
  currentTimeEl = document.getElementById("currentTime");
  totalDurationEl = document.getElementById("totalDuration");
  waveformContainer = document.getElementById("waveformContainer");
  waveformBars = document.getElementById("waveformBars");
  waveformHoverLine = document.getElementById("waveformHoverLine");
  waveformTooltip = document.getElementById("waveformTooltip");
  speedBtn = document.getElementById("speedBtn");
  downloadBtn = document.getElementById("downloadBtn");

  renderWaveformBars(generateDefaultPeaks());
  updateWaveformProgress();

  if (playPauseBtn) {
    playPauseBtn.addEventListener("click", togglePlayPause);
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
        callbacks.onError("当前没有可下载的音频。");
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

  if (audioPlayer) {
    audioPlayer.addEventListener("play", () => {
      if (iconPlay && iconPause) {
        iconPlay.style.display = "none";
        iconPause.style.display = "block";
      }
      callbacks.onPlay();
      callbacks.onStateChange();
      updateWaveformProgress();
    });

    audioPlayer.addEventListener("pause", () => {
      if (iconPlay && iconPause) {
        iconPlay.style.display = "block";
        iconPause.style.display = "none";
      }
      callbacks.onPause();
      callbacks.onStateChange();
      updateWaveformProgress();
    });

    audioPlayer.addEventListener("timeupdate", () => {
      if (!isSeeking && audioPlayer.duration) {
        const current = audioPlayer.currentTime;
        if (currentTimeEl) currentTimeEl.textContent = formatTime(current);
        updateWaveformProgress();
        callbacks.onTimeUpdate(current, audioPlayer.duration);
      }
    });

    audioPlayer.addEventListener("loadedmetadata", () => {
      if (totalDurationEl) totalDurationEl.textContent = formatTime(audioPlayer.duration);
      if (currentTimeEl) currentTimeEl.textContent = "00:00";
      updateWaveformProgress();
      applyPlaybackSpeed();
    });

    audioPlayer.addEventListener("durationchange", () => {
      if (totalDurationEl) totalDurationEl.textContent = formatTime(audioPlayer.duration);
    });

    audioPlayer.addEventListener("ended", () => {
      if (iconPlay && iconPause) {
        iconPlay.style.display = "block";
        iconPause.style.display = "none";
      }
      if (currentTimeEl) currentTimeEl.textContent = "00:00";
      callbacks.onEnded();
      callbacks.onStateChange();
      updateWaveformProgress();
    });
  }

  if (waveformContainer) {
    waveformContainer.addEventListener("mousemove", (e) => {
      if (!audioPlayer?.duration) return;
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
      if (!audioPlayer?.duration) return;
      const rect = waveformContainer.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      audioPlayer.currentTime = fraction * audioPlayer.duration;
      if (currentTimeEl) currentTimeEl.textContent = formatTime(audioPlayer.currentTime);
      updateWaveformProgress();
    });

    waveformContainer.addEventListener("keydown", (e) => {
      if (!audioPlayer?.duration) return;
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
}
