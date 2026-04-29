import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, Search } from "lucide-react";
import {
  decisions as decisionsApi,
  pages as pagesApi,
  type DecisionDetail,
  type IngestionAction,
  type Page,
} from "../../lib/api-client.js";

const ACTIONS: IngestionAction[] = [
  "create",
  "update",
  "append",
  "noop",
  "needs_review",
];

interface DecisionOverrideFormProps {
  workspaceId: string;
  decision: DecisionDetail;
  onSaved: () => void | Promise<void>;
}

interface TargetOption {
  id: string;
  title: string;
  slug: string | null;
}

function pageToOption(page: Page): TargetOption {
  return { id: page.id, title: page.title, slug: page.slug };
}

export function DecisionOverrideForm({
  workspaceId,
  decision,
  onSaved,
}: DecisionOverrideFormProps) {
  const { t } = useTranslation(["review", "common"]);
  const [action, setAction] = useState<IngestionAction>(decision.action);
  const [targetPageId, setTargetPageId] = useState(decision.targetPageId ?? "");
  const [proposedTitle, setProposedTitle] = useState(
    decision.proposedPageTitle ?? decision.ingestion.titleHint ?? "",
  );
  const [query, setQuery] = useState(decision.targetPage?.title ?? "");
  const [results, setResults] = useState<TargetOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setAction(decision.action);
    setTargetPageId(decision.targetPageId ?? "");
    setProposedTitle(
      decision.proposedPageTitle ?? decision.ingestion.titleHint ?? "",
    );
    setQuery(decision.targetPage?.title ?? "");
    setMessage(null);
  }, [decision]);

  useEffect(() => {
    if (action !== "update" && action !== "append") {
      setResults([]);
      return;
    }

    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }

    let cancelled = false;
    const handle = window.setTimeout(() => {
      pagesApi
        .search(workspaceId, { q: trimmed, limit: 8 })
        .then((res) => {
          if (!cancelled) setResults(res.data.map(pageToOption));
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [action, query, workspaceId]);

  const candidateOptions = useMemo<TargetOption[]>(
    () =>
      decision.candidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        slug: candidate.slug,
      })),
    [decision.candidates],
  );

  const options = query.trim().length >= 2 ? results : candidateOptions;
  const nextTargetPageId =
    action === "update" || action === "append" ? targetPageId || null : null;
  const nextProposedTitle = action === "create" ? proposedTitle.trim() : null;
  const targetChanged = nextTargetPageId !== decision.targetPageId;
  const actionChanged = action !== decision.action;
  const titleChanged =
    (nextProposedTitle ?? null) !== (decision.proposedPageTitle ?? null);
  const hasChanges = targetChanged || actionChanged || titleChanged;
  const targetRequired = action === "update" || action === "append";
  const titleRequired = action === "create";
  const invalid =
    (targetRequired && !nextTargetPageId) ||
    (titleRequired && !nextProposedTitle);

  async function save() {
    if (invalid || !hasChanges) return;
    setSaving(true);
    setMessage(null);
    try {
      await decisionsApi.edit(workspaceId, decision.id, {
        action,
        targetPageId: nextTargetPageId,
        proposedPageTitle: nextProposedTitle,
      });
      setMessage(t("override.saved", { defaultValue: "Decision updated" }));
      await onSaved();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("actionFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="decision-override">
      <div className="review-detail-label">
        {t("override.title", { defaultValue: "Decision override" })}
      </div>

      <div className="decision-override-grid">
        <label>
          <span>{t("override.action", { defaultValue: "Action" })}</span>
          <select
            value={action}
            onChange={(event) =>
              setAction(event.target.value as IngestionAction)
            }
          >
            {ACTIONS.map((item) => (
              <option key={item} value={item}>
                {t(`action.${item}`, { defaultValue: item })}
              </option>
            ))}
          </select>
        </label>

        {action === "create" && (
          <label>
            <span>
              {t("override.pageTitle", { defaultValue: "Page title" })}
            </span>
            <input
              value={proposedTitle}
              onChange={(event) => setProposedTitle(event.target.value)}
              placeholder={t("common:untitled")}
            />
          </label>
        )}

        {(action === "update" || action === "append") && (
          <label className="decision-override-target">
            <span>
              {t("override.targetPage", { defaultValue: "Target page" })}
            </span>
            <div className="decision-target-search">
              <Search size={13} aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setTargetPageId("");
                }}
                placeholder={t("override.searchPages", {
                  defaultValue: "Search pages",
                })}
              />
            </div>
            {options.length > 0 && (
              <div className="decision-target-options">
                {options.map((option) => (
                  <button
                    type="button"
                    key={option.id}
                    className={
                      option.id === targetPageId ? "selected" : undefined
                    }
                    onClick={() => {
                      setTargetPageId(option.id);
                      setQuery(option.title);
                    }}
                  >
                    <span>{option.title}</span>
                    {option.slug && <small>{option.slug}</small>}
                  </button>
                ))}
              </div>
            )}
          </label>
        )}
      </div>

      {(targetChanged || actionChanged) && decision.proposedRevision && (
        <div className="decision-override-warning">
          <AlertTriangle size={13} aria-hidden="true" />
          {t("override.invalidatesRevision", {
            defaultValue:
              "Changing action or target clears the AI-proposed revision; approval will regenerate from the current target.",
          })}
        </div>
      )}

      <div className="decision-override-actions">
        {message && (
          <span className="decision-override-message">{message}</span>
        )}
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!hasChanges || invalid || saving}
          onClick={save}
        >
          <Check size={13} aria-hidden="true" />
          {saving
            ? t("override.saving", { defaultValue: "Saving..." })
            : t("override.save", { defaultValue: "Save override" })}
        </button>
      </div>
    </section>
  );
}
