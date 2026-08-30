// Configure @monaco-editor/react to use the locally bundled monaco-editor package
// instead of its default behaviour of fetching Monaco from a CDN at runtime.
// This app must work fully offline (no internet access on the user's Cfx.re box),
// so pulling Monaco from jsdelivr is not acceptable — it would just hang on
// "Loading..." forever with no network.
import * as monaco from "monaco-editor/editor";
import { loader } from "@monaco-editor/react";

// Monaco 0.56 exposes supported, tree-shakeable entry points. Keep the
// productivity/accessibility features Studio uses without registering every
// editor contribution and every language in the package.
import "monaco-editor/features/bracketMatching/register";
import "monaco-editor/features/clipboard/register";
import "monaco-editor/features/codeAction/register";
import "monaco-editor/features/codeEditor/register";
import "monaco-editor/features/codicon/register";
import "monaco-editor/features/comment/register";
import "monaco-editor/features/contextmenu/register";
import "monaco-editor/features/cursorUndo/register";
import "monaco-editor/features/diffEditor/register";
import "monaco-editor/features/documentSymbols/register";
import "monaco-editor/features/find/register";
import "monaco-editor/features/folding/register";
import "monaco-editor/features/format/register";
import "monaco-editor/features/gotoError/register";
import "monaco-editor/features/gotoLine/register";
import "monaco-editor/features/gotoSymbol/register";
import "monaco-editor/features/hover/register";
import "monaco-editor/features/indentation/register";
import "monaco-editor/features/inlayHints/register";
import "monaco-editor/features/lineSelection/register";
import "monaco-editor/features/linesOperations/register";
import "monaco-editor/features/links/register";
import "monaco-editor/features/multicursor/register";
import "monaco-editor/features/parameterHints/register";
import "monaco-editor/features/quickCommand/register";
import "monaco-editor/features/quickHelp/register";
import "monaco-editor/features/quickOutline/register";
import "monaco-editor/features/referenceSearch/register";
import "monaco-editor/features/rename/register";
import "monaco-editor/features/semanticTokens/register";
import "monaco-editor/features/smartSelect/register";
import "monaco-editor/features/snippet/register";
import "monaco-editor/features/stickyScroll/register";
import "monaco-editor/features/suggest/register";
// Monaco 0.56's narrow suggest feature entry point registers inline
// completions only. The controller owns the familiar completion popup,
// trigger-character handling, and Ctrl+Space command.
import "monaco-editor/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/features/tokenization/register";
import "monaco-editor/features/toggleHighContrast/register";
import "monaco-editor/features/unicodeHighlighter/register";
import "monaco-editor/features/unusualLineTerminators/register";
import "monaco-editor/features/wordHighlighter/register";
import "monaco-editor/features/wordOperations/register";
import "monaco-editor/features/wordPartOperations/register";

// Import only the languages Studio actually assigns in CenterPane.
import "monaco-editor/languages/definitions/ini/register";
import "monaco-editor/languages/definitions/lua/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/sql/register";
import "monaco-editor/languages/definitions/xml/register";
import "monaco-editor/languages/definitions/yaml/register";
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/languages/definitions/html/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/features/css/register";
import "monaco-editor/languages/features/html/register";
import "monaco-editor/languages/features/json/register";
import "monaco-editor/languages/features/typescript/register";

import editorWorker from "monaco-editor/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/languages/features/json/json.worker?worker";
import cssWorker from "monaco-editor/languages/features/css/css.worker?worker";
import htmlWorker from "monaco-editor/languages/features/html/html.worker?worker";
import tsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

loader.config({ monaco });

function tokenRules(colors: {
  comment: string;
  keyword: string;
  string: string;
  number: string;
  function: string;
  global: string;
  property: string;
  variable: string;
  operator: string;
}): monaco.editor.ITokenThemeRule[] {
  return [
    { token: "comment", foreground: colors.comment },
    { token: "keyword", foreground: colors.keyword },
    { token: "string", foreground: colors.string },
    { token: "number", foreground: colors.number },
    { token: "function", foreground: colors.function },
    { token: "function.declaration", foreground: colors.function },
    { token: "method", foreground: colors.function },
    { token: "variable.global", foreground: colors.global },
    { token: "variable.defaultLibrary", foreground: colors.global },
    { token: "property", foreground: colors.property },
    { token: "variable", foreground: colors.variable },
    { token: "parameter", foreground: colors.variable },
    { token: "identifier", foreground: colors.variable },
    { token: "operator", foreground: colors.operator },
    { token: "delimiter", foreground: colors.operator },
  ];
}

