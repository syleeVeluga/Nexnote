import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  Database,
  ExternalLink,
  GitMerge,
  Inbox,
  Network,
  PauseCircle,
  RefreshCw,
  Rocket,
  Search,
  Sparkles,
} from "lucide-react";
import type {
  SystemPipelineQueueCounts,
  SystemPipelineStage,
  SystemPipelineStatus,
} from "@wekiflow/shared";
import { useTimeAgo } from "../hooks/use-time-ago.js";
import { useWorkspace } from "../hooks/use-workspace.js";
import {
  system as systemApi,
  type SystemPipelineDto,
} from "../lib/api-client.js";
import { Badge, type BadgeTone } from "../components/ui/Badge.js";
import { IconButton } from "../components/ui/IconButton.js";
import { PageShell } from "../components/ui/PageShell.js";
import { PipelineStage } from "../components/ui/PipelineStage.js";
import type { StatusTone } from "../components/ui/StatusDot.js";

const REFRESH_INTERVAL_MS = 10_000;

const STAGE_ICONS: Record<SystemPipelineStage["key"], ReactNode> = {
  receive: <Inbox size={15} />,
  classify: <Bot size={15} />,
  integrate: <GitMerge size={15} />,
  reformat: <Sparkles size={15} />,
  apply: <Rocket size={15} />,
  index: <Search size={15} />,
  connect: <Network size={15} />,
};

const COUNT_KEYS: Array<keyof SystemPipelineQueueCounts> = [
  "waiting",
  "active",
  "failed",
  "stalled",
  "delayed",
  "completed",
];

function statusTone(status: SystemPipelineStatus): StatusTone {
  switch (status) {
    case "busy":
      return "active";
    case "degraded":
      return "danger";
    case "paused":
      return "warning";
    default:
      return "success";
  }
}

function badgeTone(status: SystemPipelineStatus): BadgeTone {
  switch (status) {
    case "busy":
      return "blue";
    case "degraded":
      return "red";
    case "paused":
      return "orange";
    default:
      return "green";
  }
}

function statusIcon(status: SystemPipelineStatus): ReactNode {
  switch (status) {
    case "degraded":
      return <AlertTriangle size={12} />;
    case "paused":
      return <PauseCircle size={12} />;
    case "busy":
      return <Activity size={12} />;
    default:
      return <CheckCircle2 size={12} />;
  }
}

function workCount(stage: SystemPipelineStage): number {
  return stage.counts.waiting + stage.counts.active + stage.counts.delayed;
}

