import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { scheduledAgent } from "../../lib/api-client.js";
import { PageMultiPicker } from "./PageMultiPicker.js";

interface ReorganizeRunFormProps {
  workspaceId: string;
  initialPageIds?: string[];
  includeDescendantsDefault?: boolean;
  showPagePicker?: boolean;
  maxPageLimit?: number;
  submitLabel?: string;
  onCancel: () => void;
  onQueued: (scheduledRunId: string) => void;
}

export function ReorganizeRunForm({
  workspaceId,
  initialPageIds = [],
  includeDescendantsDefault = true,
  showPagePicker = true,
  maxPageLimit = 500,
  submitLabel,
  onCancel,
  onQueued,
}: ReorganizeRunFormProps) {
  const { t } = useTranslation(["scheduledAgent", "common"]);
  const [pageIds, setPageIds] = useState<string[]>(initialPageIds);
  const [includeDescendants, setIncludeDescendants] = useState(
    includeDescendantsDefault,
  );
  const [instruction, setInstruction] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPageIds(initialPageIds);
  }, [initialPageIds]);

  async function submit() {
    if (pageIds.length === 0) {
      setError(t("errors.noTargetPages"));
      return;
    }
    if (pageIds.length > maxPageLimit) {
      setError(
        t("errors.tooManyPages", {
          count: pageIds.length,
          max: maxPageLimit,
        }),
      );
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await scheduledAgent.triggerReorganize(workspaceId, {
        pageIds,
        includeDescendants,
        instruction: instruction.trim() || null,
      });
      onQueued(result.scheduledRunId);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("errors.queueRunFailed"),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="scheduled-run-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {showPagePicker ? (
        <label className="scheduled-form-field">
          <span>{t("forms.targetPages")}</span>
          <PageMultiPicker
            workspaceId={workspaceId}
            selectedPageIds={pageIds}
            onChange={setPageIds}
            maxSelection={maxPageLimit}
          />
        </label>
      ) : (
        <div className="scheduled-run-target-summary">
          {t("forms.seededTargetCount", { count: pageIds.length })}
        </div>
      )}

      <label className="scheduled-check-field">
        <input
          type="checkbox"
          checked={includeDescendants}
          onChange={(event) => setIncludeDescendants(event.target.checked)}
        />
        <span>{t("forms.includeDescendants")}</span>
      </label>

      <label className="scheduled-form-field">
        <span>{t("forms.instruction")}</span>
        <textarea
          rows={5}
          maxLength={4000}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder={t("forms.instructionPlaceholder")}
        />
      </label>

      {error && <div className="form-error">{error}</div>}

      <div className="scheduled-modal-actions">
        <button type="button" className="btn-sm" onClick={onCancel}>
          {t("common:cancel")}
        </button>
        <button
          type="submit"
          className="btn-sm btn-primary"
          disabled={submitting || pageIds.length === 0}
        >
          {submitting
            ? t("forms.queueing")
            : (submitLabel ?? t("forms.runNow"))}
        </button>
      </div>
    </form>
  );
}
