import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  FileText,
  Folder,
  Inbox,
  Plus,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import { useAuth } from "../hooks/use-auth.js";
import { useTimeAgo } from "../hooks/use-time-ago.js";
import { useWorkspace } from "../hooks/use-workspace.js";
import {
  dashboard as dashboardApi,
  type DashboardDto,
  type DecisionListItem,
  type Page,
} from "../lib/api-client.js";
import { Badge } from "../components/ui/Badge.js";
import { IconButton } from "../components/ui/IconButton.js";
import { PageShell } from "../components/ui/PageShell.js";

const EMPTY_DASHBOARD: DashboardDto = {
  counts: {
    pages: 0,
    folders: 0,
    pendingDecisions: 0,
    autoAppliedToday: 0,
    failedDecisions: 0,
  },
  pendingPreview: [],
  recentAutoApplied: [],
  folders: [],
  rootPages: [],
  recentAiPages: [],
};

function decisionTitle(item: DecisionListItem): string {
  return (
    item.targetPage?.title ??
    item.proposedPageTitle ??
    item.ingestion.titleHint ??
    item.ingestion.sourceName
  );
}

function confidenceLabel(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function latestAiDate(page: Page): string | null {
  if (page.latestRevisionActorType === "ai" && page.latestRevisionCreatedAt) {
    return page.latestRevisionCreatedAt;
  }
  if (!page.lastAiUpdatedAt) return null;
  if (!page.lastHumanEditedAt) return page.lastAiUpdatedAt;
  return page.lastAiUpdatedAt >= page.lastHumanEditedAt
    ? page.lastAiUpdatedAt
    : null;
}

export function DashboardPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { current } = useWorkspace();
  const { user } = useAuth();
  const navigate = useNavigate();
  const timeAgo = useTimeAgo();
  const [data, setData] = useState<DashboardDto>(EMPTY_DASHBOARD);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    setLoading(true);

    dashboardApi
      .get(current.id)
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch(() => {
        if (cancelled) return;
        setData(EMPTY_DASHBOARD);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [current]);

  const folderSummaries = useMemo(() => {
    return data.folders
      .map((item) => {
        const latestUpdatedAt = item.pages
          .map((page) => page.updatedAt)
          .sort()
          .at(-1);
        return {
          folder: item.folder,
          pageCount: item.pageCount,
          latestUpdatedAt: latestUpdatedAt ?? item.folder.updatedAt,
        };
      })
      .sort((a, b) => b.latestUpdatedAt.localeCompare(a.latestUpdatedAt))
      .slice(0, 5);
  }, [data.folders]);

  const aiTouchedPages = useMemo(() => {
    return data.recentAiPages
      .map((page) => ({ page, aiDate: latestAiDate(page) }))
      .filter((item): item is { page: Page; aiDate: string } => !!item.aiDate)
      .sort((a, b) => b.aiDate.localeCompare(a.aiDate))
      .slice(0, 5);
  }, [data.recentAiPages]);

  const rootPages = useMemo(() => {
    return [...data.rootPages]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 5);
  }, [data.rootPages]);

  if (!current) return null;

  const firstName = user?.name?.trim().split(/\s+/)[0] || current.name;
  const pendingCount = data.counts.pendingDecisions;
  const autoAppliedToday = data.counts.autoAppliedToday;
  const failedCount = data.counts.failedDecisions;

  return (
    <PageShell
      className="dashboard-page"
      eyebrow={t("eyebrow")}
      title={t("greeting", { name: firstName })}
      description={t("description")}
      actions={
        <>
          <IconButton
            icon={<UploadCloud size={15} />}
            label={t("importAction")}
            showLabel
            tone="quiet"
            onClick={() => navigate("/import")}
          />
          <IconButton
            icon={<Plus size={15} />}
            label={t("common:newPage")}
            showLabel
            tone="primary"
            onClick={() => navigate("/pages/new")}
          />
        </>
      }
    >
      <div className="dashboard-metrics" aria-busy={loading}>
        <MetricCard
          icon={<CheckCircle2 size={18} />}
          label={t("metrics.autoApplied")}
          value={autoAppliedToday}
          detail={t("metrics.autoAppliedDetail")}
          tone="teal"
        />
        <MetricCard
          icon={<Inbox size={18} />}
          label={t("metrics.pending")}
          value={pendingCount}
          detail={t("metrics.pendingDetail")}
          tone={pendingCount > 0 ? "orange" : "green"}
        />
        <MetricCard
          icon={<FileText size={18} />}
          label={t("metrics.pages")}
          value={data.counts.pages}
          detail={t("metrics.pagesDetail", { count: data.counts.folders })}
          tone="blue"
        />
        <MetricCard
          icon={<Activity size={18} />}
          label={t("metrics.failed")}
          value={failedCount}
          detail={t("metrics.failedDetail")}
          tone={failedCount > 0 ? "red" : "warm"}
        />
      </div>

      <div className="dashboard-grid">
        <section className="dashboard-panel">
          <PanelHeader
            icon={<Inbox size={16} />}
            title={t("pending.title")}
            to="/review"
          />
          {data.pendingPreview.length === 0 ? (
            <EmptyPanel
              title={t("pending.emptyTitle")}
              body={t("pending.emptyBody")}
            />
          ) : (
            <div className="dashboard-decision-list">
              {data.pendingPreview.map((item) => (
                <Link
                  key={item.id}
                  to={`/ingestions/${item.ingestionId}`}
                  className="dashboard-decision"
                >
                  <span className="dashboard-decision-main">
                    <span className="dashboard-decision-title">
                      {decisionTitle(item)}
                    </span>
                    <span className="dashboard-decision-meta">
                      {item.ingestion.sourceName} · {timeAgo(item.createdAt)}
                    </span>
                  </span>
                  <Badge tone={item.status === "suggested" ? "teal" : "orange"} size="sm">
                    {confidenceLabel(item.confidence)}
                  </Badge>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="dashboard-panel">
          <PanelHeader
            icon={<Bot size={16} />}
            title={t("autoApplied.title")}
            to="/review"
          />
          {data.recentAutoApplied.length === 0 ? (
            <EmptyPanel
              title={t("autoApplied.emptyTitle")}
              body={t("autoApplied.emptyBody")}
            />
          ) : (
            <div className="dashboard-decision-list">
              {data.recentAutoApplied.map((item) => (
                <Link
                  key={item.id}
                  to={
                    item.targetPage
                      ? `/pages/${item.targetPage.id}`
                      : `/ingestions/${item.ingestionId}`
                  }
                  className="dashboard-decision"
                >
                  <span className="dashboard-decision-main">
                    <span className="dashboard-decision-title">
                      {decisionTitle(item)}
                    </span>
                    <span className="dashboard-decision-meta">
                      {item.ingestion.sourceName} · {timeAgo(item.createdAt)}
                    </span>
                  </span>
                  <Badge tone="green" size="sm">
                    {item.action}
                  </Badge>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="dashboard-panel dashboard-wide-panel">
        <PanelHeader
          icon={<Folder size={16} />}
          title={t("wiki.title")}
          to="/wiki"
        />
        <div className="dashboard-wiki-grid">
          <div className="dashboard-folder-list">
            <h2>{t("wiki.folders")}</h2>
            {folderSummaries.length === 0 ? (
              <p className="dashboard-muted">{t("wiki.noFolders")}</p>
            ) : (
              folderSummaries.map(({ folder, pageCount, latestUpdatedAt }) => (
                <div key={folder.id} className="dashboard-folder-row">
                  <span className="dashboard-folder-icon" aria-hidden="true">
                    <Folder size={15} />
                  </span>
                  <span className="dashboard-folder-main">
                    <span>{folder.name}</span>
                    <small>
                      {t("wiki.pageCount", { count: pageCount })} ·{" "}
                      {timeAgo(latestUpdatedAt)}
                    </small>
                  </span>
                </div>
              ))
            )}
          </div>

          <div className="dashboard-page-list">
            <h2>{t("wiki.recentRootPages")}</h2>
            {rootPages.length === 0 ? (
              <p className="dashboard-muted">{t("wiki.noPages")}</p>
            ) : (
              rootPages.map((page) => (
                <Link
                  key={page.id}
                  to={`/pages/${page.id}`}
                  className="dashboard-page-row"
                >
                  <FileText size={15} aria-hidden="true" />
                  <span>{page.title || t("common:untitled")}</span>
                  <small>{timeAgo(page.updatedAt)}</small>
                </Link>
              ))
            )}
          </div>

          <div className="dashboard-page-list">
            <h2>{t("wiki.aiTouched")}</h2>
            {aiTouchedPages.length === 0 ? (
              <p className="dashboard-muted">{t("wiki.noAiTouched")}</p>
            ) : (
              aiTouchedPages.map(({ page, aiDate }) => (
                <Link
                  key={page.id}
                  to={`/pages/${page.id}`}
                  className="dashboard-page-row"
                >
                  <Sparkles size={15} aria-hidden="true" />
                  <span>{page.title || t("common:untitled")}</span>
                  <small>{timeAgo(aiDate)}</small>
                </Link>
              ))
            )}
          </div>
        </div>
      </section>
    </PageShell>
  );
}

function MetricCard({
  icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  detail: string;
  tone: "warm" | "blue" | "teal" | "green" | "orange" | "red";
}) {
  return (
    <article className={`dashboard-metric dashboard-metric-${tone}`}>
      <span className="dashboard-metric-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="dashboard-metric-label">{label}</span>
      <strong>{value}</strong>
      <span className="dashboard-metric-detail">{detail}</span>
    </article>
  );
}

function PanelHeader({
  icon,
  title,
  to,
}: {
  icon: ReactNode;
  title: string;
  to: string;
}) {
  return (
    <header className="dashboard-panel-header">
      <div className="dashboard-panel-title">
        <span aria-hidden="true">{icon}</span>
        <h2>{title}</h2>
      </div>
      <Link to={to} className="dashboard-panel-link" aria-label={title}>
        <ArrowRight size={15} aria-hidden="true" />
      </Link>
    </header>
  );
}

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="dashboard-empty-panel">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}
