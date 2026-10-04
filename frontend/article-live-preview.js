import { syntaxTree, Decoration, ViewPlugin, WidgetType, StateEffect } from './vendor/codemirror.js';

export const refreshLivePreview = StateEffect.define();

class MarkerWidget extends WidgetType {
  constructor(text, className) { super(); Object.assign(this, { text, className }); }
  eq(other) { return this.text === other.text && this.className === other.className; }
  toDOM() {
    const span = document.createElement('span');
    span.className = this.className; span.textContent = this.text;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
  ignoreEvent() { return false; }
}

/** Selection coordinates are always UTF-16 Markdown document offsets. */
function active(view, from, to) {
  return view.state.selection.ranges.some(range => range.empty
    ? view.hasFocus && range.from >= from && range.from <= to
    : range.from < to && range.to > from);
}

function decorations(view) {
  const result = [], seen = new Set(), lines = new Map();
  const { doc } = view.state;
  const styleLine = (position, name) => {
    const from = doc.lineAt(position).from;
    if (!lines.has(from)) lines.set(from, new Set());
    lines.get(from).add(name);
  };
  const hide = (from, to) => {
    for (const visible of view.visibleRanges) {
      let position = Math.max(from, visible.from), end = Math.min(to, visible.to);
      while (position < end) {
        const line = doc.lineAt(position), until = Math.min(line.to, end);
        if (position < until) result.push(Decoration.replace({}).range(position, until));
        position = line.to + 1;
      }
    }
  };
  for (const range of view.visibleRanges) {
    syntaxTree(view.state).iterate({ from: range.from, to: range.to, enter(ref) {
      const { name, from, to, node } = ref;
      const key = `${name}:${from}:${to}`;
      if (seen.has(key)) return;
      seen.add(key);
      const isActive = active(view, from, to);
      const inlineClass = { StrongEmphasis: 'cm-md-strong', Emphasis: 'cm-md-emphasis', InlineCode: 'cm-md-inline-code' }[name];
      if (inlineClass) {
        result.push(Decoration.mark({ class: inlineClass }).range(from, to));
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name !== 'EmphasisMark' && child.name !== 'CodeMark') continue;
          if (!isActive) hide(child.from, child.to);
          else result.push(Decoration.mark({ class: 'cm-md-marker' }).range(child.from, child.to));
        }
      } else if (name.startsWith('ATXHeading')) {
        styleLine(from, 'cm-md-heading cm-md-h' + name.slice(-1));
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.name !== 'HeaderMark') continue;
          if (isActive) result.push(Decoration.mark({ class: 'cm-md-marker' }).range(child.from, child.to));
          else {
            let end = child.to;
            if (child.from === from && doc.sliceString(end, end + 1) === ' ') end++;
            hide(child.from, end);
          }
        }
      } else if (name === 'Link' || name === 'Image') {
        // Only hide destinations actually recognized by Lezer; unknown/reference syntax stays editable.
        const marks = node.getChildren('LinkMark');
        const close = marks.find(mark => doc.sliceString(mark.from, mark.to) === ']');
        if (close && node.getChild('URL')) {
          const labelFrom = marks[0].to;
          if (labelFrom < close.from) result.push(Decoration.mark({ class: 'cm-md-link' }).range(labelFrom, close.from));
          if (!isActive) { hide(from, labelFrom); hide(close.from, to); }
        }
      } else if (name === 'QuoteMark') {
        const line = doc.lineAt(from);
        styleLine(from, 'cm-md-quote');
        if (!active(view, line.from, line.to)) hide(from, to + (doc.sliceString(to, to + 1) === ' ' ? 1 : 0));
      } else if (name === 'ListMark') {
        styleLine(from, 'cm-md-list');
        const item = node.parent;
        if (!active(view, item.from, item.to)) {
          const text = item.parent.name === 'OrderedList' ? doc.sliceString(from, to - 1) + '.' : '•';
          result.push(Decoration.replace({ widget: new MarkerWidget(text, 'cm-md-list-marker') }).range(from, to));
        }
      } else if (name === 'HorizontalRule') {
        styleLine(from, 'cm-md-rule');
        if (!isActive) result.push(Decoration.replace({ widget: new MarkerWidget('', 'cm-md-rule-line') }).range(from, to));
      } else if (name === 'FencedCode' || name === 'CodeBlock') {
        // Keep every source line in the editor; viewport plugins cannot replace line breaks.
        const first = doc.lineAt(Math.max(from, range.from));
        const last = doc.lineAt(Math.min(to, range.to));
        for (let number = first.number; number <= last.number; number++) styleLine(doc.line(number).from, 'cm-md-code-block');
        if (name === 'FencedCode' && !isActive) {
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.name === 'CodeMark' || child.name === 'CodeInfo') hide(child.from, child.to);
          }
        }
        return false;
      }
    } });
  }
  for (const [from, classes] of lines) result.push(Decoration.line({ class: [...classes].join(' ') }).range(from));
  return Decoration.set(result, true);
}

// Viewport-local decorations never remove line breaks or replace paragraph DOM.
export const livePreview = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = decorations(view); }
  update(update) {
    if (update.view.compositionStarted) {
      if (update.docChanged) this.decorations = this.decorations.map(update.changes);
      return;
    }
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged
      || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(refreshLivePreview)))
      || syntaxTree(update.state) !== syntaxTree(update.startState)) this.decorations = decorations(update.view);
  }
}, { decorations: plugin => plugin.decorations });
