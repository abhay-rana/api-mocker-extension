// CodeMirror 6 bundle entry — exposes everything panel.js needs via window.CM

export {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  placeholder,
} from '@codemirror/view';

export { EditorState } from '@codemirror/state';

export { json } from '@codemirror/lang-json';

export {
  foldGutter,
  foldKeymap,
  bracketMatching,
  syntaxHighlighting,
  HighlightStyle,
  foldAll,
  unfoldAll,
} from '@codemirror/language';

export {
  history,
  historyKeymap,
  defaultKeymap,
} from '@codemirror/commands';

export { search, searchKeymap, openSearchPanel } from '@codemirror/search';

export {
  closeBrackets,
  closeBracketsKeymap,
} from '@codemirror/autocomplete';

export { tags } from '@lezer/highlight';
