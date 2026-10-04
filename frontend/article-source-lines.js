import { Decoration, EditorView, ViewPlugin, EditorState, EditorSelection } from './vendor/codemirror.js';

/** Preserve original source offsets/bytes while treating CRLF as one native line break. */
const crlfRanges = ViewPlugin.fromClass(class {
  constructor(view) { this.build(view); }
  build(view) {
    const { doc } = view.state, breaks = new Set();
    const addLine = line => {
      if (line.to < doc.length && line.text.endsWith('\r')) breaks.add(line.to - 1);
    };
    for (const range of view.visibleRanges) {
      const first = doc.lineAt(range.from).number, last = doc.lineAt(range.to).number;
      for (let number = first; number <= last; number++) addLine(doc.line(number));
    }
    // Programmatic selections can temporarily be outside the rendered viewport.
    for (const range of view.state.selection.ranges) {
      for (const position of [range.from, range.to]) {
        const line = doc.lineAt(position);
        addLine(line);
        if (line.number > 1) addLine(doc.line(line.number - 1));
      }
    }
    this.decorations = Decoration.set([...breaks].map(from => Decoration.replace({}).range(from, from + 1)), true);
    this.atoms = Decoration.set([...breaks].map(from => Decoration.mark({}).range(from, from + 2)), true);
  }
  update(update) {
    if (update.docChanged || update.viewportChanged || update.selectionSet) this.build(update.view);
  }
}, {
  decorations: plugin => plugin.decorations,
  provide: plugin => EditorView.atomicRanges.of(view => view.plugin(plugin)?.atoms || Decoration.none),
});

// Line-boundary/mouse commands may choose the hidden position between CR and LF.
// Normalize native selections only; explicit source ranges retain their exact offsets.
export const sourceLines = [crlfRanges, EditorState.transactionFilter.of(transaction => {
  if (!transaction.selection || !transaction.isUserEvent('select')) return transaction;
  const doc = transaction.newDoc;
  const normalize = position => position > 0 && position < doc.length
    && doc.sliceString(position - 1, position + 1) === '\r\n' ? position - 1 : position;
  const ranges = transaction.newSelection.ranges.map(range => EditorSelection.range(normalize(range.anchor), normalize(range.head)));
  const selection = EditorSelection.create(ranges, transaction.newSelection.mainIndex);
  return selection.eq(transaction.newSelection) ? transaction : [transaction, { selection, sequential: true }];
})];