monaco.editor.defineTheme("qb-studio-dark", {
  base: "vs-dark",
  inherit: true,
  rules: tokenRules({
    comment: "6B7A87",
    keyword: "C48FD6",
    string: "96C97C",
    number: "E0A667",
    function: "62AEE8",
    global: "4FC0B0",
    property: "DCC98A",
    variable: "D5DDE4",
    operator: "8A96A2",
  }),
  colors: {
    "editor.background": "#101317",
    "editor.foreground": "#D5DDE4",
    "editorLineNumber.foreground": "#6F7B87",
    "editorLineNumber.activeForeground": "#A3AEB9",
    "editor.lineHighlightBackground": "#14181D",
    "editor.selectionBackground": "#264E73",
    "editor.inactiveSelectionBackground": "#1C3A55",
    "editorCursor.foreground": "#E4E9EE",
    "editorWhitespace.foreground": "#333C46",
    "editorIndentGuide.background1": "#262D35",
    "editorIndentGuide.activeBackground1": "#4C9EE8",
    "editorWidget.background": "#191E24",
    "editorWidget.border": "#333C46",
    "editorSuggestWidget.selectedBackground": "#16293A",
    "diffEditor.insertedTextBackground": "#3E7D5F66",
    "diffEditor.removedTextBackground": "#94443E66",
    "diffEditor.insertedLineBackground": "#5CB88A26",
    "diffEditor.removedLineBackground": "#E56E6326",
  },
});

monaco.editor.defineTheme("qb-studio-light", {
  base: "vs",
  inherit: true,
  rules: tokenRules({
    comment: "7A8590",
    keyword: "8B3FA8",
    string: "2F7A3E",
    number: "A65B18",
    function: "1F6FB8",
    global: "0E7B71",
    property: "7A5F16",
    variable: "2A3138",
    operator: "6B7681",
  }),
  colors: {
    "editor.background": "#FFFFFF",
    "editor.foreground": "#2A3138",
    "editorLineNumber.foreground": "#868E97",
    "editorLineNumber.activeForeground": "#565E67",
    "editor.lineHighlightBackground": "#F7F5F2",
    "editor.selectionBackground": "#B7D5EF",
    "editor.inactiveSelectionBackground": "#DCEAF5",
    "editorCursor.foreground": "#1E2227",
    "editorWhitespace.foreground": "#C9C5BC",
    "editorIndentGuide.background1": "#E1DED7",
    "editorIndentGuide.activeBackground1": "#1F6FB8",
    "editorWidget.background": "#FCFBF9",
    "editorWidget.border": "#C9C5BC",
    "editorSuggestWidget.selectedBackground": "#E3EEF8",
    "diffEditor.insertedTextBackground": "#74AE9066",
    "diffEditor.removedTextBackground": "#D8918966",
    "diffEditor.insertedLineBackground": "#2E7D5518",
    "diffEditor.removedLineBackground": "#B33F3518",
  },
});

monaco.editor.defineTheme("qb-studio-high-contrast", {
  base: "hc-black",
  inherit: true,
  rules: tokenRules({
    comment: "B9C8D4",
    keyword: "FF9CFF",
    string: "B7FF9A",
    number: "FFD08A",
    function: "72D3FF",
    global: "64FFE3",
    property: "FFF08A",
    variable: "FFFFFF",
    operator: "D7E2EA",
  }),
  colors: {
    "editor.background": "#000000",
    "editor.foreground": "#FFFFFF",
    "editorLineNumber.foreground": "#C8C8C8",
    "editorLineNumber.activeForeground": "#FFFFFF",
    "editor.lineHighlightBackground": "#121212",
    "editor.selectionBackground": "#005A9E",
    "editor.inactiveSelectionBackground": "#003B68",
    "editorCursor.foreground": "#FFFFFF",
    "editorWhitespace.foreground": "#808080",
    "editorIndentGuide.background1": "#666666",
    "editorIndentGuide.activeBackground1": "#00B7FF",
    "editorWidget.background": "#000000",
    "editorWidget.border": "#FFFFFF",
    "editorSuggestWidget.selectedBackground": "#003B68",
    "diffEditor.insertedTextBackground": "#006B3C99",
    "diffEditor.removedTextBackground": "#8B1A1A99",
    "diffEditor.insertedLineBackground": "#004D2B80",
    "diffEditor.removedLineBackground": "#68131380",
  },
});
