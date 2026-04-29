import { useState, useEffect, useMemo, useCallback } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Bot,
  CalendarDays,
  Database,
  FilterX,
  MonitorCog,
  User,
} from "lucide-react";
import { useWorkspace } from "../hooks/use-workspace.js";
import { useTimeAgo } from "../hooks/use-time-ago.js";
import {
  activity as activityApi,
  type ActivityItem,
  type ActivityActorType,
  type ActivityEntityType,
  type ActivityListParams,
} from "../lib/api-client.js";
import { Badge, type BadgeTone } from "../components/ui/Badge.js";
import { PageShell } from "../components/ui/PageShell.js";

const ACTOR_OPTIONS: (ActivityActorType | "all")[] = [
  "all",
  "ai",
  "user",
  "system",
];
const ENTITY_OPTIONS: (ActivityEntityType | "all")[] = [
  "all",
  "page",
  "ingestion",
  "folder",
  "workspace",
  "decision",
];

const ACTIONS_BY_ENTITY: Record<string, string[]> = {
  page: [
    "create",
    "update",
    "append",
    "rollback",
    "publish",
    "unpublish",
    "delete",
    "restore",
    "purge",
    "reformat",
  ],
  ingestion: ["acknowledge", "reject"],
  folder: ["folder.create", "folder.update", "folder.delete"],
  workspace: ["workspace.create", "workspace.update", "member.add"],
  decision: ["edit_decision"],
};

const PAGE_SIZE = 50;

interface Filters {
  actorType: ActivityActorType | "all";
  entityType: ActivityEntityType | "all";
  action: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = {
  actorType: "all",
  entityType: "all",
  action: "",
  from: "",
  to: "",
};

function buildApiParams(filters: Filters, offset: number): ActivityListParams {
  const params: ActivityListParams = { limit: PAGE_SIZE, offset };
  if (filters.actorType !== "all") params.actorType = filters.actorType;
  if (filters.entityType !== "all") params.entityType = filters.entityType;
  if (filters.action) params.action = filters.action;
  if (filters.from) params.from = new Date(filters.from).toISOString();
  if (filters.to) params.to = new Date(filters.to).toISOString();
  return params;
}

export function ActivityPage() {
  const { t } = useTranslation(["activity", "common"]);
  const { current } = useWorkspace();
  const timeAgo = useTimeAgo();

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);

  const workspaceId = current?.id;

  const actionOptions = useMemo(() => {
    if (filters.entityType === "all") {
      return Array.from(
        new Set(Object.values(ACTIONS_BY_ENTITY).flat()),
      ).sort();
    }
    return ACTIONS_BY_ENTITY[filters.entityType] ?? [];
  }, [filters.entityType]);

  const load = useCallback(
    async (nextFilters: Filters, nextOffset: number, append: boolean) => {
      if (!workspaceId) return;
      setLoading(true);
      try {
        const res = await activityApi.list(
          workspaceId,
          buildApiParams(nextFilters, nextOffset),
        );
        setTotal(res.total);
        setOffset(nextOffset);
        setItems((prev) => (append ? [...prev, ...res.data] : res.data));
      } catch {
        if (!append) {
          setItems([]);
          setTotal(0);
        }
      } finally {
        setLoading(false);
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    load(filters, 0, false);
  }, [load, filters]);

  const updateFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((prev) => {
      const next = { ...prev, [key]: value };
      if (key === "entityType") {
        const allowed =
          value === "all" ? null : (ACTIONS_BY_ENTITY[value as string] ?? []);
        if (allowed && !allowed.includes(prev.action)) {
          next.action = "";
        }
      }
      return next;
    });
  };

  const resetFilters = () => setFilters(EMPTY_FILTERS);

  const hasMore = items.length < total;

  if (!current) return null;