export function SystemStatusPage() {
  const { t } = useTranslation(["admin", "common"]);
  const { current } = useWorkspace();
  const timeAgo = useTimeAgo();
  const navigate = useNavigate();

  const [summary, setSummary] = useState<SystemPipelineDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const workspaceId = current?.id;
  const allowed = current?.role === "owner" || current?.role === "admin";

  const load = useCallback(async () => {
    if (!workspaceId || !allowed) return;
    setLoading(true);
    setError(null);
    try {
      const res = await systemApi.pipeline(workspaceId);
      setSummary(res);
      setLastUpdatedAt(new Date());
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("systemStatus.errors.loadFailed"),
      );
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }, [allowed, t, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh || !allowed) return;
    const id = window.setInterval(() => {
      void load();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [allowed, autoRefresh, load]);

  const receiveStage = useMemo(
    () => summary?.stages.find((stage) => stage.key === "receive") ?? null,
    [summary],
  );

  if (!current) return null;

  if (!allowed) {
    return (
      <PageShell
        className="system-page"
        title={t("systemStatus.title")}
        description={t("systemStatus.restrictedToAdmins")}
      >
        <div className="system-empty system-empty-restricted">
          <PauseCircle size={18} aria-hidden="true" />
          <span>{t("systemStatus.restrictedToAdmins")}</span>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      className="system-page"
      eyebrow={t("systemStatus.eyebrow")}
      title={t("systemStatus.title")}
      description={t("systemStatus.subtitle")}
      actions={
        <>
          <label className="system-auto-refresh">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            <span>{t("queueHealth.autoRefresh")}</span>
          </label>
          <IconButton
            icon={<RefreshCw size={15} />}
            label={t("queueHealth.refresh")}
            showLabel
            tone="quiet"
            onClick={() => void load()}
            disabled={loading}
          />
          <IconButton
            icon={<ExternalLink size={15} />}
            label={t("systemStatus.rawQueues")}
            showLabel
            tone="primary"
            onClick={() => navigate("/admin/queues")}
          />
        </>
      }
    >
      {error && <div className="system-error">{error}</div>}

      <section className="system-overview">
        <div className="system-overview-main">
          <span className="system-overview-icon" aria-hidden="true">
            {summary ? statusIcon(summary.overallStatus) : <Clock3 size={12} />}
          </span>
          <div>
            <p>{t("systemStatus.overall")}</p>
            <strong>
              {summary
                ? t(`systemStatus.status.${summary.overallStatus}`)
                : t("common:loading")}
            </strong>
          </div>
          {summary && (
            <Badge
              tone={badgeTone(summary.overallStatus)}
              size="md"
              icon={statusIcon(summary.overallStatus)}
            >
              {t(`systemStatus.status.${summary.overallStatus}`)}
            </Badge>
          )}
        </div>

        <div className="system-overview-metrics" aria-busy={loading}>
          <Metric
            icon={<Clock3 size={15} />}
            label={t("systemStatus.counts.waiting")}
            value={summary?.totals.waiting ?? 0}
          />
          <Metric
            icon={<Activity size={15} />}
            label={t("systemStatus.counts.active")}
            value={summary?.totals.active ?? 0}
          />
          <Metric
            icon={<AlertTriangle size={15} />}
            label={t("systemStatus.counts.failed")}
            value={summary?.totals.failed ?? 0}
            tone={(summary?.totals.failed ?? 0) > 0 ? "danger" : "neutral"}
          />
          <Metric
            icon={<Database size={15} />}
            label={t("systemStatus.pendingIngestions")}
            value={summary?.pendingIngestionCount ?? 0}
          />
        </div>
      </section>

      <section className="system-pipeline">
        <header className="system-section-header">
          <div>
            <h2>{t("systemStatus.pipelineTitle")}</h2>
            <p>
              {lastUpdatedAt
                ? t("queueHealth.lastUpdated") +
                  ": " +
                  lastUpdatedAt.toLocaleTimeString()
                : t("queueHealth.notUpdated")}
            </p>
          </div>
        </header>

        {summary ? (
          <div className="system-pipeline-strip">
            {summary.stages.map((stage) => (
              <PipelineStage
                key={stage.key}
                label={t(`systemStatus.stages.${stage.key}.short`, {
                  defaultValue: stage.label,
                })}
                count={workCount(stage)}
                status={statusTone(stage.status)}
                active={stage.status === "busy"}
                icon={STAGE_ICONS[stage.key]}
              />
            ))}
          </div>
        ) : (
          <div className="system-empty">{t("common:loading")}</div>
        )}
      </section>

      {summary && (
        <div className="system-details-grid">
          {summary.stages.map((stage) => (
            <StageDetail key={stage.key} stage={stage} />
          ))}
        </div>
      )}

      <section className="system-recent">
        <header className="system-section-header">
          <div>
            <h2>{t("systemStatus.recentTitle")}</h2>
            <p>{t("systemStatus.recentSubtitle")}</p>
          </div>
        </header>
        {!receiveStage || receiveStage.recentIngestions.length === 0 ? (
          <div className="system-empty">
            {t("systemStatus.noPendingIngestions")}
          </div>
        ) : (
          <div className="system-ingestion-list">
            {receiveStage.recentIngestions.map((ingestion) => (
              <Link
                key={ingestion.id}
                to={`/ingestions/${ingestion.id}`}
                className="system-ingestion-row"
              >
                <span className="system-ingestion-main">
                  <strong>{ingestion.titleHint ?? ingestion.sourceName}</strong>
                  <span>
                    {ingestion.sourceName} / {timeAgo(ingestion.receivedAt)}
                  </span>
                </span>
                <Badge
                  tone={ingestion.status === "processing" ? "blue" : "warm"}
                  size="sm"
                >
                  {t(`systemStatus.ingestionStatus.${ingestion.status}`, {
                    defaultValue: ingestion.status,
                  })}
                </Badge>
              </Link>
            ))}
          </div>
        )}
      </section>
    </PageShell>
  );
}

function Metric({
  icon,
  label,
  value,
  tone = "neutral",
}: {
  icon: ReactNode;
  label: string;
  value: number;
  tone?: "neutral" | "danger";
}) {
  return (
    <div className={`system-metric system-metric-${tone}`}>
      <span aria-hidden="true">{icon}</span>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

function StageDetail({ stage }: { stage: SystemPipelineStage }) {
  const { t } = useTranslation(["admin", "common"]);

  return (
    <article className={`system-stage-detail system-stage-${stage.status}`}>
      <header className="system-stage-header">
        <span className="system-stage-icon" aria-hidden="true">
          {STAGE_ICONS[stage.key]}
        </span>
        <div>
          <h3>
            {t(`systemStatus.stages.${stage.key}.label`, {
              defaultValue: stage.label,
            })}
          </h3>
          <p>
            {t(`systemStatus.stages.${stage.key}.description`, {
              defaultValue: stage.description,
            })}
          </p>
        </div>
        <Badge
          tone={badgeTone(stage.status)}
          size="sm"
          icon={statusIcon(stage.status)}
        >
          {t(`systemStatus.status.${stage.status}`)}
        </Badge>
      </header>

      <div className="system-stage-counts">
        {COUNT_KEYS.map((key) => (
          <span
            key={key}
            className={stage.counts[key] > 0 ? "non-zero" : undefined}
          >
            <small>{t(`systemStatus.counts.${key}`)}</small>
            <strong>{stage.counts[key]}</strong>
          </span>
        ))}
      </div>

      <footer className="system-stage-footer">
        <span>{stage.queueKeys.join(", ")}</span>
        <span>{stage.jobNames.join(", ")}</span>
      </footer>
    </article>
  );
}
