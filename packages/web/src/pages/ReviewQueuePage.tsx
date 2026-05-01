import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Bot,
  CalendarClock,
  CheckCircle2,
  Inbox,
  RotateCcw,
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

type TabKey = "all" | "needs_review" | "failed";
type OriginFilter = "all" | "ingestion" | "scheduled";

interface TabConfig {
  key: TabKey;
  statuses: DecisionStatus[];
  sinceDays?: number;
}

const PENDING_STATUSES: DecisionStatus[] = [
  "suggested",
  "needs_review",
  "failed",
];
const RECENT_DONE_STATUSES: DecisionStatus[] = [
  "auto_applied",
  "approved",
  "rejected",
  "undone",
];
const RECENT_DONE_DAYS = 7;
type DecisionListResponse = Awaited<ReturnType<typeof decisionsApi.list>>;
type DecisionCountsResponse = Awaited<ReturnType<typeof decisionsApi.counts>>;

const TABS: TabConfig[] = [
  { key: "all", statuses: PENDING_STATUSES },
  { key: "needs_review", statuses: ["needs_review"] },
  { key: "failed", statuses: ["failed"] },
];

function tabCount(
  key: TabKey,
  counts: DecisionCounts | null,
  allTotal: number | null,
) {
  if (!counts) return undefined;
  if (key === "all") return allTotal ?? counts.pending;
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
    case "undone":
      return "blue";
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
    case "undone":
      return <RotateCcw size={11} />;
    default:
      return <Send size={11} />;
  }
}

