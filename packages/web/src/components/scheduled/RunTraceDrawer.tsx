import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  agentRuns,
  type AgentRunDto,
  type ScheduledRun,
} from "../../lib/api-client.js";
import { AgentTracePanel } from "../agents/AgentTracePanel.js";
import { Badge } from "../ui/Badge.js";
import { IconButton } from "../ui/IconButton.js";

interface RunTraceDrawerProps {
  open: boolean;
  workspaceId: string;
  run: ScheduledRun | null;
  onClose: () => void;
  onRefreshRun: () => void;
}

export function RunTraceDrawer({
  open,
  workspaceId,
  run,
  onClose,
  onRefreshRun,
}: RunTraceDrawerProps) {
  const { t } = useTranslation("scheduledAgent");
  const [agentRun, setAgentRun] = useState<AgentRunDto | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || run?.agentRunId) return;
    const interval = window.setInterval(onRefreshRun, 2500);
    return () => window.clearInterval(interval);
  }, [onRefreshRun, open, run?.agentRunId]);

  useEffect(() => {
    if (!open || !run?.agentRunId) {
      setAgentRun(null);
      return;
    }
    let cancelled = false;
    setStreamError(null);
    agentRuns
      .get(workspaceId, run.agentRunId)
      .then((res) => {
        if (!cancelled) setAgentRun(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setStreamError(
            err instanceof Error ? err.message : t("trace.loadFailed"),
          );
        }
      });

    const stop = agentRuns.stream(workspaceId, run.agentRunId, {
      onSnapshot: setAgentRun,
      onStatus: setAgentRun,
      onStep: (step) => {
        setAgentRun((current) =>
          current
            ? {
                ...current,
                steps: [
                  ...current.steps.filter((item) => item.step !== step.step),
                  step,
                ],
              }
            : current,
        );
      },
      onError: setStreamError,
    });

    return () => {
      cancelled = true;
      stop();
    };
  }, [open, run?.agentRunId, t, workspaceId]);

  if (!open) return null;

  return (
    <aside className="scheduled-trace-drawer" aria-label={t("trace.title")}>
      <div className="scheduled-trace-backdrop" onClick={onClose} />
      <div className="scheduled-trace-panel">
        <header className="scheduled-trace-top">
          <div>
            <h3>{t("trace.title")}</h3>
            {run && (
              <p>
                {new Date(run.startedAt).toLocaleString()} ·{" "}
                {run.decisionCount} {t("runs.decisions")}
              </p>
            )}
          </div>
          <div className="scheduled-trace-actions">
            {run && <Badge size="sm">{run.status}</Badge>}
            <IconButton
              icon={<X size={15} />}
              label={t("trace.close")}
              onClick={onClose}
            />
          </div>
        </header>

        {!run ? (
          <div className="system-empty">{t("trace.missingRun")}</div>
        ) : !run.agentRunId ? (
          <div className="system-empty">{t("trace.waitingForAgentRun")}</div>
        ) : (
          <AgentTracePanel agentRun={agentRun} streamError={streamError} />
        )}
      </div>
    </aside>
  );
}
