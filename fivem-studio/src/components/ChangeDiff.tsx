import { DiffEditor } from "@monaco-editor/react";

import "../monacoSetup";

interface ChangeDiffProps {
  id: string | number;
  original: string;
  modified: string;
  language: string;
  fontSize: number;
  wordWrap: boolean;
  compact?: boolean;
}

export default function ChangeDiff({
  id,
  original,
  modified,
  language,
  fontSize,
  wordWrap,
  compact = false,
}: ChangeDiffProps) {
  const modelBase = `qb-studio-diff://review/${encodeURIComponent(String(id))}`;
  return (
    <DiffEditor
      original={original}
      modified={modified}
      language={language}
      originalModelPath={`${modelBase}/original.${language}`}
      modifiedModelPath={`${modelBase}/modified.${language}`}
      theme="vs-dark"
      options={{
        automaticLayout: true,
        readOnly: true,
        originalEditable: false,
        renderSideBySide: !compact,
        enableSplitViewResizing: !compact,
        minimap: { enabled: false },
        fontSize,
        wordWrap: wordWrap ? "on" : "off",
        renderIndicators: true,
        renderOverviewRuler: !compact,
        maxComputationTime: 3_000,
        smoothScrolling: true,
      }}
    />
  );
}
