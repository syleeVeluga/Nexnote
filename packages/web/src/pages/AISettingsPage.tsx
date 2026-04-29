import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bot,
  ChevronDown,
  Gauge,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
} from "lucide-react";
import {
  AGENT_MODEL_PRESETS_BY_PROVIDER,
  type AgentModelPreset,
  type AIProvider,
  type IngestionMode,
} from "@wekiflow/shared";
import { useWorkspace } from "../hooks/use-workspace.js";
import {
  agentRuns as agentRunsApi,
  workspaces as workspacesApi,
  type AgentDiagnostics,
} from "../lib/api-client.js";
import { PageShell } from "../components/ui/PageShell.js";
import { Badge, type BadgeTone } from "../components/ui/Badge.js";
import { IconButton } from "../components/ui/IconButton.js";

const INGESTION_MODES: IngestionMode[] = ["classic", "shadow", "agent"];
const AGENT_PROVIDERS: AIProvider[] = ["openai", "gemini"];
type ProviderChoice = AIProvider | "inherit";

function percent(value: number | null): string {
  if (value == null) return "n/a";
  return `${Math.round(value * 100)}%`;
}

function modeLabel(mode: IngestionMode): string {
  if (mode === "classic") return "Classic";
  if (mode === "shadow") return "Shadow";
  return "Agent";
}

function providerLabel(provider: ProviderChoice): string {
  if (provider === "inherit") return "Inherit";
  return provider === "openai" ? "OpenAI" : "Gemini";
}

function parseOptionalInteger(value: string, label: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function parseOptionalIntegerInRange(
  value: string,
  label: string,
  min: number,
  max: number,
): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label}는 ${min}~${max} 사이의 정수여야 합니다.`);
  }
  return parsed;
}

function parseOptionalPercent(value: string, label: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${label}는 0~100 사이의 숫자여야 합니다.`);
  }
  return Math.round(parsed * 10) / 1000;
}

function rateInputFromValue(value: number | null): string {
  if (value == null) return "";
  return String(Math.round(value * 1000) / 10);
}

function gateLabel(status: AgentDiagnostics["gate"]["status"]): string {
  if (status === "passed") return "Gate passed";
  if (status === "blocked") return "Below threshold";
  if (status === "collecting") return "Collecting";
  return "Not started";
}

function gateTone(status: AgentDiagnostics["gate"]["status"]): BadgeTone {
  if (status === "passed") return "green";
  if (status === "blocked") return "red";
  if (status === "collecting") return "orange";
  return "warm";
}

function sourceLabel(source: string | null | undefined): string {
  if (!source || source === "unset") return "unset";
  if (source === "unconfigured") return "unconfigured";
  return source;
}

