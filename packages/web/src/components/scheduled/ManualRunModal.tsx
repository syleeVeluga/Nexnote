import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ReorganizeRunForm } from "./ReorganizeRunForm.js";

interface ManualRunModalProps {
  open: boolean;
  workspaceId: string;
  maxPageLimit: number;
  onClose: () => void;
  onQueued: (scheduledRunId: string) => void;
}

export function ManualRunModal({
  open,
  workspaceId,
  maxPageLimit,
  onClose,
  onQueued,
}: ManualRunModalProps) {
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
        className="scheduled-modal"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        <header className="scheduled-modal-header">
          <h3>{t("manualRun.title")}</h3>
          <p>{t("manualRun.description")}</p>
        </header>
        <ReorganizeRunForm
          workspaceId={workspaceId}
          maxPageLimit={maxPageLimit}
          onCancel={onClose}
          onQueued={onQueued}
        />
      </div>
    </div>
  );
}
