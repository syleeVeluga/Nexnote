import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspace } from "../hooks/use-workspace.js";
import { useTimeAgo } from "../hooks/use-time-ago.js";
import {
  decisions as decisionsApi,
  type DecisionListItem,
  type DecisionDetail,
  type DecisionCounts,
  type DecisionStatus,
} from "../lib/api-client.js";
import { ReviewDetail } from "../components/review/ReviewDetail.js";
import { dispatchDecisionCountsUpdated } from "../lib/decision-events.js";

type TabKey = "suggested" | "needs_review" | "failed" | "recent";

interface TabConfig {
  key: TabKey;
  statuses: DecisionStatus[];
  sinceDays?: number;
}

const TABS: TabConfig[] = [
  { key: "suggested", statuses: ["suggested"] },
  { key: "needs_review", statuses: ["needs_review"] },
  { key: "failed", statuses: ["failed"] },
  { key: "recent", statuses: ["auto_applied", "approved", "rejected"], sinceDays: 7 },
];

export function ReviewQueuePage() {
  const { t } = useTranslation(["review", "common"]);
  const { current } = useWorkspace();
  const timeAgo = useTimeAgo();
  const [activeTab, setActiveTab] = useState<TabKey>("suggested");
  const [items, setItems] = useState<DecisionListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DecisionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [counts, setCounts] = useState<DecisionCounts | null>(null);

  const tabConfig = TABS.find((tab) => tab.key === activeTab) ?? TABS[0];
  const workspaceId = current?.id;

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const [listRes, countsRes] = await Promise.all([
        decisionsApi.list(workspaceId, {
          status: tabConfig.statuses,
          sinceDays: tabConfig.sinceDays,
          limit: 50,
        }),
        decisionsApi.counts(workspaceId),
      ]);
      setItems(listRes.data);
      setCounts(countsRes.counts);
      dispatchDecisionCountsUpdated({ workspaceId, counts: countsRes.counts });
      setSelectedId((prev) => {
        if (listRes.data.length === 0) return null;
        return prev && listRes.data.some((i) => i.id === prev)
          ? prev
          : listRes.data[0].id;
      });
    } catch {
      setItems([]);
      setCounts(null);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, tabConfig]);

  useEffect(() => {
    let cancelled = false;
    refresh().catch(() => {
      if (!cancelled) {
        setItems([]);
        setCounts(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    if (!workspaceId || !selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    decisionsApi
      .get(workspaceId, selectedId)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, selectedId]);

  const handleApprove = useCallback(async () => {
    if (!workspaceId || !selectedId) return;
    try {
      await decisionsApi.approve(workspaceId, selectedId);
      await refresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t("actionFailed"));
    }
  }, [workspaceId, selectedId, refresh, t]);

  const handleReject = useCallback(
    async (reason?: string) => {
      if (!workspaceId || !selectedId) return;
      try {
        await decisionsApi.reject(workspaceId, selectedId, reason);
        await refresh();
      } catch (err) {
        window.alert(err instanceof Error ? err.message : t("actionFailed"));
      }
    },
    [workspaceId, selectedId, refresh, t],
  );

  const itemsRef = useRef(items);
  const selectedIdRef = useRef(selectedId);
  const handleApproveRef = useRef(handleApprove);
  const handleRejectRef = useRef(handleReject);
  itemsRef.current = items;
  selectedIdRef.current = selectedId;
  handleApproveRef.current = handleApprove;
  handleRejectRef.current = handleReject;

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const list = itemsRef.current;
        if (list.length === 0) return;
        const idx = list.findIndex((i) => i.id === selectedIdRef.current);
        const direction = e.key === "j" ? 1 : -1;
        const nextIdx = Math.max(
          0,
          Math.min(list.length - 1, (idx < 0 ? 0 : idx) + direction),
        );
        setSelectedId(list[nextIdx].id);
      } else if (e.key === "a") {
        e.preventDefault();
        handleApproveRef.current();
      } else if (e.key === "r") {
        e.preventDefault();
        handleRejectRef.current();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (!current) return null;

  return (
    <div className="review-page">
      <div className="review-header">
        <div>
          <h1>{t("title")}</h1>
          <p className="review-subtitle">{t("subtitle")}</p>
        </div>
        <div className="review-shortcut-hint">{t("shortcutHint")}</div>
      </div>

      <div className="review-tabs">
        {TABS.map((tab) => {
          const badgeCount =
            counts && tab.key !== "recent" ? counts[tab.key] : 0;
          return (
            <button
              key={tab.key}
              className={`review-tab${activeTab === tab.key ? " active" : ""}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {t(`tabs.${tab.key}`)}
              {badgeCount > 0 && (
                <span className="review-tab-count">{badgeCount}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="review-body">
        <div className="review-list">
          {loading ? (
            <div className="review-empty">{t("loading")}</div>
          ) : items.length === 0 ? (
            <div className="review-empty">{t("emptyList")}</div>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                className={`review-item${selectedId === item.id ? " selected" : ""}`}
                onClick={() => setSelectedId(item.id)}
              >
                <div className="review-item-top">
                  <span className={`review-badge review-badge-${item.status}`}>
                    {t(`badge.${item.status}`, {
                      defaultValue: item.status,
                    })}
                  </span>
                  {item.hasConflict && (
                    <span
                      className="review-conflict-chip"
                      title={t("conflict.tooltip")}
                    >
                      ⚠ {t("conflict.chip")}
                    </span>
                  )}
                  <span className="review-confidence">
                    {Math.round(item.confidence * 100)}%
                  </span>
                </div>
                <div className="review-item-target">
                  {item.action === "create"
                    ? t("newPage", {
                        title:
                          item.proposedPageTitle ??
                          item.ingestion.titleHint ??
                          t("common:untitled"),
                      })
                    : (item.targetPage?.title ??
                      item.ingestion.titleHint ??
                      t("common:untitled"))}
                </div>
                <div className="review-item-meta">
                  <span className="review-action-chip">
                    {t(`action.${item.action}`, {
                      defaultValue: item.action,
                    })}
                  </span>
                  <span className="review-source">
                    {item.ingestion.sourceName}
                  </span>
                  <span className="review-time">{timeAgo(item.createdAt)}</span>
                </div>
                {item.reason && (
                  <div className="review-item-reason">{item.reason}</div>
                )}
              </button>
            ))
          )}
        </div>

        <div className="review-detail">
          {detailLoading ? (
            <div className="review-empty">{t("loading")}</div>
          ) : detail ? (
            <ReviewDetail
              decision={detail}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          ) : (
            <div className="review-empty">{t("selectItem")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