export function AISettingsPage() {
  const { current, refresh } = useWorkspace();
  const [mode, setMode] = useState<IngestionMode>("classic");
  const [instructions, setInstructions] = useState("");
  const [agentProvider, setAgentProvider] = useState<ProviderChoice>("inherit");
  const [agentModelFast, setAgentModelFast] = useState<AgentModelPreset | "">(
    "",
  );
  const [agentModelLargeContext, setAgentModelLargeContext] = useState<
    AgentModelPreset | ""
  >("");
  const [fastThresholdInput, setFastThresholdInput] = useState("");
  const [dailyCapInput, setDailyCapInput] = useState("");
  const [parityDaysInput, setParityDaysInput] = useState("");
  const [parityCountInput, setParityCountInput] = useState("");
  const [parityActionRateInput, setParityActionRateInput] = useState("");
  const [parityTargetRateInput, setParityTargetRateInput] = useState("");
  const [parityPanelOpen, setParityPanelOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<AgentDiagnostics | null>(null);
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const workspaceId = current?.id;
  const canManage = current?.role === "owner" || current?.role === "admin";
  const gate = diagnostics?.gate ?? null;
  const currentModels = diagnostics?.currentModels ?? null;

  useEffect(() => {
    if (!current) return;
    setMode(current.ingestionMode);
    setInstructions(current.agentInstructions ?? "");
    setAgentProvider(current.agentProvider ?? "inherit");
    setAgentModelFast(current.agentModelFast ?? "");
    setAgentModelLargeContext(current.agentModelLargeContext ?? "");
    setFastThresholdInput(
      current.agentFastThresholdTokens == null
        ? ""
        : String(current.agentFastThresholdTokens),
    );
    setDailyCapInput(
      current.agentDailyTokenCap == null
        ? ""
        : String(current.agentDailyTokenCap),
    );
    setParityDaysInput(
      current.agentParityMinObservedDays == null
        ? ""
        : String(current.agentParityMinObservedDays),
    );
    setParityCountInput(
      current.agentParityMinComparableCount == null
        ? ""
        : String(current.agentParityMinComparableCount),
    );
    setParityActionRateInput(
      rateInputFromValue(current.agentParityMinActionAgreementRate),
    );
    setParityTargetRateInput(
      rateInputFromValue(current.agentParityMinTargetPageAgreementRate),
    );
  }, [current]);

  const modelOptions = useMemo(
    () =>
      agentProvider === "inherit"
        ? []
        : ([
            ...AGENT_MODEL_PRESETS_BY_PROVIDER[agentProvider],
          ] as AgentModelPreset[]),
    [agentProvider],
  );

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
    if (
      mode === "agent" &&
      current?.ingestionMode !== "agent" &&
      !gate?.canPromote
    ) {
      setError(gate?.reason ?? "Shadow parity has not passed yet.");
      return;
    }
    let fastThresholdTokens: number | null;
    let dailyTokenCap: number | null;
    let parityMinObservedDays: number | null;
    let parityMinComparableCount: number | null;
    let parityMinActionAgreementRate: number | null;
    let parityMinTargetPageAgreementRate: number | null;
    try {
      fastThresholdTokens = parseOptionalInteger(
        fastThresholdInput,
        "Fast threshold",
      );
      dailyTokenCap = parseOptionalInteger(dailyCapInput, "Daily token cap");
      parityMinObservedDays = parseOptionalIntegerInRange(
        parityDaysInput,
        "관찰 기간",
        1,
        30,
      );
      parityMinComparableCount = parseOptionalIntegerInRange(
        parityCountInput,
        "최소 비교 건수",
        1,
        1000,
      );
      parityMinActionAgreementRate = parseOptionalPercent(
        parityActionRateInput,
        "결정 종류 일치율",
      );
      parityMinTargetPageAgreementRate = parseOptionalPercent(
        parityTargetRateInput,
        "대상 페이지 일치율",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid agent settings");
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await workspacesApi.update(workspaceId, {
        ingestionMode: mode,
        agentInstructions: instructions.trim() || null,
        agentProvider: agentProvider === "inherit" ? null : agentProvider,
        agentModelFast: agentModelFast || null,
        agentModelLargeContext: agentModelLargeContext || null,
        agentFastThresholdTokens: fastThresholdTokens,
        agentDailyTokenCap: dailyTokenCap,
        agentParityMinObservedDays: parityMinObservedDays,
        agentParityMinComparableCount: parityMinComparableCount,
        agentParityMinActionAgreementRate: parityMinActionAgreementRate,
        agentParityMinTargetPageAgreementRate: parityMinTargetPageAgreementRate,
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

  function changeProvider(value: ProviderChoice) {
    setAgentProvider(value);
    setAgentModelFast("");
    setAgentModelLargeContext("");
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
            {INGESTION_MODES.map((item) => {
              const disabled =
                item === "agent" &&
                current.ingestionMode !== "agent" &&
                !gate?.canPromote;
              return (
                <button
                  key={item}
                  type="button"
                  className={mode === item ? "active" : ""}
                  onClick={() => setMode(item)}
                  disabled={disabled}
                  title={disabled ? gate?.reason : undefined}
                >
                  {modeLabel(item)}
                </button>
              );
            })}
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
          <label className="ai-settings-field">
            <span>Cap override</span>
            <input
              type="number"
              min={10_000}
              step={10_000}
              inputMode="numeric"
              value={dailyCapInput}
              placeholder={String(
                diagnostics?.agentSettings.effective.dailyTokenCap ?? "",
              )}
              onChange={(event) => setDailyCapInput(event.target.value)}
            />
          </label>
        </div>
      </section>

      <section
        className={`ai-settings-panel ai-parity-overrides${
          parityPanelOpen ? " is-open" : ""
        }`}
      >
        <button
          type="button"
          className="ai-settings-panel-header ai-parity-overrides-toggle"
          onClick={() => setParityPanelOpen((open) => !open)}
          aria-expanded={parityPanelOpen}
        >
          <span className="system-overview-icon" aria-hidden="true">
            <SlidersHorizontal size={17} />
          </span>
          <div>
            <h2>승격 기준 (실험용)</h2>
            <p>
              AI가 운영 모드로 전환되기까지 필요한 검증 강도를 조정합니다.
            </p>
          </div>
          <ChevronDown
            size={16}
            className="ai-parity-overrides-chevron"
            aria-hidden="true"
          />
        </button>

        {parityPanelOpen && (
          <>
            <div className="ai-parity-overrides-warning">
              <ShieldAlert size={14} aria-hidden="true" />
              <span>
                이 값을 낮추면 충분히 검증되지 않은 AI 결정이 워크스페이스에
                자동 반영될 수 있습니다. 실험·테스트 워크스페이스에서만
                사용하세요. 비워두면 시스템 기본값(7일 / 20건 / 90% / 85%)이
                적용됩니다.
              </span>
            </div>

            <div className="ai-settings-fields">
              <label className="ai-settings-field">
                <span>관찰 기간</span>
                <div className="ai-parity-input-row">
                  <input
                    type="number"
                    min={1}
                    max={30}
                    step={1}
                    inputMode="numeric"
                    value={parityDaysInput}
                    placeholder={String(gate?.criteria.minObservedDays ?? 7)}
                    onChange={(event) =>
                      setParityDaysInput(event.target.value)
                    }
                  />
                  <span className="ai-parity-input-suffix">일</span>
                </div>
                <small>
                  며칠 동안 관찰한 뒤 승격 검토 (기본 7일, 1~30 사이).
                </small>
                <small className="ai-parity-effective">
                  현재 적용:{" "}
                  <strong>{gate?.criteria.minObservedDays ?? 7}일</strong>{" "}
                  {current.agentParityMinObservedDays != null
                    ? "(이 워크스페이스 override)"
                    : "(시스템 기본값)"}
                </small>
              </label>

              <label className="ai-settings-field">
                <span>최소 비교 건수</span>
                <div className="ai-parity-input-row">
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    step={1}
                    inputMode="numeric"
                    value={parityCountInput}
                    placeholder={String(gate?.criteria.minComparableCount ?? 20)}
                    onChange={(event) =>
                      setParityCountInput(event.target.value)
                    }
                  />
                  <span className="ai-parity-input-suffix">건</span>
                </div>
                <small>
                  이 만큼의 ingestion 결정을 비교한 뒤 승격 (기본 20건,
                  1~1000).
                </small>
                <small className="ai-parity-effective">
                  현재 적용:{" "}
                  <strong>{gate?.criteria.minComparableCount ?? 20}건</strong>{" "}
                  {current.agentParityMinComparableCount != null
                    ? "(이 워크스페이스 override)"
                    : "(시스템 기본값)"}
                </small>
              </label>

              <label className="ai-settings-field">
                <span>결정 종류 일치율</span>
                <div className="ai-parity-input-row">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    inputMode="decimal"
                    value={parityActionRateInput}
                    placeholder={String(
                      Math.round(
                        (gate?.criteria.minActionAgreementRate ?? 0.9) * 100,
                      ),
                    )}
                    onChange={(event) =>
                      setParityActionRateInput(event.target.value)
                    }
                  />
                  <span className="ai-parity-input-suffix">%</span>
                </div>
                <small>
                  AI와 기존 분류기가 같은 종류(생성/갱신/추가 등)로 판단한 비율
                  (기본 90%).
                </small>
                <small className="ai-parity-effective">
                  현재 적용:{" "}
                  <strong>
                    {percent(gate?.criteria.minActionAgreementRate ?? 0.9)}
                  </strong>{" "}
                  {current.agentParityMinActionAgreementRate != null
                    ? "(이 워크스페이스 override)"
                    : "(시스템 기본값)"}
                </small>
              </label>

              <label className="ai-settings-field">
                <span>대상 페이지 일치율</span>
                <div className="ai-parity-input-row">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    inputMode="decimal"
                    value={parityTargetRateInput}
                    placeholder={String(
                      Math.round(
                        (gate?.criteria.minTargetPageAgreementRate ?? 0.85) *
                          100,
                      ),
                    )}
                    onChange={(event) =>
                      setParityTargetRateInput(event.target.value)
                    }
                  />
                  <span className="ai-parity-input-suffix">%</span>
                </div>
                <small>
                  AI와 기존 분류기가 같은 페이지를 선택한 비율 (기본 85%).
                </small>
                <small className="ai-parity-effective">
                  현재 적용:{" "}
                  <strong>
                    {percent(
                      gate?.criteria.minTargetPageAgreementRate ?? 0.85,
                    )}
                  </strong>{" "}
                  {current.agentParityMinTargetPageAgreementRate != null
                    ? "(이 워크스페이스 override)"
                    : "(시스템 기본값)"}
                </small>
              </label>
            </div>

            <div className="ai-parity-overrides-actions">
              <IconButton
                icon={<RotateCcw size={14} />}
                label="기본값으로 되돌리기"
                showLabel
                tone="quiet"
                onClick={() => {
                  setParityDaysInput("");
                  setParityCountInput("");
                  setParityActionRateInput("");
                  setParityTargetRateInput("");
                }}
              />
            </div>
          </>
        )}
      </section>

      <section className="ai-settings-panel">
        <header className="ai-settings-panel-header">
          <span className="system-overview-icon" aria-hidden="true">
            <Bot size={17} />
          </span>
          <div>
            <h2>Model routing</h2>
            <p>Provider, fast model, large-context model, and threshold.</p>
          </div>
        </header>

        <div className="ai-settings-fields">
          <label className="ai-settings-field">
            <span>Provider</span>
            <select
              value={agentProvider}
              onChange={(event) =>
                changeProvider(event.target.value as ProviderChoice)
              }
            >
              <option value="inherit">{providerLabel("inherit")}</option>
              {AGENT_PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>
                  {providerLabel(provider)}
                </option>
              ))}
            </select>
          </label>

          <label className="ai-settings-field">
            <span>Fast model</span>
            <select
              value={agentModelFast}
              onChange={(event) =>
                setAgentModelFast(event.target.value as AgentModelPreset | "")
              }
              disabled={agentProvider === "inherit"}
            >
              <option value="">Inherit</option>
              {modelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>

          <label className="ai-settings-field">
            <span>Large-context model</span>
            <select
              value={agentModelLargeContext}
              onChange={(event) =>
                setAgentModelLargeContext(
                  event.target.value as AgentModelPreset | "",
                )
              }
              disabled={agentProvider === "inherit"}
            >
              <option value="">Inherit</option>
              {modelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>

          <label className="ai-settings-field">
            <span>Fast threshold</span>
            <input
              type="number"
              min={1_000}
              step={1_000}
              inputMode="numeric"
              value={fastThresholdInput}
              placeholder={String(
                diagnostics?.agentSettings.effective.fastThresholdTokens ?? "",
              )}
              onChange={(event) => setFastThresholdInput(event.target.value)}
            />
          </label>
        </div>

        <div className="ai-model-diagnostics">
          <ModelRoute
            label="Provider"
            value={currentModels?.provider ?? "unconfigured"}
            source={currentModels?.providerSource}
          />
          <ModelRoute
            label="Base"
            value={currentModels?.baseModel ?? "unconfigured"}
            source={currentModels?.baseModelSource}
          />
          <ModelRoute
            label="Fast"
            value={currentModels?.fastModel ?? "default"}
            source={currentModels?.fastModelSource}
          />
          <ModelRoute
            label="Large"
            value={currentModels?.largeContextModel ?? "default"}
            source={currentModels?.largeContextModelSource}
          />
          <ModelRoute
            label="Threshold"
            value={(currentModels?.fastThresholdTokens ?? 0).toLocaleString()}
            source={currentModels?.fastThresholdSource}
          />
        </div>

        <div className="ai-effective-settings">
          <span>Effective</span>
          <code>
            {diagnostics?.agentSettings.effective.provider ?? "default"} /{" "}
            {diagnostics?.agentSettings.effective.modelFast ?? "default"} /{" "}
            {diagnostics?.agentSettings.effective.modelLargeContext ??
              "default"}
          </code>
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

        {gate && (
          <div className={`ai-gate-status ai-gate-status-${gate.status}`}>
            <div>
              <Badge tone={gateTone(gate.status)} size="sm">
                {gateLabel(gate.status)}
              </Badge>
              <strong>{gate.reason}</strong>
            </div>
            <span>
              {gate.observedDays}/{gate.criteria.minObservedDays} days,{" "}
              {gate.comparableCount}/{gate.criteria.minComparableCount}{" "}
              comparable ingestions, action {percent(gate.actionAgreementRate)}{" "}
              target {percent(gate.targetPageAgreementRate)}
            </span>
          </div>
        )}

        {diagnostics?.dailyAgreement.length ? (
          <div className="ai-daily-parity-table">
            {diagnostics.dailyAgreement.map((item) => (
              <div key={item.day} className="ai-daily-parity-row">
                <strong>{item.day}</strong>
                <span>{item.comparableCount} comparable</span>
                <code>
                  action {percent(item.actionAgreementRate)} / target{" "}
                  {percent(item.targetPageAgreementRate)}
                </code>
              </div>
            ))}
          </div>
        ) : null}

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

function ModelRoute({
  label,
  value,
  source,
}: {
  label: string;
  value: string;
  source?: string | null;
}) {
  return (
    <div className="ai-model-route">
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{sourceLabel(source)}</span>
    </div>
  );
}
