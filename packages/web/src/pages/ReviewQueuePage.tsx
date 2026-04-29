import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  Inbox,
  Send,
  XCircle,
} from "lucide-react";
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
import {
  dispatchDecisionCountsUpdated,
  subscribeDecisionCountsUpdated,
} from "../lib/decision-events.js";
import { Badge, type BadgeTone } from "../components/ui/Badge.js";
import { PageShell } from "../components/ui/PageShell.js";
import { SegmentedTabs } from "../components/ui/SegmentedTabs.js";

type TabKey = "all" | "needs_review" | "failed" | "recent";

interface TabConfig {
  key: TabKey;
  statuses: DecisionStatus[];
  sinceDays?: number;
}

const TABS: TabConfig[] = [
  { key: "all", statuses: ["suggested", "needs_review", "failed"] },
  { key: "needs_review", statuses: ["needs_review"] },
  { key: "failed", statuses: ["failed"] },
  {
    key: "recent",
    statuses: ["auto_applied", "approved", "rejected"],
    sinceDays: 7,
  },
];

function tabCount(key: TabKey, counts: DecisionCounts | null) {
  if (!counts || key === "recent") return undefined;
  if (key === "all") return counts.pending;
  return counts[key];
}

function tabIcon(key: TabKey) {
  switch (key) {
    case "all":
      return <Inbox size={14} />;
    case "needs_review":
      return <AlertTriangle size={14} />;
    case "failed":
      return <XCircle size={14} />;
    case "recent":
      return <Clock3 size={14} />;
  }
}

function statusTone(status: DecisionStatus): BadgeTone {
  switch (status) {
    case "suggested":
      return "teal";
    case "needs_review":
      return "orange";
    case "failed":
      return "red";
    case "auto_applied":
    case "approved":
      return "green";
    case "rejected":
      return "warm";
    default:
      return "blue";
  }
}

function statusIcon(status: DecisionStatus) {
  switch (status) {
    case "suggested":
    case "auto_applied":
      return <Bot size={11} />;
    case "needs_review":
      return <AlertTriangle size={11} />;
    case "failed":
    case "rejected":
      return <XCircle size={11} />;
    case "approved":
      return <CheckCircle2 size={11} />;
    default:
      return <Send size={11} />;
  }
}

export function ReviewQueuePage() {
  const { t } = useTranslation(["review", "common"]);
  const { current } = useWorkspace();
  const timeAgo = useTimeAgo();
  const [activeTab, setActiveTab] = useState<TabKey>("all");
  const [items, setItems] = useState<DecisionListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DecisionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [counts, setCounts] = useState<DecisionCounts | null>(null);
  const refreshSeqRef = useRef(0);

  const tabConfig = TABS.find((tab) => tab.key === activeTab) ?? TABS[0];
  const workspaceId = current?.id;

  const refresh = useCallback(
    async (options?: { broadcastCounts?: boolean }) => {
      if (!workspaceId) return;
      const seq = refreshSeqRef.current + 1;
      refreshSeqRef.current = seq;
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
        if (seq !== refreshSeqRef.current) return;
        setItems(listRes.data);
        setCounts(countsRes.counts);
        if (options?.broadcastCounts) {
          dispatchDecisionCountsUpdated({
            workspaceId,
            counts: countsRes.counts,
          });
        }
        setSelectedId((prev) => {
          if (listRes.data.length === 0) return null;
          return prev && listRes.data.some((i) => i.id === prev)
            ? prev
            : listRes.data[0].id;
        });
      } catch {
        if (seq !== refreshSeqRef.current) return;
        setItems([]);
        setCounts(null);
      } finally {
        if (seq === refreshSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [workspaceId, tabConfig],
  );

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
    if (!workspaceId) return;
    return subscribeDecisionCountsUpdated((detail) => {
      if (detail.workspaceId !== workspaceId) return;
      void refresh({ broadcastCounts: false });
    });
  }, [workspaceId, refresh]);

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
      await refresh({ broadcastCounts: true });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t("actionFailed"));
    }
  }, [workspaceId, selectedId, refresh, t]);

  const handleReject = useCallback(
    async (reason?: string) => {
      if (!workspaceId || !selectedId) return;
      try {
        await decisionsApi.reject(workspaceId, selectedId, reason);
        await refresh({ broadcastCounts: true });
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
    <PageShell
      className="review-page"
      title={t("title")}
      description={t("subtitle")}
      actions={
        <Badge tone="warm" size="sm">
          {t("shortcutHint")}
        </Badge>
      }
    >
      <SegmentedTabs
        className="review-tabs"
        value={activeTab}
        onChange={(value) => setActiveTab(value as TabKey)}
        ariaLabel={t("tabsLabel", { defaultValue: "Review queue status" })}
        tabs={TABS.map((tab) => ({
          id: tab.key,
          label: t(`tabs.${tab.key}`, {
            defaultValue:
              tab.key === "all"
                ? "All"
                : tab.key === "needs_review"
                  ? t("tabs.needs_review")
                  : tab.key === "failed"
                    ? t("tabs.failed")
                    : t("tabs.recent"),
          }),
          count: tabCount(tab.key, counts),
          icon: tabIcon(tab.key),
        }))}
      />

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
                  <Badge
                    tone={statusTone(item.status)}
                    size="sm"
                    icon={statusIcon(item.status)}
                    className={`review-badge review-badge-${item.status}`}
                  >
                    {t(`badge.${item.status}`, {
                      defaultValue: item.status,
                    })}
                  </Badge>
                  {item.hasConflict && (
                    <span
                      className="review-conflict-chip"
                      title={t("conflict.tooltip")}
                    >
                      <AlertTriangle size={11} aria-hidden="true" />
                      {t("conflict.chip")}
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
    </PageShell>
  );
}
