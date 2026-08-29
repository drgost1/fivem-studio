import { useCallback, useEffect, useMemo, useRef } from "react";
import Editor, { useMonaco } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor";

import "../monacoSetup";
import { notifyLuaDocumentSaved, useLuaLanguageService, type LuaServiceStatus } from "../luaLanguageService";
import type { OpenFile } from "../App";
import type { EditorPreferences, EditorProblem } from "../global";

interface CodeEditorProps {
  file: OpenFile;
  openPaths: string[];
  language: string;
  preferences: EditorPreferences;
  luaActive: boolean;
  reveal: { path: string; line: number; column: number; nonce: number } | null;
  onChange: (path: string, content: string) => void;
  onSave: (path: string, content: string, expectedRevision: string) => Promise<void>;
  onSelectionChange: (selectedText: string, startLine: number, endLine: number) => void;
  onProblemsChange: (path: string, problems: EditorProblem[]) => void;
  onOpenLocation: (path: string, line: number, column: number) => void;
  onLuaStatusChange: (status: LuaServiceStatus, message?: string) => void;
}

function severityName(severity: number): EditorProblem["severity"] {
  // Monaco's marker severities are bit flags ordered Hint=1 through Error=8.
  if (severity >= 8) return "error";
  if (severity >= 4) return "warning";
  if (severity >= 2) return "info";
  return "hint";
}

export default function CodeEditor({
  file,
  openPaths,
  language,
  preferences,
  luaActive,
  reveal,
  onChange,
  onSave,
  onSelectionChange,
  onProblemsChange,
  onOpenLocation,
  onLuaStatusChange,
}: CodeEditorProps) {
  const monacoInstance = useMonaco();
  const luaStatus = useLuaLanguageService(luaActive, preferences.luaIntelligence);
  const fileRef = useRef(file);
  const onSaveRef = useRef(onSave);
  const onChangeRef = useRef(onChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onProblemsChangeRef = useRef(onProblemsChange);
  const onOpenLocationRef = useRef(onOpenLocation);
  const preferencesRef = useRef(preferences);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const editorDisposablesRef = useRef<monaco.IDisposable[]>([]);
  const trackedPathsRef = useRef(new Set<string>());
  fileRef.current = file;
  onSaveRef.current = onSave;
  onChangeRef.current = onChange;
  onSelectionChangeRef.current = onSelectionChange;
  onProblemsChangeRef.current = onProblemsChange;
  onOpenLocationRef.current = onOpenLocation;
  preferencesRef.current = preferences;

  const handleChange = useCallback((value: string | undefined) => {
    onChangeRef.current(fileRef.current.path, value ?? "");
  }, []);

  const publishProblems = useCallback((path: string) => {
    if (!monacoInstance) return;
    const model = monacoInstance.editor.getModel(monaco.Uri.file(path));
    if (!model) return;
    const markers = monacoInstance.editor.getModelMarkers({ resource: model.uri });
    onProblemsChangeRef.current(path, markers.map((marker) => ({
      path,
      severity: severityName(marker.severity),
      message: marker.message,
      line: marker.startLineNumber,
      column: marker.startColumn,
      endLine: marker.endLineNumber,
      endColumn: marker.endColumn,
      source: marker.source,
      code: marker.code === undefined ? undefined : String(marker.code),
    })));
  }, [monacoInstance]);

  const options = useMemo(() => ({
    minimap: { enabled: preferences.minimap },
    fontSize: preferences.fontSize,
    wordWrap: preferences.wordWrap ? "on" as const : "off" as const,
    stickyScroll: { enabled: preferences.stickyScroll },
    automaticLayout: true,
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true },
    renderWhitespace: "selection" as const,
    smoothScrolling: true,
  }), [preferences]);
  const editorPath = useMemo(() => monaco.Uri.file(file.path).toString(true), [file.path]);

  useEffect(() => {
    onLuaStatusChange(luaStatus.state, luaStatus.message);
  }, [luaStatus, onLuaStatusChange]);

  // @monaco-editor/react can keep one model per path, which preserves undo,
  // cursor, folds, and language-service state while switching tabs. Dispose a
  // model as soon as its tab closes so large workspaces do not accumulate RAM.
  useEffect(() => {
    if (!monacoInstance) return;
    const current = new Set(openPaths);
    for (const previous of trackedPathsRef.current) {
      if (!current.has(previous)) monacoInstance.editor.getModel(monacoInstance.Uri.file(previous))?.dispose();
    }
    trackedPathsRef.current = current;
  }, [monacoInstance, openPaths]);

  useEffect(() => {
    if (!monacoInstance) return;
    for (const path of openPaths) publishProblems(path);
    const disposable = monacoInstance.editor.onDidChangeMarkers((resources) => {
      const changed = new Set(resources.map((resource) => resource.toString(true).toLowerCase()));
      for (const path of trackedPathsRef.current) {
        if (changed.has(monacoInstance.Uri.file(path).toString(true).toLowerCase())) publishProblems(path);
      }
    });
    return () => disposable.dispose();
  }, [monacoInstance, openPaths, publishProblems]);

  useEffect(() => {
    return () => {
      for (const disposable of editorDisposablesRef.current) disposable.dispose();
      if (!monacoInstance) return;
      for (const path of trackedPathsRef.current) {
        monacoInstance.editor.getModel(monacoInstance.Uri.file(path))?.dispose();
      }
    };
  }, [monacoInstance]);

  useEffect(() => {
    if (!reveal || reveal.path !== file.path || !editorRef.current) return;
    const editor = editorRef.current;
    requestAnimationFrame(() => {
      editor.setPosition({ lineNumber: reveal.line, column: reveal.column });
      editor.revealPositionInCenter({ lineNumber: reveal.line, column: reveal.column });
      editor.focus();
    });
  }, [file.path, reveal]);

  return (
    <Editor
      path={editorPath}
      language={language}
      value={file.content}
      theme="vs-dark"
      keepCurrentModel
      onChange={handleChange}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          void (async () => {
            if (preferencesRef.current.formatOnSave) {
              const format = editor.getAction("editor.action.formatDocument");
              if (format?.isSupported()) await format.run();
            }
            const current = fileRef.current;
            await onSaveRef.current(current.path, editor.getValue(), current.revision);
            notifyLuaDocumentSaved(editor.getModel());
          })().catch(() => {
            // App owns the visible error banner; avoid an unhandled command promise.
          });
        });

        editorDisposablesRef.current.push(editor.onDidChangeCursorSelection((event) => {
          const selected = editor.getModel()?.getValueInRange(event.selection) ?? "";
          onSelectionChangeRef.current(selected, event.selection.startLineNumber, event.selection.endLineNumber);
        }));
        editorDisposablesRef.current.push(monaco.editor.registerEditorOpener({
          openCodeEditor(
            _source: monaco.editor.ICodeEditor,
            resource: monaco.Uri,
            selectionOrPosition?: monaco.IRange | monaco.IPosition,
          ) {
            if (resource.scheme !== "file") return false;
            const line = selectionOrPosition && "startLineNumber" in selectionOrPosition
              ? selectionOrPosition.startLineNumber
              : selectionOrPosition?.lineNumber ?? 1;
            const column = selectionOrPosition && "startColumn" in selectionOrPosition
              ? selectionOrPosition.startColumn
              : selectionOrPosition?.column ?? 1;
            onOpenLocationRef.current(resource.fsPath, line, column);
            return true;
          },
        }));
      }}
      options={options}
    />
  );
}
