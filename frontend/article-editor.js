import { EditorState, EditorSelection, Compartment, Transaction, Text, EditorView,
  keymap, placeholder, history, historyKeymap, defaultKeymap, indentWithTab, redo,
  markdown, markdownLanguage } from './vendor/codemirror.js';
import { livePreview, refreshLivePreview } from './article-live-preview.js';
import { sourceLines } from './article-source-lines.js';

/** One persistent Markdown document. State/API/TTS ownership stays with ArticleViews. */
export class ArticleEditor {
  constructor(parent, { content = '', selection = null, onInput = () => {},
    onSelection = () => {}, onScroll = () => {} } = {}) {
    Object.assign(this, { parent, onInput, onSelection, onScroll });
    this.mode = 'edit';
    parent.dataset.editorMode = 'edit';
    this.preview = new Compartment();
    this.editable = new Compartment();
    this.notifiedContent = content;
    this.composing = false;
    this.view = new EditorView({ parent, state: EditorState.create({
      // Explicit LF splitting preserves CR characters and original mixed CRLF/LF source offsets.
      doc: Text.of(content.split('\n')),
      selection: this.clampSelection(selection, content.length),
      extensions: [
        EditorState.lineSeparator.of('\n'), EditorState.allowMultipleSelections.of(true),
        markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
        history(), keymap.of([{ key: 'Mod-Shift-z', run: redo }, ...historyKeymap, ...defaultKeymap, indentWithTab]),
        EditorView.lineWrapping, sourceLines, placeholder('在这里写 Markdown…'),
        EditorView.contentAttributes.of({ 'aria-label': '文章 Markdown 正文', spellcheck: 'false' }),
        EditorView.cspNonce.of(document.querySelector('meta[name="codemirror-style-nonce"]')?.content || ''),
        this.preview.of([]), this.editable.of([]),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !this.applyingContent) {
            this.notifiedContent = update.state.doc.toString();
            this.onInput(this.notifiedContent, this.composing || update.view.composing);
          }
          if (update.selectionSet || update.docChanged) this.onSelection();
        }),
        EditorView.domEventHandlers({
          compositionstart: () => {
            this.composing = true;
            this.onInput(this.content, true);
          },
          compositionend: () => {
            // Let CodeMirror finish its DOM reconciliation before ending the save deferral.
            clearTimeout(this.compositionTimer);
            this.compositionTimer = setTimeout(() => this.finishComposition(), 0);
          },
        }),
      ],
    }) });
    this.scrollListener = () => this.onScroll();
    this.view.scrollDOM.addEventListener('scroll', this.scrollListener, { passive: true });
  }
  finishComposition() {
    if (this.disposed) return;
    clearTimeout(this.compositionTimer);
    this.composing = false;
    this.view.dispatch({ effects: refreshLivePreview.of(null) });
    this.notifiedContent = this.content;
    this.onInput(this.notifiedContent, false);
  }
  async finishInput() {
    if (this.disposed) return;
    this.view.contentDOM.blur();
    if (!this.composing) return;
    // Closing must let pending native composition/DOM changes reach the document
    // before disposal can cancel the compositionend callback and lock saving.
    await new Promise(resolve => setTimeout(resolve, 0));
    if (this.composing && !this.disposed) this.finishComposition();
  }
  clampSelection(value, length = this.view.state.doc.length) {
    const clamp = pos => Math.max(0, Math.min(length, Number(pos) || 0));
    const ranges = value?.ranges || [value || { anchor: 0, head: 0 }];
    return EditorSelection.create(ranges.map(range => EditorSelection.range(
      clamp(range.anchor ?? range.start), clamp(range.head ?? range.end))),
    Math.max(0, Math.min(ranges.length - 1, value?.mainIndex || 0)));
  }
  get content() { return this.view.state.doc.toString(); }
  get scrollDOM() { return this.view.scrollDOM; }
  get selection() {
    const selection = this.view.state.selection;
    return { ranges: selection.ranges.map(({ anchor, head }) => ({ anchor, head })), mainIndex: selection.mainIndex };
  }
  setContent(content) {
    // Save acknowledgements must not dispatch while the editor update callback is running.
    if (content === this.notifiedContent || this.composing || this.disposed) return;
    this.applyingContent = true;
    try {
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: Text.of(content.split('\n')) },
        annotations: Transaction.addToHistory.of(false) });
      this.notifiedContent = content;
    } finally { this.applyingContent = false; }
  }
  setMode(mode) {
    if (this.mode === mode || this.composing) return;
    this.mode = mode;
    this.parent.dataset.editorMode = mode;
    this.view.dispatch({ effects: this.preview.reconfigure(mode === 'live' ? livePreview : []) });
  }
  setDisabled(disabled) {
    if (this.disabled === !!disabled) return;
    this.disabled = !!disabled;
    this.view.dispatch({ effects: this.editable.reconfigure([
      EditorState.readOnly.of(this.disabled), EditorView.editable.of(!this.disabled),
    ]) });
  }
  selectedText() {
    return this.view.state.selection.ranges.filter(range => !range.empty)
      .map(({ from, to }) => this.view.state.doc.sliceString(from, to)).join('\n');
  }
  focus() { this.view.focus(); }
  anchor(preferCursor = true) {
    const { view } = this, viewport = view.scrollDOM.getBoundingClientRect();
    const head = view.state.selection.main.head;
    const caret = preferCursor ? view.coordsAtPos(head) : null;
    if (preferCursor && caret && caret.top >= viewport.top && caret.bottom <= viewport.bottom) {
      return { offset: head, top: caret.top - viewport.top };
    }
    const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
    return { offset: block.from, top: block.top - view.scrollDOM.scrollTop };
  }
  restoreAnchor(anchor) {
    if (!anchor) return;
    const expectedScroll = this.scrollDOM.scrollTop;
    this.view.requestMeasure({ key: this, read: view => view.lineBlockAt(Math.min(anchor.offset, view.state.doc.length)).top,
      write: top => {
        if (this.scrollDOM.scrollTop === expectedScroll) this.scrollDOM.scrollTop = Math.max(0, top - anchor.top);
      } });
  }
  restoreScroll(top, anchor = null) {
    this.restoring = true;
    const version = this.restoreVersion = (this.restoreVersion || 0) + 1;
    if (anchor) {
      this.view.dispatch({ effects: EditorView.scrollIntoView(Math.min(anchor.offset, this.view.state.doc.length),
        { y: 'start', yMargin: anchor.top }) });
    } else this.scrollDOM.scrollTop = top;
    // First let CodeMirror render/measure the target viewport. A line's text coordinates
    // differ from its block coordinates; align the saved block after that measurement.
    cancelAnimationFrame(this.restoreFrame);
    this.restoreFrame = requestAnimationFrame(() => {
      if (this.disposed) return;
      const expectedScroll = this.scrollDOM.scrollTop;
      this.view.requestMeasure({ key: this,
        read: view => anchor ? view.lineBlockAt(Math.min(anchor.offset, view.state.doc.length)).top - anchor.top : top,
        write: value => {
          const apply = this.scrollDOM.scrollTop === expectedScroll;
          // Finish after CodeMirror's own scroll correction, and outside its write
          // phase: position persistence reads layout and may trigger measurement.
          queueMicrotask(() => {
            if (this.disposed || this.restoreVersion !== version) return;
            if (apply) this.scrollDOM.scrollTop = Math.max(0, value);
            this.restoring = false;
            this.onScroll();
          });
        },
      });
    });
  }
  dispose() {
    this.disposed = true; clearTimeout(this.compositionTimer); cancelAnimationFrame(this.restoreFrame);
    this.scrollDOM.removeEventListener('scroll', this.scrollListener);
    this.view.destroy();
  }
}
