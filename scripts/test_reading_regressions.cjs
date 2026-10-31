// Real browser regressions for vocabulary persistence and sentence playback; no live providers.
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { serveFrontend } = require('./frontend_test_server.cjs');
const { launchBrowser } = require('./browser_test_helper.cjs');

const original = { id: randomUUID(), word: '読書', surface: '', mastered: false, review_count: 0 };
const items = new Map([[original.id, { ...original }]]);
let failureStatus = 0;
let failCollection = false;
let lookupCalls = 0;
const ttsTexts = [];
const wav = Buffer.alloc(44 + 24000 * 2 * 5);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(status === 204 ? '' : JSON.stringify(data));
  };
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!doctype html><link rel="stylesheet" href="/articles.css">
      <section id="reader" class="article-editor"><div class="article-preview"></div></section>
      <div id="vocab"></div><script type="module" src="/fixture.js"></script>`);
  }
  if (url.pathname === '/fixture.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(`import { VocabStore, InlineWordPopover, VocabWorkspaceView, flashWordInArticlePreview, quickSpeaker } from '/vocab.js';
      import { ArticleReaderController, segmentArticlePreview, highlightSavedWordsInPreview } from '/article-reader.js';
      window.notices = [];
      const notify = message => notices.push(message);
      window.store = new VocabStore({accountId:1});
      await store.syncFromServer();
      window.popover = new InlineWordPopover({store,notify});
      window.vocabView = new VocabWorkspaceView({container:document.getElementById('vocab'),store,notify});
      window.reader = new ArticleReaderController(document.getElementById('reader'), {entryId:'fixture',notify});
      window.setPreview = text => {
        reader.preview.replaceChildren();
        const block = document.createElement('div'); block.className='article-reading-block';
        const p = document.createElement('p'); p.textContent=text; block.appendChild(p); reader.preview.appendChild(block);
        reader.setSentences(segmentArticlePreview(reader.preview));
        highlightSavedWordsInPreview(reader.preview,store.items);
      };
      store.subscribe(() => highlightSavedWordsInPreview(reader.preview,store.items));
      window.VocabStore=VocabStore; window.flashWordInArticlePreview=flashWordInArticlePreview;
      window.highlightSavedWordsInPreview=highlightSavedWordsInPreview; window.quickSpeaker=quickSpeaker;
      window.ready=true;`);
  }
  if (url.pathname === '/api/explain/word') {
    lookupCalls++;
    return json({ word: '申し込む', reading: 'もうしこむ', pos: '動詞', meaning: '报名', note: '过去式' });
  }
  if (url.pathname === '/api/tts') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    ttsTexts.push(JSON.parse(raw).text);
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Cache-Key': 'c'.repeat(64) });
    return res.end(wav);
  }
  if (url.pathname.startsWith('/api/vocab')) {
    const id = url.pathname.split('/')[3];
    if (req.method === 'GET') {
      return failCollection ? json({ detail: '接口不存在' }, 404) : json([...items.values()]);
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (failureStatus) return json({ detail: '保存失败测试' }, failureStatus);
    if (req.method === 'POST') {
      const existing = [...items.values()].find(item => item.word === body.word);
      const saved = { review_count: 0, ...existing, ...body, id: existing?.id || randomUUID() };
      items.set(saved.id, saved);
      return json(saved, existing ? 200 : 201);
    }
    if (!items.has(id)) return json({ detail: '生词记录不存在或已删除。' }, 404);
    if (req.method === 'PATCH') {
      const previous = items.get(id);
      const { review_delta = 0, ...fields } = body;
      const saved = { ...previous, ...fields, review_count: previous.review_count + review_delta };
      items.set(id, saved);
      return json(saved);
    }
    if (req.method === 'DELETE') { items.delete(id); return json(null, 204); }
  }
  serveFrontend(res, url.pathname);
});

let browser;
(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await launchBrowser({ profilePrefix: 'tts-reading-', args: ['--autoplay-policy=no-user-gesture-required'], exceptionDescriptions: true });
    const { send, evaluate, wait, exceptions } = browser;
    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('tts_explain_model','test');localStorage.setItem('tts_explain_mode','direct');" });
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await wait('window.ready');
    const id = JSON.stringify(original.id);
    const before = await evaluate('JSON.stringify(store.items)');
    const mirror = await evaluate('localStorage.getItem(store.storageKey)');
    for (const status of [401, 409, 429, 503]) {
      failureStatus = status;
      for (const operation of [`store.update(${id},{mastered:true,review_delta:1})`, `store.remove(${id})`]) {
        assert.equal(await evaluate(`(async()=>{try{await ${operation};return 'unexpected success';}catch(error){return error.status;}})()`), status);
        assert.equal(await evaluate('JSON.stringify(store.items)'), before);
        assert.equal(await evaluate('localStorage.getItem(store.storageKey)'), mirror);
      }
    }
    failureStatus = 0;
    await evaluate("window.realFetch=window.fetch;window.fetch=()=>Promise.reject(new TypeError('offline'));");
    for (const operation of [`store.update(${id},{mastered:true})`, `store.remove(${id})`]) {
      assert.equal(await evaluate(`(async()=>{try{await ${operation};return false;}catch{return true;}})()`), true);
      assert.equal(await evaluate('JSON.stringify(store.items)'), before);
    }
    await evaluate('window.fetch=window.realFetch');
    console.log('PASS failed PATCH/DELETE and network errors retain records and local mirror');

    items.delete(original.id);
    assert.equal(await evaluate(`(async()=>{try{await store.update(${id},{mastered:true});}catch(error){return error.status;}})()`), 404);
    await evaluate("store.upsert({word:'上場'})");
    assert([...items.values()].some(item => item.word === '上場'));
    await evaluate(`store.remove(${id})`);
    await evaluate("store.upsert({word:'資金調達'})");
    assert([...items.values()].some(item => item.word === '資金調達'));
    failCollection = true;
    failureStatus = 503;
    await evaluate('store.syncFromServer()');
    assert.equal(await evaluate("(async()=>{try{await store.upsert({word:'保存してはいけない'});return false;}catch{return true;}})()"), true);
    failCollection = false;
    failureStatus = 0;
    console.log('PASS individual and collection 404 responses never redirect account writes to local storage');

    items.clear(); items.set(original.id, { ...original });
    await evaluate('store.syncFromServer()');
    failureStatus = 503;
    await evaluate("popover.open({word:'読書'});document.querySelector('.vocab-pop-star').click()");
    await wait('notices.length > 0');
    assert.equal(await evaluate(`popover.currentContext.savedId===${id}`), true);
    assert.equal(await evaluate("document.querySelector('.vocab-pop-star').getAttribute('aria-pressed')"), 'true');
    await evaluate("popover.close();vocabView.container.querySelector('[data-vocab-mode=cards]').click();vocabView.container.querySelector('.vocab-flashcard').click();notices.length=0;vocabView.container.querySelector('.flashcard-btn-know').click()");
    await wait('!vocabView.reviewPending && notices.length > 0');
    assert.equal(await evaluate('vocabView.sessionDone'), false);
    assert.equal(await evaluate('vocabView.cardQueue.length'), 1);
    assert.equal(await evaluate(`store.get(${id}).mastered`), false);
    failureStatus = 0;
    await evaluate("vocabView.container.querySelector('.flashcard-btn-know').click()");
    await wait('vocabView.sessionDone && !vocabView.reviewPending');
    assert.equal(items.get(original.id).review_count, 1);
    console.log('PASS failed star removal and flashcard reviews stay retryable until confirmed by server');

    const sentence = '昨日、新しい講座に申し込んだ。';
    await evaluate(`setPreview(${JSON.stringify(sentence)});popover.open({word:'申し込んだ',sentence:${JSON.stringify(sentence)},articleId:'fixture'})`);
    await wait("!popover.currentContext.loading && popover.currentContext.word==='申し込む'");
    await evaluate("document.querySelector('.vocab-pop-save-btn').click()");
    await wait("!!store.findByWord('申し込んだ')");
    assert.equal(await evaluate("reader.preview.querySelector('mark.article-vocab-highlight').textContent"), '申し込んだ');
    assert.equal(await evaluate('reader.preview.textContent'), sentence);
    assert.equal([...items.values()].find(item => item.word === '申し込む').surface, '申し込んだ');
    await evaluate("(async()=>{window.reloadedStore=new VocabStore({accountId:1});await reloadedStore.syncFromServer();highlightSavedWordsInPreview(reader.preview,reloadedStore.items);})()");
    assert.equal(await evaluate("flashWordInArticlePreview(reader.preview,'申し込む')"), true);
    const lookupsBeforeReopen = lookupCalls;
    await evaluate("popover.close();popover.open({word:'申し込んだ'})");
    assert.equal(await evaluate('popover.currentContext.loading'), false);
    assert.equal(lookupCalls, lookupsBeforeReopen);
    console.log('PASS lemma and original inflection persist and support highlight, lookup and location after reload');

    const callsBeforeLongText = ttsTexts.length;
    assert.match(await evaluate("reader.synthesizeSentenceBlob('あ'.repeat(1001)).then(()=>'',error=>error.message)"), /超过 1000 字/);
    await evaluate("notices.length=0;quickSpeaker.speak('あ'.repeat(1001),message=>notices.push(message))");
    assert.match(await evaluate('notices.at(-1)'), /超过 1000 字/);
    assert.equal(ttsTexts.length, callsBeforeLongText);
    await evaluate("reader.synthesizeSentenceBlob('𠮷'.repeat(1000))");
    assert.equal(ttsTexts.at(-1), '𠮷'.repeat(1000));
    await evaluate("(async()=>{setPreview('あ'.repeat(1001));notices.length=0;await reader.playSentence(0);})()");
    assert.match(await evaluate('notices.at(-1)'), /超过 1000 字/);
    assert.equal(await evaluate('reader.isLoading || reader.isPlaying'), false);
    console.log('PASS overlong text is rejected without truncation or network requests; Unicode limits count code points');

    await evaluate(`(async()=>{popover.close();setPreview('第一句。第二句。第三句。');
      reader.prefetchSentence=()=>{};
      window.realSynthesize=reader.synthesizeSentenceBlob.bind(reader);
      window.firstAudio=await realSynthesize('第一句。');
      reader.synthesizeSentenceBlob=text=>text==='第二句。'?new Promise(resolve=>{window.finishSecond=()=>resolve(firstAudio);}):realSynthesize(text);
      await reader.playSentence(0);})()`);
    assert.equal(await evaluate('reader.audio.paused'), false);
    await evaluate('window.secondPlayback=reader.playSentence(1);void 0');
    assert.equal(await evaluate('reader.isLoading && reader.audio.paused'), true);
    await evaluate("reader.audio.dispatchEvent(new Event('ended'))");
    assert.equal(await evaluate('reader.activeIndex'), 1);
    await evaluate('(async()=>{finishSecond();await secondPlayback;})()');
    assert.equal(await evaluate('reader.audioSentenceIndex'), 1);
    assert.equal(await evaluate('reader.audio.paused'), false);
    await evaluate('reader.pause();reader.dispose();vocabView.dispose();popover.dispose();quickSpeaker.dispose()');
    assert.deepEqual(exceptions, []);
    console.log('PASS switching sentences pauses old audio and ignores its stale ended event during synthesis');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
