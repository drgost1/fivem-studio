import { useRef } from "react";
import Editor from "@monaco-editor/react";

import "../monacoSetup";
import type { OpenFile } from "../App";

interface CodeEditorProps {
  file: OpenFile;
  language: string;
  onChange: (path: string, content: string) => void;
  onSave: (path: string, content: string, expectedRevision: string) => Promise<void>;
  onSelectionChange: (selectedText: string, startLine: number, endLine: number) => void;
}

export default function CodeEditor({ file, language, onChange, onSave, onSelectionChange }: CodeEditorProps) {
  const fileRef = useRef(file);
  const onSaveRef = useRef(onSave);
  fileRef.current = file;
  onSaveRef.current = onSave;

  return (
    <Editor
      key={file.path}
      path={file.path}
      language={language}
      value={file.content}
      theme="vs-dark"
      onChange={(value) => onChange(file.path, value ?? "")}
      onMount={(editor, monaco) => {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          const current = fileRef.current;
          void onSaveRef.current(current.path, editor.getValue(), current.revision).catch(() => {
            // App owns the visible error banner; avoid an unhandled command promise.
          });
        });

        editor.onDidChangeCursorSelection((event) => {
          const selected = editor.getModel()?.getValueInRange(event.selection) ?? "";
          onSelectionChange(selected, event.selection.startLineNumber, event.selection.endLineNumber);
        });
      }}
      options={{ minimap: { enabled: false }, fontSize: 13, automaticLayout: true }}
    />
  );
}