export function ReviewQueuePage() {
  const { t } = useTranslation(["review", "common"]);
  const { current } = useWorkspace();
  const timeAgo = useTimeAgo();
  const [activeTab, setActiveTab] = useState<TabKey>("all");
  const [originFilter, setOriginFilter] = useState<OriginFilter>("all");
  const [items, setItems] = useState<DecisionListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DecisionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [counts, setCounts] = useState<DecisionCounts | null>(null);
  const [allTotal, setAllTotal] = useState<number | null>(null);
  const [activeTotal, setActiveTotal] = useState<number | null>(null);
  const refreshSeqRef = useRef(0);

  const tabConfig = TABS.find((tab) => tab.key === activeTab) ?? TABS[0];
  const workspaceId = current?.id;
  const originParam = originFilter === "all" ? undefined : originFilter;

  const refresh = useCallback(
    async (options?: { broadcastCounts?: boolean }) => {
      if (!workspaceId) return [];
      const seq = refreshSeqRef.current + 1;
      refreshSeqRef.current = seq;
      setLoading(true);
      try {
        let listRes: DecisionListResponse;
        let countsRes: DecisionCountsResponse;
        let nextAllTotal: number;

        if (activeTab === "all") {
          const [pendingRes, recentDoneRes, nextCountsRes] = await Promise.all([
            decisionsApi.list(workspaceId, {
              status: PENDING_STATUSES,
              origin: originParam,
              limit: 50,
            }),
            decisionsApi.list(workspaceId, {
              status: RECENT_DONE_STATUSES,
              origin: originParam,
              sinceDays: RECENT_DONE_DAYS,
              limit: 50,
            }),
            decisionsApi.counts(workspaceId),
          ]);

          listRes = {
            ...pendingRes,
            data: [...pendingRes.data, ...recentDoneRes.data]
              .sort(
                (a, b) =>
                  new Date(b.createdAt).getTime() -
                  new Date(a.createdAt).getTime(),
              )
              .slice(0, 50),
            total: pendingRes.total + recentDoneRes.total,
          };
          countsRes = nextCountsRes;
          nextAllTotal = listRes.total;
        } else {
          const [nextListRes, nextCountsRes, recentDoneTotal] =
            await Promise.all([
              decisionsApi.list(workspaceId, {
                status: tabConfig.statuses,
                origin: originParam,
                sinceDays: tabConfig.sinceDays,
                limit: 50,
              }),
              decisionsApi.counts(workspaceId),
              decisionsApi
                .list(workspaceId, {
                  status: RECENT_DONE_STATUSES,
                  origin: originParam,
                  sinceDays: RECENT_DONE_DAYS,
                  limit: 1,
                })
                .then((res) => res.total),
            ]);

          listRes = nextListRes;
          countsRes = nextCountsRes;
          nextAllTotal = countsRes.counts.pending + recentDoneTotal;
        }

        if (seq !== refreshSeqRef.current) return [];
        setItems(listRes.data);
        setCounts(countsRes.counts);
        setAllTotal(nextAllTotal);
        setActiveTotal(listRes.total);
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
        return listRes.data;
      } catch {
        if (seq !== refreshSeqRef.current) return [];
        setItems([]);
        setCounts(null);
        setActiveTotal(null);
        return [];
      } finally {
        if (seq === refreshSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [activeTab, workspaceId, tabConfig, originParam],
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

  const loadDetail = useCallback(
    async (id: string) => {
      if (!workspaceId) return;
      setDetailLoading(true);
      try {
        const res = await decisionsApi.get(workspaceId, id);
        setDetail(res);
      } catch {
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [workspaceId],
  );

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
    const decisionId = selectedId;
    try {
      await decisionsApi.approve(workspaceId, decisionId);
      const refreshedItems = await refresh({ broadcastCounts: true });
      if (
        activeTab === "all" &&
        refreshedItems.some((item) => item.id === decisionId)
      ) {
        await loadDetail(decisionId);
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t("actionFailed"));
    }
  }, [workspaceId, selectedId, refresh, activeTab, loadDetail, t]);

  const handleReject = useCallback(
    async (reason?: string) => {
      if (!workspaceId || !selectedId) return;
      const decisionId = selectedId;
      try {
        await decisionsApi.reject(workspaceId, decisionId, reason);
        const refreshedItems = await refresh({ broadcastCounts: true });
        if (
          activeTab === "all" &&
          refreshedItems.some((item) => item.id === decisionId)
        ) {
          await loadDetail(decisionId);
        }
      } catch (err) {
        window.alert(err instanceof Error ? err.message : t("actionFailed"));
      }
    },
    [workspaceId, selectedId, refresh, activeTab, loadDetail, t],
  );

  const handleUndo = useCallback(async () => {
    if (!workspaceId || !selectedId) return;
    try {
      await decisionsApi.undo(workspaceId, selectedId);
      await refresh({ broadcastCounts: true });
      await loadDetail(selectedId);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t("actionFailed"));
    }
  }, [workspaceId, selectedId, refresh, loadDetail, t]);

  const handleDecisionChanged = useCallback(async () => {
    if (!workspaceId || !selectedId) return;
    await refresh({ broadcastCounts: true });
    await loadDetail(selectedId);
  }, [workspaceId, selectedId, refresh, loadDetail]);

  const itemsRef = useRef(items);
  const selectedIdRef = useRef(selectedId);
  const handleApproveRef = useRef(handleApprove);
  const handleRejectRef = useRef(handleReject);
  const fanoutByDecisionId = useMemo(() => {
    const groups = new Map<string, DecisionListItem[]>();
    for (const item of items) {
      const group = groups.get(item.ingestion.id) ?? [];
      group.push(item);
      groups.set(item.ingestion.id, group);
    }

    const result = new Map<string, { index: number; total: number }>();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => {
        const timeDelta =
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        return timeDelta !== 0 ? timeDelta : a.id.localeCompare(b.id);
      });
      sorted.forEach((item, idx) => {
        result.set(item.id, { index: idx + 1, total: sorted.length });
      });
    }
    return result;
  }, [items]);
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

  const displayTabCount = (key: TabKey) => {
    if (originFilter !== "all") {
      return key === activeTab ? (activeTotal ?? undefined) : undefined;
    }
    return tabCount(key, counts, allTotal);
  };

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
                ? "전체"
                : tab.key === "needs_review"
                  ? t("tabs.needs_review")
                  : t("tabs.failed"),
          }),
          count: displayTabCount(tab.key),
          icon: tabIcon(tab.key),
        }))}
      />

      <div
        className="review-origin-filter"
        role="group"
        aria-label={t("origin.filterLabel", {
          defaultValue: "Decision origin",
        })}
      >
        {(["all", "ingestion", "scheduled"] as const).map((origin) => (
          <button
            key={origin}
            type="button"
            className={`review-origin-filter-button${
              originFilter === origin ? " active" : ""
            }`}
            onClick={() => setOriginFilter(origin)}
          >
            {origin === "scheduled" && (
              <CalendarClock size={13} aria-hidden="true" />
            )}
            {t(`origin.${origin}`, {
              defaultValue:
                origin === "all"
                  ? "All origins"
                  : origin === "scheduled"
                    ? "Scheduled Agent"
                    : "Ingestions",
            })}
          </button>
        ))}
      </div>

      <div className="review-body">
        <div className="review-list">
          {loading ? (
            <div className="review-empty">{t("loading")}</div>
          ) : items.length === 0 ? (
            <div className="review-empty">{t("emptyList")}</div>
          ) : (
            items.map((item) => {
              const fanout = fanoutByDecisionId.get(item.id);
              return (
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
                    {item.origin === "scheduled" && (
                      <span className="review-origin-chip">
                        <CalendarClock size={11} aria-hidden="true" />
                        {t("origin.scheduled", {
                          defaultValue: "Scheduled Agent",
                        })}
                      </span>
                    )}
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
                    {fanout && (
                      <span
                        className="review-fanout-chip"
                        title={t("fanout.title", {
                          index: fanout.index,
                          total: fanout.total,
                          source: item.ingestion.sourceName,
                        })}
                      >
                        {t("fanout.badge", {
                          index: fanout.index,
                          total: fanout.total,
                          source: item.ingestion.sourceName,
                        })}
                      </span>
                    )}
                    <span className="review-time">
                      {timeAgo(item.createdAt)}
                    </span>
                  </div>
                  {item.reason && (
                    <div className="review-item-reason">{item.reason}</div>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="review-detail">
          {detailLoading ? (
            <div className="review-empty">{t("loading")}</div>
          ) : detail ? (
            <ReviewDetail
              decision={detail}
              workspaceId={current.id}
              onApprove={handleApprove}
              onReject={handleReject}
              onUndo={handleUndo}
              onDecisionChanged={handleDecisionChanged}
            />
          ) : (
            <div className="review-empty">{t("selectItem")}</div>
          )}
        </div>
      </div>
    </PageShell>
  );
}
