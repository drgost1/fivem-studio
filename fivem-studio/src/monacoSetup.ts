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
