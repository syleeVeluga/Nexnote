import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspace } from "../hooks/use-workspace.js";
import { useTimeAgo } from "../hooks/use-time-ago.js";
import {
  adminQueues,
  QUEUE_KEYS,
  type QueueKey,
  type QueueSummary,
  type FailedJob,
} from "../lib/api-client.js";

type JobTab = "failed" | "stalled";

export function QueueHealthPage() {
  const { t } = useTranslation(["admin", "common"]);
  const { current } = useWorkspace();
  const timeAgo = useTimeAgo();

  const [summaries, setSummaries] = useState<QueueSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedQueue, setSelectedQueue] = useState<QueueKey>("ingestion");
  const [jobTab, setJobTab] = useState<JobTab>("failed");
  const [jobs, setJobs] = useState<FailedJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const workspaceId = current?.id;
  const role = current?.role;
  const allowed = role === "owner" || role === "admin";

  const loadSummaries = useCallback(async () => {
    if (!workspaceId || !allowed) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await adminQueues.overview(workspaceId);
      setSummaries(res.queues);
    } catch (err) {
      setSummaries([]);
      setLoadError(
        err instanceof Error ? err.message : t("queueHealth.errors.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [workspaceId, allowed, t]);

  const loadJobs = useCallback(async () => {
    if (!workspaceId || !allowed) return;
    setJobsLoading(true);
    try {
      const res =
        jobTab === "failed"
          ? await adminQueues.failed(workspaceId, selectedQueue)
          : await adminQueues.stalled(workspaceId, selectedQueue);
      setJobs(res.items);
    } catch {
      setJobs([]);
    } finally {
      setJobsLoading(false);
    }
  }, [workspaceId, allowed, jobTab, selectedQueue]);

  useEffect(() => {
    loadSummaries();
  }, [loadSummaries]);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      loadSummaries();
      loadJobs();
    }, 10_000);
    return () => window.clearInterval(id);
  }, [autoRefresh, loadSummaries, loadJobs]);

  const handleRetry = useCallback(
    async (job: FailedJob) => {
      if (!workspaceId || !job.id) return;
      try {
        await adminQueues.retry(workspaceId, selectedQueue, job.id);
        await Promise.all([loadSummaries(), loadJobs()]);
      } catch (err) {
        window.alert(
          err instanceof Error
            ? err.message
            : t("queueHealth.errors.retryFailed"),
        );
      }
    },
    [workspaceId, selectedQueue, loadSummaries, loadJobs, t],
  );

  const handleRemove = useCallback(
    async (job: FailedJob) => {
      if (!workspaceId || !job.id) return;
      if (!window.confirm(t("queueHealth.actions.removeConfirm"))) return;
      try {
        await adminQueues.remove(workspaceId, selectedQueue, job.id);
        await Promise.all([loadSummaries(), loadJobs()]);
      } catch (err) {
        window.alert(
          err instanceof Error
            ? err.message
            : t("queueHealth.errors.removeFailed"),
        );
      }
    },
    [workspaceId, selectedQueue, loadSummaries, loadJobs, t],
  );

  if (!current) return null;

  if (!allowed) {
    return (
      <div className="queue-page">
        <div className="queue-empty">{t("queueHealth.restrictedToAdmins")}</div>
      </div>
    );
  }

  return (
    <div className="queue-page">
      <div className="queue-header">
        <div>
          <h1>{t("queueHealth.title")}</h1>
          <p className="queue-subtitle">{t("queueHealth.subtitle")}</p>
        </div>
        <div className="queue-header-actions">
          <label className="queue-auto-refresh">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            <span>{t("queueHealth.autoRefresh")}</span>
          </label>
          <button
            className="btn"
            onClick={() => {
              loadSummaries();
              loadJobs();
            }}
            disabled={loading}
          >
            {t("queueHealth.refresh")}
          </button>
        </div>
      </div>

      {loadError && <div className="queue-error">{loadError}</div>}

      <div className="queue-cards">
        {QUEUE_KEYS.map((key) => {
          const summary = summaries.find((s) => s.key === key);
          const isSelected = selectedQueue === key;
          const counts = summary?.counts;
          const failing = (counts?.failed ?? 0) > 0;
          const stalling = (counts?.stalled ?? 0) > 0;
          return (
            <button
              key={key}
              className={`queue-card${isSelected ? " selected" : ""}${
                failing ? " has-failed" : ""
              }${stalling ? " has-stalled" : ""}`}
              onClick={() => setSelectedQueue(key)}
            >
              <div className="queue-card-head">
                <span className="queue-card-name">{key}</span>
                {summary?.isPaused ? (
                  <span className="queue-state paused">
                    {t("queueHealth.paused")}
                  </span>
                ) : (
                  <span className="queue-state running">
                    {t("queueHealth.running")}
                  </span>
                )}
              </div>
              <div className="queue-card-grid">
                {(
                  [
                    "waiting",
                    "active",
                    "failed",
                    "delayed",
                    "stalled",
                    "completed",
                  ] as const
                ).map((metric) => (
                  <div
                    key={metric}
                    className={`queue-metric metric-${metric}${
                      (counts?.[metric] ?? 0) > 0 ? " non-zero" : ""
                    }`}
                  >
                    <span className="queue-metric-label">
                      {t(`queueHealth.counts.${metric}`)}
                    </span>
                    <span className="queue-metric-value">
                      {counts?.[metric] ?? (loading ? "…" : 0)}
                    </span>
                  </div>
                ))}
              </div>
            </button>
          );
        })}
      </div>

      <div className="queue-jobs">
        <div className="queue-jobs-header">
          <div className="queue-jobs-tabs">
            {(["failed", "stalled"] as const).map((tab) => (
              <button
                key={tab}
                className={`queue-jobs-tab${jobTab === tab ? " active" : ""}`}
                onClick={() => setJobTab(tab)}
              >
                {t(`queueHealth.tabs.${tab}`)}
              </button>
            ))}
          </div>
          <span className="queue-jobs-selected">{selectedQueue}</span>
        </div>

        <div className="queue-jobs-body">
          {jobsLoading ? (
            <div className="queue-empty">{t("common:loading")}</div>
          ) : jobs.length === 0 ? (
            <div className="queue-empty">
              {jobTab === "failed"
                ? t("queueHealth.emptyFailed")
                : t("queueHealth.emptyStalled")}
            </div>
          ) : (
            <ul className="queue-job-list">
              {jobs.map((job) => {
                const crossWorkspace =
                  job.workspaceId !== null && job.workspaceId !== workspaceId;
                const timestamp =
                  jobTab === "failed" ? job.finishedOn : job.processedOn;
                return (
                  <li key={job.id ?? Math.random()} className="queue-job-item">
                    <div className="queue-job-top">
                      <span className="queue-job-name">{job.name}</span>
                      <span className="queue-job-attempts">
                        {t("queueHealth.job.attempts")}: {job.attemptsMade}
                        {job.maxAttempts != null && ` / ${job.maxAttempts}`}
                      </span>
                      <span className="queue-job-time">
                        {jobTab === "failed"
                          ? t("queueHealth.job.failedAt")
                          : t("queueHealth.job.startedAt")}{" "}
                        {timeAgo(timestamp)}
                      </span>
                    </div>
                    <div className="queue-job-reason">
                      {job.failedReason ?? t("queueHealth.job.noReason")}
                    </div>
                    {job.stackFirstLine && (
                      <pre className="queue-job-stack">{job.stackFirstLine}</pre>
                    )}
                    <div className="queue-job-meta">
                      {job.ingestionId && (
                        <span>
                          {t("queueHealth.job.ingestion")}:{" "}
                          <code>{job.ingestionId.slice(0, 8)}</code>
                        </span>
                      )}
                      {job.pageId && (
                        <span>
                          {t("queueHealth.job.page")}:{" "}
                          <code>{job.pageId.slice(0, 8)}</code>
                        </span>
                      )}
                      {crossWorkspace && (
                        <span className="queue-job-cross">
                          {t("queueHealth.job.crossWorkspace")}
                        </span>
                      )}
                    </div>
                    <div className="queue-job-actions">
                      <button
                        className="btn"
                        onClick={() => handleRetry(job)}
                        disabled={!job.id || crossWorkspace}
                      >
                        {t("queueHealth.job.retry")}
                      </button>
                      <button
                        className="btn btn-danger"
                        onClick={() => handleRemove(job)}
                        disabled={!job.id || crossWorkspace}
                      >
                        {t("queueHealth.job.remove")}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
