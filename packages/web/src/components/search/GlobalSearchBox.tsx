import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { FileText, Search, X } from "lucide-react";
import { useWorkspace } from "../../hooks/use-workspace.js";
import { useTimeAgo } from "../../hooks/use-time-ago.js";
import { pages as pagesApi, type Page } from "../../lib/api-client.js";
import { Badge } from "../ui/Badge.js";
import { IconButton } from "../ui/IconButton.js";

const SEARCH_DEBOUNCE_MS = 200;

function statusTone(status: Page["status"]) {
  if (status === "published") return "green";
  if (status === "archived") return "warm";
  return "orange";
}

interface GlobalSearchBoxProps {
  className?: string;
}

export function GlobalSearchBox({ className = "" }: GlobalSearchBoxProps) {
  const { t } = useTranslation("common");
  const { current } = useWorkspace();
  const navigate = useNavigate();
  const timeAgo = useTimeAgo();
  const inputRef = useRef<HTMLInputElement>(null);
  const latestRequestRef = useRef(0);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Page[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;

  useEffect(() => {
    function handleGlobalShortcut(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    }

    window.addEventListener("keydown", handleGlobalShortcut);
    return () => window.removeEventListener("keydown", handleGlobalShortcut);
  }, []);

  useEffect(() => {
    if (!current || !hasQuery) {
      latestRequestRef.current += 1;
      setResults([]);
      setTotal(0);
      setLoading(false);
      return;
    }

    const requestId = latestRequestRef.current + 1;
    latestRequestRef.current = requestId;
    setLoading(true);

    const timer = window.setTimeout(() => {
      pagesApi
        .search(current.id, { q: trimmedQuery, limit: 8 })
        .then((res) => {
          if (latestRequestRef.current !== requestId) return;
          setResults(res.data);
          setTotal(res.total);
        })
        .catch(() => {
          if (latestRequestRef.current !== requestId) return;
          setResults([]);
          setTotal(0);
        })
        .finally(() => {
          if (latestRequestRef.current === requestId) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [current, hasQuery, trimmedQuery]);

  const showPanel = open && (hasQuery || results.length > 0);
  const resultSummary = useMemo(() => {
    if (!hasQuery) return "";
    if (loading) return t("searchLoading", { defaultValue: "Searching..." });
    if (total === 0) return t("searchNoResults", { defaultValue: "No pages found" });
    return t("searchResultCount", {
      count: total,
      defaultValue: "{{count}} page found",
    });
  }, [hasQuery, loading, t, total]);

  function openPage(pageId: string) {
    navigate(`/pages/${pageId}`);
    setOpen(false);
    setQuery("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
    if (event.key === "Enter" && results[0]) {
      event.preventDefault();
      openPage(results[0].id);
    }
  }

  return (
    <div className={`global-search ${className}`.trim()}>
      <Search className="global-search-icon" size={15} aria-hidden="true" />
      <input
        ref={inputRef}
        value={query}
        type="search"
        className="global-search-input"
        placeholder={t("searchPlaceholder", { defaultValue: "Search pages" })}
        aria-label={t("searchOpenLabel", { defaultValue: "Search pages" })}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={handleKeyDown}
      />
      {query && (
        <IconButton
          className="global-search-clear"
          size="sm"
          icon={<X size={13} />}
          label={t("clearSearch", { defaultValue: "Clear search" })}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setQuery("");
            setResults([]);
            setTotal(0);
            inputRef.current?.focus();
          }}
        />
      )}
      {showPanel && (
        <div className="global-search-panel" role="listbox">
          <div className="global-search-summary">{resultSummary}</div>
          {results.map((page) => (
            <button
              key={page.id}
              className="global-search-result"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => openPage(page.id)}
              role="option"
              aria-selected="false"
            >
              <span className="global-search-result-icon" aria-hidden="true">
                <FileText size={14} />
              </span>
              <span className="global-search-result-body">
                <span className="global-search-result-title">
                  {page.title || t("untitled")}
                </span>
                <span className="global-search-result-meta">
                  {t("updated", { defaultValue: "Updated" })}{" "}
                  {timeAgo(page.updatedAt)}
                </span>
              </span>
              <Badge tone={statusTone(page.status)} size="sm">
                {page.status}
              </Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
