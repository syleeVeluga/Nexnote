import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CalendarClock,
  Edit2,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useWorkspace } from "../hooks/use-workspace.js";
import {
  scheduledAgent,
  type ScheduledRun,
  type ScheduledTask,
} from "../lib/api-client.js";
import { ConfirmDialog } from "../components/modals/ConfirmDialog.js";
import { Badge, type BadgeTone } from "../components/ui/Badge.js";
import { IconButton } from "../components/ui/IconButton.js";
import { PageShell } from "../components/ui/PageShell.js";
import { ManualRunModal } from "../components/scheduled/ManualRunModal.js";
import { RunTraceDrawer } from "../components/scheduled/RunTraceDrawer.js";
import { TaskFormModal } from "../components/scheduled/TaskFormModal.js";

function statusTone(status: ScheduledRun["status"]): BadgeTone {
  if (status === "running") return "blue";
  if (status === "failed") return "red";
  if (status === "partial") return "warm";
  return "green";
}

function durationLabel(run: ScheduledRun): string {
  if (!run.completedAt) return "-";
  const ms = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${ms} ms`;
  return `${Math.round(ms / 1000)} s`;
}

export function ScheduledAgentPage() {
  const { t } = useTranslation(["scheduledAgent", "common"]);
  const { current } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [runs, setRuns] = useState<ScheduledRun[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [manualRunOpen, setManualRunOpen] = useState(false);
  const [taskModal, setTaskModal] = useState<ScheduledTask | "new" | null>(null);
  const [deleteTask, setDeleteTask] = useState<ScheduledTask | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const workspaceId = current?.id;
  const canManageTasks =
    current?.role === "owner" || current?.role === "admin";
  const canRun =
    canManageTasks || current?.role === "editor";
  const selectedRunId = searchParams.get("run");
  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );
  const taskById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );

  const loadTasks = useCallback(async () => {
    if (!workspaceId || !canManageTasks) return;
    setLoadingTasks(true);
    setError(null);
    try {
      const res = await scheduledAgent.listTasks(workspaceId, { limit: 100 });
      setTasks(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.loadTasks"));
      setTasks([]);
    } finally {
      setLoadingTasks(false);
    }
  }, [canManageTasks, t, workspaceId]);

  const loadRuns = useCallback(async () => {
    if (!workspaceId || !canRun) return;
    setLoadingRuns(true);
    setError(null);
    try {
      const res = await scheduledAgent.listRuns(workspaceId, { limit: 30 });
      setRuns(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.loadRuns"));
      setRuns([]);
    } finally {
      setLoadingRuns(false);
    }
  }, [canRun, t, workspaceId]);

  useEffect(() => {
    void loadTasks();
    void loadRuns();
  }, [loadRuns, loadTasks]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function openRun(scheduledRunId: string) {
    setSearchParams({ run: scheduledRunId });
  }

  async function toggleTask(task: ScheduledTask) {
    if (!workspaceId) return;
    setBusyTaskId(task.id);
    setError(null);
    try {
      await scheduledAgent.updateTask(workspaceId, task.id, {
        enabled: !task.enabled,
      });
      await loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.updateTask"));
    } finally {
      setBusyTaskId(null);
    }
  }

  async function runTaskNow(task: ScheduledTask) {
    if (!workspaceId) return;
    setBusyTaskId(task.id);
    setError(null);
    try {
      const result = await scheduledAgent.triggerTask(workspaceId, task.id);
      await loadRuns();
      setNotice(t("notices.runQueued"));
      openRun(result.scheduledRunId);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.queueRunFailed"));
    } finally {
      setBusyTaskId(null);
    }
  }

  async function confirmDeleteTask() {
    if (!workspaceId || !deleteTask) return;
    setBusyTaskId(deleteTask.id);
    setError(null);
    try {
      await scheduledAgent.deleteTask(workspaceId, deleteTask.id);
      setDeleteTask(null);
      await loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.deleteTask"));
    } finally {
      setBusyTaskId(null);
    }
  }

  if (!current) return null;

  if (!canRun) {
    return (
      <PageShell
        className="scheduled-agent-page"
        title={t("title")}
        description={t("restrictedDescription")}
      >
        <div className="system-empty system-empty-restricted">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{t("restrictedRole")}</span>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      className="scheduled-agent-page"
      eyebrow={t("eyebrow")}
      title={t("title")}
      description={t("description")}
      actions={
        <>
          <IconButton
            icon={<RefreshCw size={15} />}
            label={t("actions.refresh")}
            showLabel
            tone="quiet"
            onClick={() => {
              void loadTasks();
              void loadRuns();
            }}
            disabled={loadingTasks || loadingRuns}
          />
          {current.scheduledEnabled && canManageTasks && (
            <IconButton
              icon={<Plus size={15} />}
              label={t("actions.newTask")}
              showLabel
              tone="primary"
              onClick={() => setTaskModal("new")}
            />
          )}
        </>
      }
    >
      {error && <div className="form-error">{error}</div>}
      {notice && <div className="scheduled-notice">{notice}</div>}

      {!current.scheduledEnabled ? (
        <section className="ai-settings-panel scheduled-disabled-panel">
          <header className="ai-settings-panel-header">
            <span className="system-overview-icon" aria-hidden="true">
              <CalendarClock size={17} />
            </span>
            <div>
              <h2>{t("disabled.title")}</h2>
              <p>{t("disabled.description")}</p>
            </div>
          </header>
          <Link to="/settings/ai" className="wiki-section-link">
            {t("disabled.settingsLink")}
          </Link>
        </section>
      ) : (
        <>
          {canManageTasks && (
            <section className="scheduled-section">
              <header className="scheduled-section-header">
                <div>
                  <h2>{t("tasks.title")}</h2>
                  <p>{t("tasks.description")}</p>
                </div>
                <IconButton
                  icon={<Plus size={15} />}
                  label={t("actions.newTask")}
                  showLabel
                  tone="quiet"
                  onClick={() => setTaskModal("new")}
                />
              </header>

              <div className="scheduled-table">
                <div className="scheduled-table-row scheduled-table-head">
                  <span>{t("tasks.enabled")}</span>
                  <span>{t("tasks.name")}</span>
                  <span>{t("tasks.cron")}</span>
                  <span>{t("tasks.targets")}</span>
                  <span>{t("tasks.nextRun")}</span>
                  <span>{t("tasks.actions")}</span>
                </div>
                {loadingTasks ? (
                  <div className="system-empty">{t("common:loading")}</div>
                ) : tasks.length === 0 ? (
                  <div className="system-empty">{t("tasks.empty")}</div>
                ) : (
                  tasks.map((task) => (
                    <div key={task.id} className="scheduled-table-row">
                      <span>
                        <label className="scheduled-switch">
                          <input
                            type="checkbox"
                            checked={task.enabled}
                            disabled={busyTaskId === task.id}
                            onChange={() => void toggleTask(task)}
                          />
                          <span>
                            {task.enabled ? t("values.on") : t("values.off")}
                          </span>
                        </label>
                      </span>
                      <span>
                        <strong>{task.name}</strong>
                      </span>
                      <code>{task.cronExpression}</code>
                      <span>{task.targetPageIds.length}</span>
                      <span>
                        {task.nextRunAt
                          ? new Date(task.nextRunAt).toLocaleString()
                          : "-"}
                      </span>
                      <span className="scheduled-row-actions">
                        <IconButton
                          icon={<Edit2 size={14} />}
                          label={t("actions.edit")}
                          size="sm"
                          onClick={() => setTaskModal(task)}
                        />
                        <IconButton
                          icon={<Play size={14} />}
                          label={t("actions.runNow")}
                          size="sm"
                          tone="quiet"
                          disabled={busyTaskId === task.id}
                          onClick={() => void runTaskNow(task)}
                        />
                        <IconButton
                          icon={<Trash2 size={14} />}
                          label={t("actions.delete")}
                          size="sm"
                          tone="danger"
                          disabled={busyTaskId === task.id}
                          onClick={() => setDeleteTask(task)}
                        />
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>
          )}

          <section className="scheduled-section">
            <header className="scheduled-section-header">
              <div>
                <h2>{t("runs.title")}</h2>
                <p>{t("runs.description")}</p>
              </div>
              <IconButton
                icon={<Play size={15} />}
                label={t("actions.manualRun")}
                showLabel
                tone="quiet"
                onClick={() => setManualRunOpen(true)}
              />
            </header>

            <div className="scheduled-runs-table">
              <div className="scheduled-runs-row scheduled-table-head">
                <span>{t("runs.triggeredBy")}</span>
                <span>{t("runs.task")}</span>
                <span>{t("runs.status")}</span>
                <span>{t("runs.decisions")}</span>
                <span>{t("runs.tokens")}</span>
                <span>{t("runs.cost")}</span>
                <span>{t("runs.started")}</span>
                <span>{t("runs.duration")}</span>
                <span>{t("runs.trace")}</span>
              </div>
              {loadingRuns ? (
                <div className="system-empty">{t("common:loading")}</div>
              ) : runs.length === 0 ? (
                <div className="system-empty">{t("runs.empty")}</div>
              ) : (
                runs.map((run) => (
                  <div key={run.id} className="scheduled-runs-row">
                    <span>{t(`triggeredBy.${run.triggeredBy}`)}</span>
                    <span>{run.taskId ? taskById.get(run.taskId)?.name ?? "-" : "-"}</span>
                    <Badge tone={statusTone(run.status)} size="sm">
                      {run.status}
                    </Badge>
                    <span>{run.decisionCount}</span>
                    <span>{(run.tokensIn + run.tokensOut).toLocaleString()}</span>
                    <span>${Number(run.costUsd).toFixed(4)}</span>
                    <span>{new Date(run.startedAt).toLocaleString()}</span>
                    <span>{durationLabel(run)}</span>
                    <span>
                      <IconButton
                        icon={<CalendarClock size={14} />}
                        label={t("actions.viewTrace")}
                        size="sm"
                        tone="quiet"
                        onClick={() => openRun(run.id)}
                      />
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}

      <ManualRunModal
        open={manualRunOpen}
        workspaceId={current.id}
        maxPageLimit={current.scheduledPerRunPageLimit}
        onClose={() => setManualRunOpen(false)}
        onQueued={(scheduledRunId) => {
          setManualRunOpen(false);
          setNotice(t("notices.runQueued"));
          void loadRuns();
          openRun(scheduledRunId);
        }}
      />

      <TaskFormModal
        open={taskModal != null}
        workspaceId={current.id}
        task={taskModal === "new" ? null : taskModal}
        maxPageLimit={current.scheduledPerRunPageLimit}
        onClose={() => setTaskModal(null)}
        onSaved={() => {
          setTaskModal(null);
          void loadTasks();
        }}
      />

      <ConfirmDialog
        open={deleteTask != null}
        title={t("deleteTask.title")}
        message={t("deleteTask.message", {
          name: deleteTask?.name ?? "",
        })}
        confirmLabel={t("actions.delete")}
        onConfirm={confirmDeleteTask}
        onCancel={() => setDeleteTask(null)}
        busy={deleteTask != null && busyTaskId === deleteTask.id}
      />

      <RunTraceDrawer
        open={selectedRunId != null}
        workspaceId={current.id}
        run={selectedRun}
        onClose={() => setSearchParams({})}
        onRefreshRun={loadRuns}
      />
    </PageShell>
  );
}
