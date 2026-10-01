/** Durable text and parameter records. Audio bytes stay in the server cache. */
const newId = () => globalThis.crypto?.randomUUID?.() || `c_${Date.now()}_${Math.random().toString(36).slice(2)}`;

export class ConversationStore {
  constructor(storage, clientId) {
    this.storage = storage;
    this.key = `tts_conversations_v1:${clientId}`;
    this.read();
  }

  read() {
    try {
      const raw = this.storage.getItem(this.key);
      const data = raw ? JSON.parse(raw) : { version: 1, migrated: false, conversations: [] };
      if (data.version !== 1 || !Array.isArray(data.conversations) || data.conversations.some(c =>
        typeof c.id !== 'string' || !Array.isArray(c.messages) || c.messages.some(m =>
          typeof m.id !== 'string' || typeof m.text !== 'string' || !m.audio))) throw new Error('Invalid records');
      return data;
    } catch {
      throw new Error('无法读取本地会话记录。请保留浏览器数据，检查存储设置后重试。');
    }
  }

  mutate(change) {
    const data = this.read();
    const result = change(data);
    try { this.storage.setItem(this.key, JSON.stringify(data)); }
    catch { throw new Error('会话保存失败，可能是浏览器存储空间不足。请释放空间后重试。'); }
    return result;
  }

  list() { return this.read().conversations.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id) { return this.read().conversations.find(c => c.id === id) || null; }
  get migrated() { return this.read().migrated; }

  create() {
    return this.mutate(data => {
      const now = new Date().toISOString();
      const conversation = { id: newId(), title: '新会话', createdAt: now, updatedAt: now, messages: [] };
      data.conversations.push(conversation);
      return conversation;
    });
  }

  remove(id) { this.mutate(data => { data.conversations = data.conversations.filter(c => c.id !== id); }); }

  append(id, text, parameters) {
    return this.mutate(data => {
      const conversation = data.conversations.find(c => c.id === id);
      if (!conversation) throw new Error('会话已删除，请新建会话。');
      const now = new Date().toISOString();
      const message = { id: newId(), text, engine: parameters.engine, voice: parameters.voice,
        createdAt: now, audio: { status: 'pending', cacheKey: null, error: '' } };
      if (!conversation.messages.length) {
        const clean = text.trim().replace(/\s+/g, ' ');
        const chars = Array.from(clean);
        const maxLen = 18;
        conversation.title = chars.length > maxLen ? chars.slice(0, maxLen).join('') + '…' : (chars.join('') || '新会话');
      }
      conversation.messages.push(message);
      conversation.updatedAt = now;
      return message;
    });
  }

  updateAudio(conversationId, messageId, patch) {
    return this.mutate(data => {
      const message = data.conversations.find(c => c.id === conversationId)?.messages.find(m => m.id === messageId);
      if (!message) return false;
      Object.assign(message.audio, patch);
      return true;
    });
  }

  recoverPending() {
    this.mutate(data => data.conversations.forEach(c => c.messages.forEach(m => {
      if (m.audio.status === 'pending') Object.assign(m.audio, { status: 'error', error: '上次生成已中断，请重试。' });
    })));
  }

  migrate(records) {
    if (!Array.isArray(records)) throw new Error('历史数据格式无效，请重试导入。');
    this.mutate(data => {
      if (data.migrated) return;
      const messages = records.filter(r => typeof r.text === 'string').slice()
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .map(record => ({ id: newId(), text: record.text, engine: record.engine || 'edge', voice: record.voice,
          createdAt: record.created_at, legacyHistoryId: record.id,
          audio: { cacheKey: record.cache_key, status: (!record.audio_status || record.audio_status === 'ready') && record.cache_key ? 'ready' : 'expired', error: '' } }));
      if (messages.length) {
        const now = new Date().toISOString();
        data.conversations.push({ id: newId(), title: '历史记录', createdAt: now, updatedAt: now, messages });
      }
      data.migrated = true;
    });
  }
}
