import { apiFetch, getClientId, handleResponseError } from './api.js';

const players = new Set();

function formatAudioTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** One card owns one audio element and its custom player bar. */
export class MessagePlayer {
  constructor(container, message, onExpired, blob = null) {
    this.disposed = false;
    this.loading = false;
    this.url = null;
    this.currentSpeed = 1;

    // 原生 audio 元素继续保留以确保所有底层方法及测试断言正常运作
    this.audio = document.createElement('audio');
    this.audio.preload = 'metadata';
    this.audio.className = 'audio-native-hidden';
    this.audio.setAttribute('aria-label', '语音播放器');

    this.button = document.createElement('button');
    this.button.className = 'audio-action';
    this.button.textContent = '▶ 加载并播放';

    this.status = document.createElement('div');
    this.status.className = 'audio-status';

    // 现代高颜值自定义翡翠绿播放条（含 0.75x, 1x, 1.25x 倍速切换）
    this.customPlayer = document.createElement('div');
    this.customPlayer.className = 'custom-player';
    this.customPlayer.hidden = true;
    this.customPlayer.innerHTML = `
      <button class="player-btn-toggle" type="button" aria-label="播放音频" title="播放">
        <span class="player-icon icon-play">▶</span>
        <span class="player-icon icon-pause" style="display:none">❚❚</span>
      </button>
      <div class="player-body">
        <div class="player-progress-container" role="slider" aria-label="播放进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0">
          <div class="player-progress-bg">
            <div class="player-progress-fill" style="width: 0%"></div>
            <div class="player-progress-thumb" style="left: 0%"></div>
          </div>
        </div>
        <div class="player-meta-row">
          <span class="player-timer"><span class="curr-time">0:00</span> / <span class="total-time">0:00</span></span>
          <div class="player-speeds" role="group" aria-label="播放倍速">
            <button type="button" class="speed-btn" data-speed="0.75" title="0.75 倍速">0.75x</button>
            <button type="button" class="speed-btn active" data-speed="1" title="正常倍速 (1.0x)">1x</button>
            <button type="button" class="speed-btn" data-speed="1.25" title="1.25 倍速">1.25x</button>
          </div>
          <a class="player-download-link" title="下载此语音音频" download="tts-${message.id}.mp3">下载 ↓</a>
        </div>
      </div>
    `;

    container.append(this.button, this.audio, this.customPlayer, this.status);
    players.add(this);

    const toggleBtn = this.customPlayer.querySelector('.player-btn-toggle');
    const playIcon = this.customPlayer.querySelector('.icon-play');
    const pauseIcon = this.customPlayer.querySelector('.icon-pause');
    const progressContainer = this.customPlayer.querySelector('.player-progress-container');
    const progressFill = this.customPlayer.querySelector('.player-progress-fill');
    const progressThumb = this.customPlayer.querySelector('.player-progress-thumb');
    const currTime = this.customPlayer.querySelector('.curr-time');
    const totalTime = this.customPlayer.querySelector('.total-time');
    const customDownload = this.customPlayer.querySelector('.player-download-link');
    this.customDownload = customDownload;

    // 绑定倍速切换按钮
    const speedButtons = this.customPlayer.querySelectorAll('.speed-btn');
    speedButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const speed = parseFloat(btn.dataset.speed);
        if (!Number.isFinite(speed)) return;
        this.currentSpeed = speed;
        this.audio.playbackRate = speed;
        speedButtons.forEach(b => b.classList.toggle('active', b === btn));
      });
    });

    toggleBtn.addEventListener('click', () => {
      if (this.audio.paused) {
        this.audio.play().catch(() => {});
      } else {
        this.audio.pause();
      }
    });

    const updateProgress = () => {
      const duration = this.audio.duration;
      const current = this.audio.currentTime;
      if (Number.isFinite(duration) && duration > 0) {
        const pct = Math.min(100, Math.max(0, (current / duration) * 100));
        progressFill.style.width = `${pct}%`;
        progressThumb.style.left = `${pct}%`;
        progressContainer.setAttribute('aria-valuenow', Math.round(pct));
        currTime.textContent = formatAudioTime(current);
        totalTime.textContent = formatAudioTime(duration);
      } else {
        currTime.textContent = formatAudioTime(current);
      }
    };

    this.audio.addEventListener('play', () => {
      players.forEach(player => { if (player !== this) player.audio.pause(); });
      playIcon.style.display = 'none';
      pauseIcon.style.display = 'inline-block';
      toggleBtn.title = '暂停';
      toggleBtn.setAttribute('aria-label', '暂停音频');
    });

    this.audio.addEventListener('pause', () => {
      playIcon.style.display = 'inline-block';
      pauseIcon.style.display = 'none';
      toggleBtn.title = '播放';
      toggleBtn.setAttribute('aria-label', '播放音频');
    });

    this.audio.addEventListener('ended', () => {
      playIcon.style.display = 'inline-block';
      pauseIcon.style.display = 'none';
      progressFill.style.width = '0%';
      progressThumb.style.left = '0%';
      currTime.textContent = '0:00';
    });

    this.audio.addEventListener('timeupdate', updateProgress);
    this.audio.addEventListener('durationchange', updateProgress);
    this.audio.addEventListener('loadedmetadata', updateProgress);

    this.audio.addEventListener('error', () => {
      if (this.disposed) return;
      this.status.textContent = '音频无法播放，请重新生成。';
      onExpired();
    });

    // 拖动与点击调整进度
    const seek = (event) => {
      const rect = progressContainer.getBoundingClientRect();
      if (!rect.width) return;
      const duration = this.audio.duration;
      if (!Number.isFinite(duration) || duration <= 0) return;
      const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      this.audio.currentTime = pct * duration;
      updateProgress();
    };

    let isDragging = false;
    progressContainer.addEventListener('mousedown', (e) => {
      isDragging = true;
      seek(e);
    });
    this.onMouseMove = (e) => {
      if (isDragging) seek(e);
    };
    this.onMouseUp = () => {
      isDragging = false;
    };
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);

    this.button.addEventListener('click', async () => {
      if (this.loading) return;
      this.loading = true;
      this.button.disabled = true;
      this.button.textContent = '正在加载…';
      try {
        if (!/^(?:[a-f0-9]{16}|[a-f0-9]{64})$/.test(message.audio.cacheKey || '')) {
          onExpired();
          return;
        }
        const response = await apiFetch(`/api/tts/${message.audio.cacheKey}`, { headers: { 'X-Client-ID': getClientId() } });
        if (this.disposed) return;
        if (response.status === 404 || response.status === 410) { onExpired(); return; }
        if (!response.ok) await handleResponseError(response);
        const audioBlob = await response.blob();
        if (this.disposed) return;
        this.attach(audioBlob);
        try { await this.audio.play(); }
        catch { this.status.textContent = '音频已加载，点击播放器开始播放。'; }
      } catch (error) {
        if (!this.disposed) this.status.textContent = error.message || '加载失败，请重试。';
      } finally {
        this.loading = false;
        this.button.disabled = false;
        this.button.textContent = '▶ 重新加载并播放';
      }
    });

    if (blob) this.attach(blob);
  }

  attach(blob) {
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(blob);
    this.audio.src = this.url;
    this.audio.playbackRate = this.currentSpeed || 1;
    this.customPlayer.hidden = false;
    this.button.hidden = true;
    this.customDownload.href = this.url;
    this.status.textContent = '';
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.url) URL.revokeObjectURL(this.url);
    players.delete(this);
  }
}
