/**
 * TTS Web - API & Network Layer
 * Handles HTTP requests, timeouts, client ID, and error localization.
 */

let requestTimeoutMs = 45000;
let copilotRequestTimeoutMs = 195000;

export function getClientId() {
  let clientId = localStorage.getItem("tts_client_id");
  if (!clientId || clientId === "default" || !/^[A-Za-z0-9_-]{1,128}$/.test(clientId)) {
    clientId = (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
      ? crypto.randomUUID()
      : "c_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("tts_client_id", clientId);
  }
  return clientId;
}

export function setRequestTimeoutMs(ms) {
  if (Number.isFinite(ms) && ms > 0) {
    requestTimeoutMs = ms;
  }
}

export function getRequestTimeoutMs() {
  return requestTimeoutMs;
}

export function setCopilotRequestTimeoutMs(ms) {
  if (Number.isFinite(ms) && ms > 0) {
    copilotRequestTimeoutMs = ms;
  }
}

export function getCopilotRequestTimeoutMs() {
  return copilotRequestTimeoutMs;
}

export function localizeErrorMessage(detail, fallback = "操作失败，请重试。") {
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

export async function apiFetch(url, options = {}, timeoutOverride = null) {
  const target = new URL(url, window.location.href);
  if (target.origin !== window.location.origin) throw new Error("响应地址无效。");
  const controller = new AbortController();
  const timeout = timeoutOverride || requestTimeoutMs;
  const timer = setTimeout(() => controller.abort(), timeout);
  let reader;
  try {
    const response = await fetch(target.href, { ...options, signal: controller.signal });
    // Keep deadline active while receiving response body
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
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时，请稍后重试。");
    throw error;
  } finally {
    clearTimeout(timer);
    reader?.releaseLock();
  }
}

export async function handleResponseError(response) {
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

  throw new Error(errorDetail);
}

export function escapeHtml(str) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(str ?? "").replace(/[&<>"']/g, (character) => entities[character]);
}
