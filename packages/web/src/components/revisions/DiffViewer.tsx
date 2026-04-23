import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { UNIFIED_DIFF_HEADER_LINES } from "@wekiflow/shared";

interface DiffViewerProps {
  diffMd: string;
  changedBlocks?: number | null;
  title?: string;
  onClose: () => void;
}

export function classifyLine(line: string): string {
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
  title,
  onClose,
}: DiffViewerProps) {
  const { t } = useTranslation("editor");
  const displayTitle = title ?? t("diff");
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
            <h3>{displayTitle}</h3>
            {changedBlocks != null && (
              <span className="diff-summary">
                {t("blocksChanged", { count: changedBlocks })}
              </span>
            )}
          </div>
          <button className="btn-close-panel" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="diff-content">
          {lines.length <= UNIFIED_DIFF_HEADER_LINES ? (
            <div className="diff-empty">{t("noChanges")}</div>
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
