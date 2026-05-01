import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { pages as pagesApi, type Page } from "../../lib/api-client.js";
import { Badge } from "../ui/Badge.js";
import { IconButton } from "../ui/IconButton.js";

interface PageMultiPickerProps {
  workspaceId: string;
  selectedPageIds: string[];
  onChange: (pageIds: string[]) => void;
  maxSelection?: number;
}

export function PageMultiPicker({
  workspaceId,
  selectedPageIds,
  onChange,
  maxSelection = 500,
}: PageMultiPickerProps) {
  const { t } = useTranslation(["scheduledAgent", "common"]);
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<Page[]>([]);
  const [knownPages, setKnownPages] = useState<Record<string, Page>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      const trimmed = query.trim();
      const request =
        trimmed.length >= 2
          ? pagesApi.search(workspaceId, { q: trimmed, limit: 50 })
          : pagesApi.list(workspaceId, { limit: 100 });

      request
        .then((res) => {
          if (cancelled) return;
          setPages(res.data);
          setKnownPages((current) => {
            const next = { ...current };
            for (const page of res.data) next[page.id] = page;
            return next;
          });
        })
        .catch((err) => {
          if (cancelled) return;
          setError(
            err instanceof Error
              ? err.message
              : t("errors.loadPages", {
                  defaultValue: "Could not load pages.",
                }),
          );
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 160);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, t, workspaceId]);

  const selectedPages = useMemo(
    () => selectedPageIds.map((id) => knownPages[id] ?? { id, title: id }),
    [knownPages, selectedPageIds],
  );

  function togglePage(page: Page) {
    if (selectedPageIds.includes(page.id)) {
      onChange(selectedPageIds.filter((id) => id !== page.id));
      return;
    }
    if (selectedPageIds.length >= maxSelection) return;
    onChange([...selectedPageIds, page.id]);
    setKnownPages((current) => ({ ...current, [page.id]: page }));
  }

  return (
    <div className="scheduled-page-picker">
      <label className="scheduled-search-field">
        <span className="scheduled-search-icon" aria-hidden="true">
          <Search size={14} />
        </span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("pagePicker.searchPlaceholder")}
        />
      </label>

      {selectedPageIds.length > 0 && (
        <div className="scheduled-selected-pages">
          {selectedPages.map((page) => (
            <Badge key={page.id} tone="blue" size="sm">
              <span>{page.title}</span>
              <button
                type="button"
                onClick={() =>
                  onChange(selectedPageIds.filter((id) => id !== page.id))
                }
                aria-label={t("pagePicker.removePage", {
                  title: page.title,
                })}
              >
                <X size={11} />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {selectedPageIds.length > 50 && (
        <div className="scheduled-warning">
          {t("pagePicker.largeSelectionWarning", {
            count: selectedPageIds.length,
          })}
        </div>
      )}

      {error && <div className="form-error">{error}</div>}

      <div className="scheduled-picker-list">
        {loading ? (
          <div className="system-empty">{t("common:loading")}</div>
        ) : pages.length === 0 ? (
          <div className="system-empty">{t("pagePicker.empty")}</div>
        ) : (
          pages.map((page) => {
            const selected = selectedPageIds.includes(page.id);
            return (
              <button
                key={page.id}
                type="button"
                className={selected ? "is-selected" : ""}
                onClick={() => togglePage(page)}
                disabled={!selected && selectedPageIds.length >= maxSelection}
              >
                <span>
                  <strong>{page.title}</strong>
                  <small>{page.slug}</small>
                </span>
                {selected && <Badge size="sm">{t("pagePicker.selected")}</Badge>}
              </button>
            );
          })
        )}
      </div>

      <div className="scheduled-picker-footer">
        {t("pagePicker.selectionCount", {
          count: selectedPageIds.length,
          max: maxSelection,
        })}
      </div>
    </div>
  );
}
