import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bot,
  Gauge,
  RefreshCw,
  Save,
  Settings2,
  ShieldAlert,
} from "lucide-react";
import { type IngestionMode } from "@wekiflow/shared";
import { useWorkspace } from "../hooks/use-workspace.js";
import {
  agentRuns as agentRunsApi,
  workspaces as workspacesApi,
  type AgentDiagnostics,
} from "../lib/api-client.js";
import { PageShell } from "../components/ui/PageShell.js";
import { Badge } from "../components/ui/Badge.js";
import { IconButton } from "../components/ui/IconButton.js";

const INGESTION_MODES: IngestionMode[] = ["classic", "shadow", "agent"];

function percent(value: number | null): string {
  if (value == null) return "n/a";
  return `${Math.round(value * 100)}%`;
}

function modeLabel(mode: IngestionMode): string {
  if (mode === "classic") return "Classic";
  if (mode === "shadow") return "Shadow";
  return "Agent";
}

export function AISettingsPage() {
  const { current, refresh } = useWorkspace();
  const [mode, setMode] = useState<IngestionMode>("classic");
  const [instructions, setInstructions] = useState("");
  const [diagnostics, setDiagnostics] = useState<AgentDiagnostics | null>(null);
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const workspaceId = current?.id;
  const canManage = current?.role === "owner" || current?.role === "admin";

  useEffect(() => {
    if (!current) return;
    setMode(current.ingestionMode);
    setInstructions(current.agentInstructions ?? "");
  }, [current]);

  const loadDiagnostics = useCallback(async () => {
    if (!workspaceId || !canManage) return;
    setLoadingDiagnostics(true);
    setError(null);
    try {
      const res = await agentRunsApi.diagnostics(workspaceId, {
        sinceDays: 7,
      });
      setDiagnostics(res);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load diagnostics",
      );
    } finally {
      setLoadingDiagnostics(false);
    }
  }, [canManage, workspaceId]);

  useEffect(() => {
    void loadDiagnostics();
  }, [loadDiagnostics]);

  const tokenPercent = useMemo(() => {
    if (!diagnostics?.dailyTokenUsage.cap) return 0;
    return Math.min(
      100,
      Math.round(
        (diagnostics.dailyTokenUsage.used / diagnostics.dailyTokenUsage.cap) *
          100,
      ),
    );
  }, [diagnostics]);

  async function save() {
    if (!workspaceId || !canManage) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await workspacesApi.update(workspaceId, {
        ingestionMode: mode,
        agentInstructions: instructions.trim() || null,
      });
      await refresh();
      await loadDiagnostics();
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  if (!current) return null;

  if (!canManage) {
    return (
      <PageShell
        className="ai-settings-page"
        title="AI Settings"
        description="Only workspace owners and admins can change ingestion agent settings."
      >
        <div className="system-empty system-empty-restricted">
          <ShieldAlert size={16} aria-hidden="true" />
          <span>Insufficient workspace role.</span>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      className="ai-settings-page"
      eyebrow="Ingestion agent"
      title="AI Settings"
      description="Tune workspace-level agent behavior and watch shadow parity before promotion."
      actions={
        <>
          {saved && <Badge tone="green">Saved</Badge>}
          <IconButton
            icon={<RefreshCw size={15} />}
            label="Refresh diagnostics"
            showLabel
            tone="quiet"
            onClick={() => void loadDiagnostics()}
            disabled={loadingDiagnostics}
          />
          <IconButton
            icon={<Save size={15} />}
            label={saving ? "Saving..." : "Save"}
            showLabel
            tone="primary"
            onClick={() => void save()}
            disabled={saving}
          />
        </>
      }
    >
      {error && <div className="system-error">{error}</div>}

      <section className="ai-settings-grid">
        <div className="ai-settings-panel">
          <header className="ai-settings-panel-header">
            <span className="system-overview-icon" aria-hidden="true">
              <Settings2 size={17} />
            </span>
            <div>
              <h2>Workspace mode</h2>
              <p>Classic owns production until shadow parity is acceptable.</p>
            </div>
          </header>
          <div className="ai-mode-control">
            {INGESTION_MODES.map((item) => (
              <button
                key={item}
                type="button"
                className={mode === item ? "active" : ""}
                onClick={() => setMode(item)}
              >
                {modeLabel(item)}
              </button>
            ))}
          </div>
        </div>

        <div className="ai-settings-panel">
          <header className="ai-settings-panel-header">
            <span className="system-overview-icon" aria-hidden="true">
              <Gauge size={17} />
            </span>
            <div>
              <h2>Daily token cap</h2>
              <p>Agent plan calls stop once the workspace reaches the cap.</p>
            </div>
          </header>
          <div className="ai-token-meter">
            <div>
              <strong>
                {(diagnostics?.dailyTokenUsage.used ?? 0).toLocaleString()}
              </strong>
              <span>
                / {(diagnostics?.dailyTokenUsage.cap ?? 0).toLocaleString()}{" "}
                tokens
              </span>
            </div>
            <div className="ai-token-bar" aria-label="Daily token usage">
              <span style={{ width: `${tokenPercent}%` }} />
            </div>
          </div>
        </div>
      </section>

      <section className="ai-settings-panel ai-instructions-panel">
        <header className="ai-settings-panel-header">
          <span className="system-overview-icon" aria-hidden="true">
            <Bot size={17} />
          </span>
          <div>
            <h2>Agent instructions</h2>
            <p>Prepended to every explore and plan turn for this workspace.</p>
          </div>
        </header>
        <textarea
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          rows={9}
          maxLength={20_000}
          placeholder={`Engineering RFCs always live under /docs/engineering/rfcs/.
Slack #incidents sources update existing incident pages; do not create new ones.
"PdM" means product manager.`}
        />
        <footer>{instructions.length.toLocaleString()} / 20,000</footer>
      </section>

      <section className="ai-settings-panel">
        <header className="ai-settings-panel-header">
          <span className="system-overview-icon" aria-hidden="true">
            <Gauge size={17} />
          </span>
          <div>
            <h2>Shadow parity</h2>
            <p>
              Agreement compares the latest agent plan to classic decisions.
            </p>
          </div>
        </header>

        <div className="ai-parity-grid">
          <Metric
            label="Comparable"
            value={diagnostics?.agreement.comparableCount ?? 0}
          />
          <Metric
            label="Action"
            value={percent(diagnostics?.agreement.actionAgreementRate ?? null)}
          />
          <Metric
            label="Target"
            value={percent(
              diagnostics?.agreement.targetPageAgreementRate ?? null,
            )}
          />
          <Metric
            label="Full"
            value={percent(diagnostics?.agreement.fullAgreementRate ?? null)}
          />
        </div>

        {diagnostics?.recentMismatches.length ? (
          <div className="ai-mismatch-table">
            {diagnostics.recentMismatches.map((item) => (
              <Link
                key={item.agentRunId}
                to={`/ingestions/${item.ingestionId}`}
                className="ai-mismatch-row"
              >
                <span>
                  <strong>{item.titleHint ?? item.sourceName}</strong>
                  <small>{new Date(item.startedAt).toLocaleString()}</small>
                </span>
                <code>
                  {item.classicAction ?? "none"}
                  {" -> "}
                  {item.agentAction ?? "none"}
                </code>
              </Link>
            ))}
          </div>
        ) : (
          <div className="system-empty">
            {loadingDiagnostics ? "Loading diagnostics..." : "No mismatches."}
          </div>
        )}
      </section>
    </PageShell>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="ai-parity-metric">
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}
