import { useCallback, useMemo } from "react";
import { UNIFIED_DIFF_HEADER_LINES } from "@nexnote/shared";

interface DiffViewerProps {
  diffMd: string;
  changedBlocks?: number | null;
  title?: string;
  onClose: () => void;
}

function classifyLine(line: string): string {
  if (line.startsWith("@@")) return "diff-line diff-line-hunk";
  if (line.startsWith("+++") || line.startsWith("---"))
    return "diff-line diff-line-header";
  if (line.startsWith("+")) return "diff-line diff-line-add";
  if (line.startsWith("-")) return "diff-line diff-line-remove";
  return "diff-line";
}

export function DiffViewer({
  diffMd,
  changedBlocks,
  title = "Diff",
  onClose,
}: DiffViewerProps) {
  const lines = useMemo(() => diffMd.split("\n"), [diffMd]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  return (
    <div className="diff-viewer-overlay" onClick={handleOverlayClick}>
      <div className="diff-viewer-modal">
        <div className="diff-viewer-header">
          <div>
            <h3>{title}</h3>
            {changedBlocks != null && (
              <span className="diff-summary">
                {changedBlocks} block{changedBlocks !== 1 ? "s" : ""} changed
              </span>
            )}
          </div>
          <button className="btn-close-panel" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="diff-content">
          {lines.length <= UNIFIED_DIFF_HEADER_LINES ? (
            <div className="diff-empty">No changes</div>
          ) : (
            <pre>
              {lines.map((line, i) => (
                <span key={i} className={classifyLine(line)}>
                  {line}
                  {"\n"}
                </span>
              ))}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
