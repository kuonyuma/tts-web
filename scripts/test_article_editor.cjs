// Exercise a real browser editor and DOM; fixtures never call TTS/AI providers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { launchBrowser } = require('./browser_test_helper.cjs');
const root = path.resolve(__dirname, '../frontend');
const initial = '# Title\n\n**bold** *italic* `code`\n\nplain';
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'nonce-editor-test'; style-src-attr 'unsafe-inline'; connect-src 'self'");
  if (pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta name="codemirror-style-nonce" content="editor-test"><link rel="stylesheet" href="/articles.css"><link rel="stylesheet" href="/article-markdown-theme.css"><div id="editor" class="article-code-editor" style="height:300px;width:380px"></div><script type="module" src="/fixture.js"></script>');
    return;
  }
  if (pathname === '/fixture.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(`import {ArticleEditor} from '/article-editor.js';
      import {EditorSelection} from '/vendor/codemirror.js';
      window.EditorSelection=EditorSelection;
      window.changes=[]; window.violations=[];
      document.addEventListener('securitypolicyviolation',event=>violations.push(event.violatedDirective));
      window.editor=new ArticleEditor(document.getElementById('editor'), {
        content:${JSON.stringify(initial)},
        onInput:(content,composing)=>changes.push({content,composing}), onSelection:()=>{}
      });
      window.ready=true;
    `);
    return;
  }
  const file = path.resolve(root, pathname.slice(1));
  if (file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.setHeader('Content-Type', path.extname(file) === '.css' ? 'text/css' : 'text/javascript');
    res.end(fs.readFileSync(file));
  } else { res.writeHead(404); res.end(); }
});
let browser;
(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await launchBrowser({ profilePrefix: 'tts-editor-', exceptionDescriptions: true });
    const { send, evaluate, wait, exceptions } = browser;
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await wait('window.ready');
    assert.equal(await evaluate("!!document.querySelector('#editor .cm-editor')"), true,
      'Live Preview must keep a continuous CodeMirror document, not a paragraph textarea');
    await evaluate('window.contentDOM=editor.view.contentDOM; editor.focus();');
    assert.equal(await evaluate('editor.content'), initial);
    assert.equal(await evaluate('getComputedStyle(editor.scrollDOM).overflowY'), 'auto');
    await evaluate('editor.setMode("live"); editor.setMode("edit");');
    assert.equal(await evaluate('editor.view.contentDOM===window.contentDOM'), true);
    assert.equal(await evaluate('editor.content'), initial);
    await evaluate('editor.view.dispatch({selection:{anchor:editor.view.state.doc.length}});');
    const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
    };
    await key('Enter', 'Enter', 13); await key('Enter', 'Enter', 13);
    await send('Input.insertText', { text: '新段落\n多行 paste' });
    assert.equal(await evaluate('editor.content'), initial + '\n\n新段落\n多行 paste');
    assert.equal(await evaluate('editor.view.contentDOM===window.contentDOM'), true);
    await evaluate('editor.setMode("live");editor.focus();');
    await key('z', 'KeyZ', 90, 2);
    // CodeMirror groups the second Enter with following typing; the first Enter is separate.
    assert.equal(await evaluate('editor.content'), initial + '\n');
    await key('z', 'KeyZ', 90, 2);
    assert.equal(await evaluate('editor.content'), initial);
    await key('y', 'KeyY', 89, 2);
    await key('y', 'KeyY', 89, 2);
    assert.equal(await evaluate('editor.content'), initial + '\n\n新段落\n多行 paste');
    await key('z', 'KeyZ', 90, 2); await key('Z', 'KeyZ', 90, 10);
    assert.equal(await evaluate('editor.content'), initial + '\n\n新段落\n多行 paste');
    await evaluate('editor.view.dispatch({selection:{anchor:9,head:17}});');
    assert.equal(await evaluate('editor.selectedText()'), '**bold**');
    assert.deepEqual(await evaluate('violations'), []);
    console.log('PASS continuous document, shared source/live history, Enter, multiline input, source selection and strict CSP');

    await evaluate(`editor.setContent(${JSON.stringify(initial)});editor.setMode('live');editor.view.dispatch({selection:{anchor:editor.view.state.doc.length}});editor.focus();`);
    await wait('document.querySelector(".cm-content").textContent.includes("plain")');
    assert.equal(await evaluate('editor.view.contentDOM.textContent'), 'Titlebold italic codeplain',
      'Inactive delimiters must disappear without changing the Markdown document');
    const visible = () => evaluate('editor.view.contentDOM.textContent');
    const cursor = async (anchor, head = anchor) => evaluate(`editor.view.dispatch({selection:{anchor:${anchor},head:${head}}});editor.focus();`);
    for (const [pos, expected] of [
      [12, 'Title**bold** italic codeplain'], [21, 'Titlebold *italic* codeplain'],
      [29, 'Titlebold italic `code`plain'], [9, 'Title**bold** italic codeplain'],
      [17, 'Title**bold** italic codeplain'],
    ]) {
      await cursor(pos); assert.equal(await visible(), expected);
      assert.equal(await evaluate('editor.content'), initial);
    }
    await cursor(9, 26);
    assert.equal(await visible(), 'Title**bold** *italic* codeplain');
    await evaluate('editor.view.dispatch({selection:EditorSelection.create([EditorSelection.cursor(12),EditorSelection.cursor(29)])});');
    assert.equal(await visible(), 'Title**bold** italic `code`plain');
    await cursor(36);
    const headingSize = await evaluate('getComputedStyle(document.querySelector(".cm-md-h1")).fontSize');
    await cursor(3);
    assert.equal(await visible(), '# Titlebold italic codeplain');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".cm-md-h1")).fontSize'), headingSize);
    const setDoc = async text => {
      await evaluate(`editor.setContent(${JSON.stringify(text)});editor.view.dispatch({selection:{anchor:editor.view.state.doc.length}});editor.focus();`);
    };
    for (let level = 1; level <= 6; level++) {
      const source = '#'.repeat(level) + ' Heading\n\nplain';
      await setDoc(source); assert.equal(await visible(), 'Headingplain');
      await cursor(level + 2); assert.equal(await visible(), '#'.repeat(level) + ' Headingplain');
      assert.equal(await evaluate('editor.content'), source);
    }
    await setDoc('__bold__ _italic_ ``a ` b``\n\nplain');
    assert.equal(await visible(), 'bold italic a ` bplain');
    await cursor(3); assert.equal(await visible(), '__bold__ italic a ` bplain');
    await setDoc('***both*** and *other*\n\nplain');
    await cursor(5); assert.equal(await visible(), '***both*** and otherplain');
    await setDoc('`**literal**` and \\*escaped\\*\n\nplain');
    assert.equal(await visible(), '**literal** and \\*escaped\\*plain');
    assert.equal(await evaluate('document.querySelectorAll(".cm-md-strong").length'), 0);
    console.log('PASS construct-level sibling isolation, both delimiters, nested syntax, all headings, selection intersections and source stability');

    await setDoc('[](https://example.com) ![](https://example.com/image.png) **B**\n\nplain');
    assert.equal(await visible(), '  Bplain', 'Empty labels must not disable the Live Preview plugin');
    await setDoc('[label](\nhttps://example.com\n)\n\nplain');
    assert.equal(await visible(), 'labelplain', 'Multiline destinations must hide text without replacing newline boundaries');

    await setDoc('[OpenAI](https://openai.com) and **B**\n\nplain');
    assert.equal(await visible(), 'OpenAI and Bplain');
    await cursor(3);
    assert.equal(await visible(), '[OpenAI](https://openai.com) and Bplain');
    await setDoc('> quote **B**\n> second\n\n- Apple\n- Banana\n\n1. A\n2. B\n\n---\n\nplain');
    assert.equal(await visible(), 'quote Bsecond• Apple• Banana1. A2. Bplain');
    await cursor(28);
    assert.equal(await visible(), 'quote Bsecond- Apple• Banana1. A2. Bplain');
    await cursor(10);
    assert.equal(await visible(), '> quote **B**second• Apple• Banana1. A2. Bplain');
    await cursor(54);
    assert.equal(await visible(), 'quote Bsecond• Apple• Banana1. A2. B---plain');
    assert.equal(await evaluate('document.querySelectorAll(".cm-md-rule").length'), 1);
    await setDoc('- Apple\n- Banana'); await cursor(7);
    await key('Enter', 'Enter', 13);
    assert.equal(await evaluate('editor.content'), '- Apple\n- \n- Banana');
    await key('Backspace', 'Backspace', 8);
    assert.equal(await evaluate('editor.content'), '- Apple\n  \n- Banana');
    console.log('PASS link source editing, quote lines, item-local bullets, ordered lists, rules and native list Enter/Backspace');

    const fenced = '```python\nprint("hello")\n```\n\nplain';
    await setDoc(fenced);
    assert.equal(await visible(), 'print("hello")plain');
    await cursor(14);
    assert.equal(await visible(), '```pythonprint("hello")```plain');
    assert.equal(await evaluate('editor.content'), fenced);
    await setDoc(('## Heading\n\n**text**\n\n').repeat(80));
    await evaluate('editor.view.dispatch({selection:{anchor:0}});editor.restoreAnchor({offset:0,top:0});editor.scrollDOM.scrollTop=200;window.userScrollAnchor=editor.anchor(false).offset;');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(await evaluate('editor.anchor(false).offset'), await evaluate('userScrollAnchor'),
      'A queued mode anchor must not undo a subsequent user scroll');
    for (const [source, addition, expected] of [
      ['**中文**\n\nplain', '测试', '**中文测试**\n\nplain'],
      ['**日本**\n\nplain', '語', '**日本語**\n\nplain'],
    ]) {
      await setDoc(source); await cursor(4);
      await evaluate('window.imeDOM=editor.view.contentDOM;changes.length=0;editor.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));');
      await send('Input.insertText', { text: addition });
      await evaluate('editor.view.contentDOM.dispatchEvent(new CompositionEvent("compositionupdate",{bubbles:true,data:"candidate"}));editor.setMode("edit");');
      assert.equal(await evaluate('editor.mode'), 'live');
      assert.equal(await evaluate('editor.content'), expected);
      assert.equal(await evaluate('editor.view.contentDOM===imeDOM&&document.activeElement===imeDOM'), true);
      assert.equal(await evaluate('changes.every(change=>change.composing)'), true);
      await evaluate('editor.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true}));');
      await wait('!editor.composing&&changes.at(-1)?.composing===false');
      assert.equal(await evaluate('changes.at(-1).content'), expected);
      assert.equal(await evaluate('editor.view.contentDOM===imeDOM'), true);
    }
    console.log('PASS Chinese/Japanese composition events preserve the mounted editor, focus, source and save deferral');
    await setDoc('plain'); await cursor(0);
    await evaluate('editor.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));');
    await send('Input.insertText', { text: '**新词** ' });
    await evaluate('editor.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true}));');
    await wait('!editor.composing');
    assert.equal(await evaluate('document.querySelector(".cm-md-strong")?.textContent'), '新词',
      'Composition completion must refresh newly parsed inactive constructs');
    await setDoc('**one**\n\n*two*\n\nplain');
    await cursor(0, 14);
    assert.equal(await evaluate('editor.selectedText()'), '**one**\n\n*two*');
    await evaluate('window.clipboardData=new DataTransfer();editor.view.contentDOM.dispatchEvent(new ClipboardEvent("copy",{bubbles:true,clipboardData:clipboardData}));');
    assert.equal(await evaluate('clipboardData.getData("text/plain")'), '**one**\n\n*two*');
    await evaluate('editor.view.contentDOM.dispatchEvent(new ClipboardEvent("cut",{bubbles:true,clipboardData:clipboardData}));');
    assert.equal(await evaluate('editor.content'), '\n\nplain');
    await key('z', 'KeyZ', 90, 2);
    assert.equal(await evaluate('editor.content'), '**one**\n\n*two*\n\nplain');
    await cursor(0);
    await evaluate('const pasted=new DataTransfer();pasted.setData("text/plain","# New\\n\\nmultiline\\n");editor.view.contentDOM.dispatchEvent(new ClipboardEvent("paste",{bubbles:true,clipboardData:pasted}));');
    assert.equal(await evaluate('editor.content'), '# New\n\nmultiline\n**one**\n\n*two*\n\nplain');
    await key('a', 'KeyA', 65, 2);
    assert.equal(await evaluate('editor.selectedText()'), '# New\n\nmultiline\n**one**\n\n*two*\n\nplain');
    const mixed = '# 😀标题\r\n\r\n__原文__\n\nplain';
    await setDoc(mixed); await cursor(mixed.length);
    await send('Input.insertText', { text: '!' });
    assert.equal(await evaluate('editor.content'), mixed + '!');
    await cursor(0, 7);
    assert.equal(await evaluate('editor.selectedText()'), '# 😀标题\r');
    console.log('PASS cross-paragraph source copy/cut/paste, Ctrl+A and mixed CRLF/LF with non-BMP offsets');
    for (const mode of ['live', 'edit']) {
      await setDoc('a\r\nb'); await evaluate(`editor.setMode('${mode}');`); await cursor(3);
      await key('Backspace', 'Backspace', 8);
      assert.equal(await evaluate('editor.content'), 'ab', 'Backspace must join a CRLF line atomically');
      await key('z', 'KeyZ', 90, 2); assert.equal(await evaluate('editor.content'), 'a\r\nb');
      await cursor(1); await key('Delete', 'Delete', 46);
      assert.equal(await evaluate('editor.content'), 'ab', 'Delete must join a CRLF line atomically');
      await setDoc('a\r\nb'); await cursor(1);
      await key('ArrowRight', 'ArrowRight', 39);
      assert.equal(await evaluate('editor.view.state.selection.main.head'), 3, 'Right arrow must cross the complete CRLF');
      await key('ArrowLeft', 'ArrowLeft', 37);
      assert.equal(await evaluate('editor.view.state.selection.main.head'), 1);
      await cursor(0); await key('End', 'End', 35);
      assert.equal(await evaluate('editor.view.state.selection.main.head'), 1, 'End must stop before the atomic CRLF');
      await send('Input.insertText', { text: 'X' });
      assert.equal(await evaluate('editor.content'), 'aX\r\nb');
    }
    await evaluate('editor.setMode("live");');
    const long = '**text**\n\n'.repeat(50000);
    await setDoc(long);
    await cursor(0);
    await evaluate('editor.restoreScroll(0)');
    await wait('editor.scrollDOM.scrollTop===0');
    assert((await evaluate('editor.view.contentDOM.querySelectorAll(".cm-line").length')) < 300,
      'Long documents must keep a viewport-sized DOM');
    assert.equal(await evaluate('editor.view.state.doc.length'), 500000);
    assert.deepEqual(await evaluate('violations'), []);
    console.log('PASS 500,000-character document uses bounded viewport DOM');
    assert.deepEqual(exceptions, []);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
