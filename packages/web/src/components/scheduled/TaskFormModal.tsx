import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  scheduledAgent,
  type ScheduledTask,
  type ScheduledTaskBody,
} from "../../lib/api-client.js";
import { PageMultiPicker } from "./PageMultiPicker.js";

interface TaskFormModalProps {
  open: boolean;
  workspaceId: string;
  task: ScheduledTask | null;
  maxPageLimit: number;
  onClose: () => void;
  onSaved: () => void;
}

const CRON_PATTERN = /^(\S+\s+){4,5}\S+$/;

export function TaskFormModal({
  open,
  workspaceId,
  task,
  maxPageLimit,
  onClose,
  onSaved,
}: TaskFormModalProps) {
  const { t } = useTranslation(["scheduledAgent", "common"]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState("");
  const [cronExpression, setCronExpression] = useState("");
  const [targetPageIds, setTargetPageIds] = useState<string[]>([]);
  const [includeDescendants, setIncludeDescendants] = useState(true);
  const [instruction, setInstruction] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(task?.name ?? "");
    setCronExpression(task?.cronExpression ?? "0 9 * * *");
    setTargetPageIds(task?.targetPageIds ?? []);
    setIncludeDescendants(task?.includeDescendants ?? true);
    setInstruction(task?.instruction ?? "");
    setEnabled(task?.enabled ?? true);
    setError(null);
    window.setTimeout(() => dialogRef.current?.focus(), 0);
  }, [open, task]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, open, saving]);

  if (!open) return null;

  async function save() {
    const trimmedName = name.trim();
    const trimmedCron = cronExpression.trim();
    if (!trimmedName) {
      setError(t("taskForm.errors.nameRequired"));
      return;
    }
    if (!CRON_PATTERN.test(trimmedCron)) {
      setError(t("taskForm.errors.invalidCron"));
      return;
    }
    if (targetPageIds.length === 0) {
      setError(t("errors.noTargetPages"));
      return;
    }
    if (targetPageIds.length > maxPageLimit) {
      setError(
        t("errors.tooManyPages", {
          count: targetPageIds.length,
          max: maxPageLimit,
        }),
      );
      return;
    }

    const body: ScheduledTaskBody = {
      name: trimmedName,
      cronExpression: trimmedCron,
      targetPageIds,
      includeDescendants,
      instruction: instruction.trim() || null,
      enabled,
    };

    setSaving(true);
    setError(null);
    try {
      if (task) {
        await scheduledAgent.updateTask(workspaceId, task.id, body);
      } else {
        await scheduledAgent.createTask(workspaceId, body);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("taskForm.errors.save"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="confirm-dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="scheduled-modal scheduled-task-modal"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        <header className="scheduled-modal-header">
          <h3>{task ? t("taskForm.editTitle") : t("taskForm.createTitle")}</h3>
          <p>{t("taskForm.description")}</p>
        </header>

        <form
          className="scheduled-run-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="scheduled-task-form-grid">
            <label className="scheduled-form-field">
              <span>{t("taskForm.name")}</span>
              <input
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="scheduled-form-field">
              <span>{t("taskForm.cronExpression")}</span>
              <input
                value={cronExpression}
                maxLength={120}
                onChange={(event) => setCronExpression(event.target.value)}
                placeholder="0 9 * * *"
              />
            </label>
          </div>

          <label className="scheduled-form-field">
            <span>{t("forms.targetPages")}</span>
            <PageMultiPicker
              workspaceId={workspaceId}
              selectedPageIds={targetPageIds}
              onChange={setTargetPageIds}
              maxSelection={maxPageLimit}
            />
          </label>

          <div className="scheduled-check-row">
            <label className="scheduled-check-field">
              <input
                type="checkbox"
                checked={includeDescendants}
                onChange={(event) =>
                  setIncludeDescendants(event.target.checked)
                }
              />
              <span>{t("forms.includeDescendants")}</span>
            </label>
            <label className="scheduled-check-field">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              <span>{t("taskForm.enabled")}</span>
            </label>
          </div>

          <label className="scheduled-form-field">
            <span>{t("forms.instruction")}</span>
            <textarea
              rows={4}
              maxLength={4000}
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder={t("forms.instructionPlaceholder")}
            />
          </label>

          {error && <div className="form-error">{error}</div>}

          <div className="scheduled-modal-actions">
            <button
              type="button"
              className="btn-sm"
              onClick={onClose}
              disabled={saving}
            >
              {t("common:cancel")}
            </button>
            <button
              type="submit"
              className="btn-sm btn-primary"
              disabled={saving}
            >
              {saving ? t("taskForm.saving") : t("taskForm.save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
