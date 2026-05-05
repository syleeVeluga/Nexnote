import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ReorganizeRunForm } from "./ReorganizeRunForm.js";

interface FolderReorganizeModalProps {
  open: boolean;
  workspaceId: string;
  folderId: string;
  folderName: string;
  pageIds: string[];
  maxPageLimit: number;
  onClose: () => void;
  onQueued: (scheduledRunId: string) => void;
}

export function FolderReorganizeModal({
  open,
  workspaceId,
  folderId,
  folderName,
  pageIds,
  maxPageLimit,
  onClose,
  onQueued,
}: FolderReorganizeModalProps) {
  const { t } = useTranslation("scheduledAgent");
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      className="confirm-dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="scheduled-modal scheduled-folder-modal"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        <header className="scheduled-modal-header">
          <h3>{t("folderRun.title", { folderName })}</h3>
          <p>{t("folderRun.description")}</p>
        </header>
        {pageIds.length > maxPageLimit ? (
          <div className="scheduled-warning">
            {t("folderRun.tooManyPages", {
              count: pageIds.length,
              max: maxPageLimit,
            })}
          </div>
        ) : (
          <ReorganizeRunForm
            workspaceId={workspaceId}
            initialPageIds={pageIds}
            targetFolderId={folderId}
            includeDescendantsDefault
            showPagePicker={false}
            maxPageLimit={maxPageLimit}
            submitLabel={t("folderRun.submit")}
            onCancel={onClose}
            onQueued={onQueued}
          />
        )}
      </div>
    </div>
  );
}
