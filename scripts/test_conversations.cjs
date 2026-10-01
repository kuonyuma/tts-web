const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const filename = path.join(__dirname, '../frontend/conversations.js');
  assert(fs.existsSync(filename), 'Conversation persistence module must exist');
  const { ConversationStore } = await import('data:text/javascript;base64,' + fs.readFileSync(filename).toString('base64'));
  const values = new Map();
  const storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
  const a = new ConversationStore(storage, 'client-a');
  const c1 = a.create();
  const parameters = { engine: 'edge', voice: 'Nanami' };
  const m1 = a.append(c1.id, 'こんにちは', parameters);
  parameters.voice = 'Changed';
  const c2 = a.create();
  a.append(c2.id, '第二个会话', { engine: 'gemini', voice: 'Kore' });
  a.updateAudio(c1.id, m1.id, { status: 'ready', cacheKey: 'a'.repeat(64) });
  assert.equal(a.get(c1.id).messages[0].audio.status, 'ready');
  assert.equal(a.get(c1.id).messages[0].voice, 'Nanami');
  assert.equal(a.get(c2.id).messages[0].audio.status, 'pending');
  assert.equal(new ConversationStore(storage, 'client-b').list().length, 0);
  const restored = new ConversationStore(storage, 'client-a');
  assert.equal(restored.get(c1.id).messages[0].text, 'こんにちは');
  restored.recoverPending();
  assert.equal(restored.get(c2.id).messages[0].audio.status, 'error');
  restored.remove(c1.id);
  assert.equal(restored.updateAudio(c1.id, m1.id, { status: 'ready' }), false);
  assert.equal(restored.get(c1.id), null);
  console.log('PASS persistence, client isolation, parameter snapshots, interrupted recovery, late result after deletion');

  const history = [{ id: 1, text: 'old', engine: 'edge', voice: 'Nanami', cache_key: 'b'.repeat(64), created_at: '2026-01-01T00:00:00Z', audio_status: 'missing' }];
  restored.migrate(history);
  const migrated = restored.list().find(c => c.title === '历史记录');
  assert.equal(migrated.messages[0].text, 'old');
  assert.equal(migrated.messages[0].audio.status, 'expired');
  restored.remove(migrated.id);
  restored.migrate(history);
  assert.equal(restored.list().filter(c => c.title === '历史记录').length, 0);
  console.log('PASS legacy migration preserves text and never resurrects deleted conversations');

  const broken = { getItem: () => '{bad', setItem: () => assert.fail('must not overwrite corrupt data') };
  assert.throws(() => new ConversationStore(broken, 'client'), /读取/);
  const full = new ConversationStore({ getItem: () => null, setItem: () => { throw new Error('quota'); } }, 'client');
  assert.throws(() => full.create(), /保存/);
  console.log('PASS corrupt and full storage report errors instead of silently losing text');
})().catch(error => { console.error(error); process.exitCode = 1; });