  return (
    <PageShell
      className="activity-page"
      title={t("title")}
      description={t("subtitle")}
      actions={
        <Badge tone="warm" size="md">
          {t("total", { count: total })}
        </Badge>
      }
    >
      <div className="activity-filters">
        <label className="activity-filter">
          <span>{t("filters.actor.label")}</span>
          <select
            value={filters.actorType}
            onChange={(e) =>
              updateFilter(
                "actorType",
                e.target.value as ActivityActorType | "all",
              )
            }
          >
            {ACTOR_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {t(`filters.actor.${opt}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="activity-filter">
          <span>{t("filters.entity.label")}</span>
          <select
            value={filters.entityType}
            onChange={(e) =>
              updateFilter(
                "entityType",
                e.target.value as ActivityEntityType | "all",
              )
            }
          >
            {ENTITY_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {t(`filters.entity.${opt}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="activity-filter">
          <span>{t("filters.action.label")}</span>
          <select
            value={filters.action}
            onChange={(e) => updateFilter("action", e.target.value)}
          >
            <option value="">{t("filters.action.all")}</option>
            {actionOptions.map((a) => (
              <option key={a} value={a}>
                {t(`action.${a}`, { defaultValue: a })}
              </option>
            ))}
          </select>
        </label>
        <label className="activity-filter">
          <span>{t("filters.from")}</span>
          <input
            type="date"
            value={filters.from}
            onChange={(e) => updateFilter("from", e.target.value)}
          />
        </label>
        <label className="activity-filter">
          <span>{t("filters.to")}</span>
          <input
            type="date"
            value={filters.to}
            onChange={(e) => updateFilter("to", e.target.value)}
          />
        </label>
        <button
          type="button"
          className="activity-reset-btn"
          onClick={resetFilters}
        >
          <FilterX size={13} aria-hidden="true" />
          {t("filters.reset")}
        </button>
      </div>

      <div className="activity-timeline">
        {loading && items.length === 0 ? (
          <div className="activity-empty">{t("loading")}</div>
        ) : items.length === 0 ? (
          <div className="activity-empty">
            {filters.actorType === "all" &&
            filters.entityType === "all" &&
            !filters.action &&
            !filters.from &&
            !filters.to
              ? t("empty")
              : t("emptyFiltered")}
          </div>
        ) : (
          items.map((item) => (
            <ActivityRow key={item.id} item={item} timeAgo={timeAgo} />
          ))
        )}
      </div>

      {hasMore && (
        <button
          type="button"
          className="activity-load-more"
          onClick={() => load(filters, offset + PAGE_SIZE, true)}
          disabled={loading}
        >
          {loading ? t("loading") : t("loadMore")}
        </button>
      )}
    </PageShell>
  );
}

function actorBadge(item: ActivityItem, t: TFunction) {
  switch (item.actor.type) {
    case "ai":
      return {
        label: t("actor.ai"),
        tone: "blue" as BadgeTone,
        icon: <Bot size={11} />,
      };
    case "system":
      return {
        label: t("actor.system"),
        tone: "warm" as BadgeTone,
        icon: <MonitorCog size={11} />,
      };
    default:
      return {
        label: t("filters.actor.user"),
        tone: "teal" as BadgeTone,
        icon: <User size={11} />,
      };
  }
}

function ActivityRow({
  item,
  timeAgo,
}: {
  item: ActivityItem;
  timeAgo: (iso: string) => string;
}) {
  const { t } = useTranslation(["activity", "common"]);

  const actorLabel =
    item.actor.type === "ai"
      ? item.actor.aiModel
        ? t("actor.aiWithModel", { model: item.actor.aiModel.modelName })
        : t("actor.ai")
      : item.actor.type === "system"
        ? t("actor.system")
        : (item.actor.user?.name ?? t("actor.unknownUser"));

  const actionLabel = t(`action.${item.action}`, {
    defaultValue: item.action,
  });
  const actor = actorBadge(item, t);

  return (
    <div className={`activity-row activity-actor-${item.actor.type}`}>
      <div className="activity-row-marker" aria-hidden="true" />
      <div className="activity-row-main">
        <div className="activity-row-line">
          <Badge tone={actor.tone} size="sm" icon={actor.icon}>
            {actor.label}
          </Badge>
          <span className="activity-actor-name">{actorLabel}</span>
          <span className="activity-action">{actionLabel}</span>
          <EntityLink item={item} />
          <span
            className="activity-time"
            title={new Date(item.createdAt).toLocaleString()}
          >
            {timeAgo(item.createdAt)}
          </span>
        </div>
        {item.context.ingestion ? (
          <div className="activity-row-summary">
            <Database size={12} aria-hidden="true" />
            {t("fromIngestion", {
              source: item.context.ingestion.sourceName,
            })}
          </div>
        ) : (
          <div className="activity-row-summary">
            <CalendarDays size={12} aria-hidden="true" />
            {new Date(item.createdAt).toLocaleDateString()}
          </div>
        )}
      </div>
    </div>
  );
}

function EntityLink({ item }: { item: ActivityItem }) {
  const { t } = useTranslation(["activity", "common"]);

  if (!item.entity) return null;
  const label =
    item.entity.label ??
    (item.entity.type === "page"
      ? t("untitled")
      : t("fallbackEntity", { type: item.entity.type }));

  const deletedSuffix = item.entity.deleted ? " (deleted)" : "";

  if (item.entity.type === "page" && !item.entity.deleted) {
    return (
      <Link className="activity-entity-link" to={`/pages/${item.entity.id}`}>
        {label}
      </Link>
    );
  }

  if (item.entity.type === "ingestion") {
    return (
      <Link
        className="activity-entity-link"
        to={`/ingestions/${item.entity.id}`}
      >
        {label}
      </Link>
    );
  }

  return (
    <span
      className={`activity-entity-label${item.entity.deleted ? " deleted" : ""}`}
    >
      {label}
      {deletedSuffix}
    </span>
  );
}
