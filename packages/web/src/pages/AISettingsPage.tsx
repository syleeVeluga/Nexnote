import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  Bot,
  CalendarClock,
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

function percent(value: number | null, fallback = "n/a"): string {
  if (value == null) return fallback;
  return `${Math.round(value * 100)}%`;
}

function parseOptionalInteger(
  value: string,
  errorMessage: string,
): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(errorMessage);
  }
  return parsed;
}

function parseOptionalIntegerInRange(
  value: string,
  errorMessage: string,
  min: number,
  max: number,
): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(errorMessage);
  }
  return parsed;
}

function parseOptionalPercent(
  value: string,
  errorMessage: string,
): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(errorMessage);
  }
  return Math.round(parsed * 10) / 1000;
}

function rateInputFromValue(value: number | null): string {
  if (value == null) return "";
  return String(Math.round(value * 1000) / 10);
}

function gateTone(status: AgentDiagnostics["gate"]["status"]): BadgeTone {
  if (status === "passed") return "green";
  if (status === "blocked") return "red";
  if (status === "collecting") return "orange";
  return "warm";
}

export function AISettingsPage() {
  const { t } = useTranslation(["aiSettings", "common"]);
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
  const [scheduledEnabled, setScheduledEnabled] = useState(false);
  const [scheduledAutoApply, setScheduledAutoApply] = useState(false);
  const [allowDestructiveScheduledAgent, setAllowDestructiveScheduledAgent] =
    useState(false);
  const [scheduledDailyTokenCapInput, setScheduledDailyTokenCapInput] =
    useState("");
  const [scheduledPerRunPageLimitInput, setScheduledPerRunPageLimitInput] =
    useState("");
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
  const percentLabel = useCallback(
    (value: number | null) => percent(value, t("values.notApplicable")),
    [t],
  );

  function modeLabel(modeValue: IngestionMode): string {
    return t(`modes.${modeValue}`);
  }

  function providerLabel(provider: ProviderChoice): string {
    if (provider === "inherit") return t("providers.inherit");
    return t(`providers.${provider}`);
  }

  function sourceLabel(source: string | null | undefined): string {
    const key = source ?? "unset";
    return t(`sources.${key}`, { defaultValue: key });
  }

  function fallbackValue(
    value: string | null | undefined,
    fallback: "default" | "unconfigured",
  ): string {
    return value ?? t(`values.${fallback}`);
  }

  function gateReasonLabel(gateStatus: AgentDiagnostics["gate"]): string {
    return t(`shadowParity.reason.${gateStatus.status}`);
  }

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
    setScheduledEnabled(current.scheduledEnabled);
    setScheduledAutoApply(current.scheduledAutoApply);
    setAllowDestructiveScheduledAgent(current.allowDestructiveScheduledAgent);
    setScheduledDailyTokenCapInput(
      current.scheduledDailyTokenCap == null
        ? ""
        : String(current.scheduledDailyTokenCap),
    );
    setScheduledPerRunPageLimitInput(String(current.scheduledPerRunPageLimit));
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
        err instanceof Error ? err.message : t("errors.loadDiagnostics"),
      );
    } finally {
      setLoadingDiagnostics(false);
    }
  }, [canManage, t, workspaceId]);

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
      setError(gate?.reason ?? t("errors.shadowParityNotPassed"));
      return;
    }
    let fastThresholdTokens: number | null;
    let dailyTokenCap: number | null;
    let parityMinObservedDays: number | null;
    let parityMinComparableCount: number | null;
    let parityMinActionAgreementRate: number | null;
    let parityMinTargetPageAgreementRate: number | null;
    let scheduledDailyTokenCap: number | null;
    let scheduledPerRunPageLimit: number | null;
    try {
      fastThresholdTokens = parseOptionalInteger(
        fastThresholdInput,
        t("errors.positiveInteger", { field: t("fields.fastThreshold") }),
      );
      dailyTokenCap = parseOptionalInteger(
        dailyCapInput,
        t("errors.positiveInteger", { field: t("fields.dailyTokenCap") }),
      );
      parityMinObservedDays = parseOptionalIntegerInRange(
        parityDaysInput,
        t("errors.integerRange", {
          field: t("fields.observedDays"),
          min: 1,
          max: 30,
        }),
        1,
        30,
      );
      parityMinComparableCount = parseOptionalIntegerInRange(
        parityCountInput,
        t("errors.integerRange", {
          field: t("fields.minComparableCount"),
          min: 1,
          max: 1000,
        }),
        1,
        1000,
      );
      parityMinActionAgreementRate = parseOptionalPercent(
        parityActionRateInput,
        t("errors.percentRange", { field: t("fields.actionAgreement") }),
      );
      parityMinTargetPageAgreementRate = parseOptionalPercent(
        parityTargetRateInput,
        t("errors.percentRange", { field: t("fields.targetAgreement") }),
      );
      scheduledDailyTokenCap = parseOptionalInteger(
        scheduledDailyTokenCapInput,
        t("errors.positiveInteger", {
          field: t("scheduledAgent.fields.dailyTokenCap", {
            defaultValue: "Scheduled daily token cap",
          }),
        }),
      );
      scheduledPerRunPageLimit = parseOptionalIntegerInRange(
        scheduledPerRunPageLimitInput,
        t("errors.integerRange", {
          field: t("scheduledAgent.fields.perRunPageLimit", {
            defaultValue: "Scheduled per-run page limit",
          }),
          min: 1,
          max: 500,
        }),
        1,
        500,
      );
      if (scheduledPerRunPageLimit == null) {
        throw new Error(
          t("errors.integerRange", {
            field: t("scheduledAgent.fields.perRunPageLimit", {
              defaultValue: "Scheduled per-run page limit",
            }),
            min: 1,
            max: 500,
          }),
        );
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("errors.invalidSettings"),
      );
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
        scheduledEnabled,
        scheduledAutoApply: scheduledEnabled ? true : false,
        allowDestructiveScheduledAgent: scheduledEnabled
          ? allowDestructiveScheduledAgent
          : false,
        scheduledDailyTokenCap,
        scheduledPerRunPageLimit,
      });
      await refresh();
      await loadDiagnostics();
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errors.saveSettings"));
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
        title={t("title")}
        description={t("restrictedDescription")}
      >
        <div className="system-empty system-empty-restricted">
          <ShieldAlert size={16} aria-hidden="true" />
          <span>{t("restrictedRole")}</span>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      className="ai-settings-page"
      eyebrow={t("eyebrow")}
      title={t("title")}
      description={t("description")}
      actions={
        <>
          {saved && <Badge tone="green">{t("saved")}</Badge>}
          <IconButton
            icon={<RefreshCw size={15} />}
            label={t("actions.refreshDiagnostics")}
            showLabel
            tone="quiet"
            onClick={() => void loadDiagnostics()}
            disabled={loadingDiagnostics}
          />
          <IconButton
            icon={<Save size={15} />}
            label={saving ? t("actions.saving") : t("actions.save")}
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
              <h2>{t("panels.workspaceMode.title")}</h2>
              <p>{t("panels.workspaceMode.description")}</p>
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
                  title={disabled && gate ? gateReasonLabel(gate) : undefined}
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
              <h2>{t("panels.dailyTokenCap.title")}</h2>
              <p>{t("panels.dailyTokenCap.description")}</p>
            </div>
          </header>
          <div className="ai-token-meter">
            <div>
              <strong>
                {(diagnostics?.dailyTokenUsage.used ?? 0).toLocaleString()}
              </strong>
              <span>
                / {(diagnostics?.dailyTokenUsage.cap ?? 0).toLocaleString()}{" "}
                {t("tokens")}
              </span>
            </div>
            <div
              className="ai-token-bar"
              aria-label={t("panels.dailyTokenCap.usageAria")}
            >
              <span style={{ width: `${tokenPercent}%` }} />
            </div>
          </div>
          <label className="ai-settings-field">
            <span>{t("fields.capOverride")}</span>
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

      <section className="ai-settings-panel">
        <header className="ai-settings-panel-header">
          <span className="system-overview-icon" aria-hidden="true">
            <CalendarClock size={17} />
          </span>
          <div>
            <h2>
              {t("scheduledAgent.title", {
                defaultValue: "Scheduled Agent",
              })}
            </h2>
            <p>
              {t("scheduledAgent.description", {
                defaultValue:
                  "Let the agent reorganize selected wiki areas on demand or on a schedule.",
              })}
            </p>
          </div>
        </header>

        <div className="ai-settings-fields ai-scheduled-settings-fields">
          <label className="ai-settings-check-field">
            <input
              type="checkbox"
              checked={scheduledEnabled}
              onChange={(event) => setScheduledEnabled(event.target.checked)}
            />
            <span>
              <strong>
                {t("scheduledAgent.fields.enabled", {
                  defaultValue: "Enable Scheduled Agent",
                })}
              </strong>
              <small>
                {t("scheduledAgent.help.enabled", {
                  defaultValue:
                    "Allow manual and cron-based scheduled reorganize runs.",
                })}
              </small>
            </span>
          </label>

          <label className="ai-settings-check-field">
            <input
              type="checkbox"
              checked={scheduledEnabled || scheduledAutoApply}
              disabled
              readOnly
            />
            <span>
              <strong>
                {t("scheduledAgent.fields.autoApply", {
                  defaultValue: "Scheduled decisions apply automatically",
                })}
              </strong>
              <small>
                {t("scheduledAgent.help.autoApply", {
                  defaultValue:
                    "Scheduled Agent bypasses the approval queue; use scope and token caps as guardrails.",
                })}
              </small>
            </span>
          </label>

          <label className="ai-settings-check-field">
            <input
              type="checkbox"
              checked={allowDestructiveScheduledAgent}
              disabled={!scheduledEnabled}
              onChange={(event) =>
                setAllowDestructiveScheduledAgent(event.target.checked)
              }
            />
            <span>
              <strong>
                {t("scheduledAgent.fields.destructiveTools", {
                  defaultValue: "Allow delete and merge tools",
                })}
              </strong>
              <small>
                {t("scheduledAgent.help.destructiveTools", {
                  defaultValue:
                    "When enabled, Scheduled Agent can auto-apply page deletes and merges.",
                })}
              </small>
            </span>
          </label>

          <label className="ai-settings-field">
            <span>
              {t("scheduledAgent.fields.dailyTokenCap", {
                defaultValue: "Scheduled daily token cap",
              })}
            </span>
            <input
              type="number"
              min={10_000}
              step={10_000}
              inputMode="numeric"
              value={scheduledDailyTokenCapInput}
              placeholder={t("scheduledAgent.placeholders.dailyTokenCap", {
                defaultValue: "System default",
              })}
              onChange={(event) =>
                setScheduledDailyTokenCapInput(event.target.value)
              }
            />
            <small>
              {t("scheduledAgent.help.dailyTokenCap", {
                defaultValue:
                  "Optional override. Values of 10,000 or more are recommended.",
              })}
            </small>
          </label>

          <label className="ai-settings-field">
            <span>
              {t("scheduledAgent.fields.perRunPageLimit", {
                defaultValue: "Pages per run",
              })}
            </span>
            <input
              type="number"
              min={1}
              max={500}
              step={1}
              inputMode="numeric"
              value={scheduledPerRunPageLimitInput}
              onChange={(event) =>
                setScheduledPerRunPageLimitInput(event.target.value)
              }
            />
            <small>
              {t("scheduledAgent.help.perRunPageLimit", {
                defaultValue: "Allowed range: 1 to 500 pages.",
              })}
            </small>
          </label>
        </div>

        <Link to="/settings/scheduled-agent" className="ai-settings-link">
          {t("scheduledAgent.manageLink", {
            defaultValue: "Manage schedules and runs",
          })}
        </Link>
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
            <h2>{t("parity.title")}</h2>
            <p>{t("parity.description")}</p>
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
              <span>{t("parity.warning")}</span>
            </div>

            <div className="ai-settings-fields">
              <label className="ai-settings-field">
                <span>{t("fields.observedDays")}</span>
                <div className="ai-parity-input-row">
                  <input
                    type="number"
                    min={1}
                    max={30}
                    step={1}
                    inputMode="numeric"
                    value={parityDaysInput}
                    placeholder={String(gate?.criteria.minObservedDays ?? 7)}
                    onChange={(event) => setParityDaysInput(event.target.value)}
                  />
                  <span className="ai-parity-input-suffix">
                    {t("parity.daysSuffix")}
                  </span>
                </div>
                <small>{t("parity.observedDaysHelp")}</small>
                <small className="ai-parity-effective">
                  {t("parity.effective")}{" "}
                  <strong>
                    {t("parity.daysValue", {
                      count: gate?.criteria.minObservedDays ?? 7,
                    })}
                  </strong>{" "}
                  {current.agentParityMinObservedDays != null
                    ? t("parity.workspaceOverride")
                    : t("parity.systemDefault")}
                </small>
              </label>

              <label className="ai-settings-field">
                <span>{t("fields.minComparableCount")}</span>
                <div className="ai-parity-input-row">
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    step={1}
                    inputMode="numeric"
                    value={parityCountInput}
                    placeholder={String(
                      gate?.criteria.minComparableCount ?? 20,
                    )}
                    onChange={(event) =>
                      setParityCountInput(event.target.value)
                    }
                  />
                  <span className="ai-parity-input-suffix">
                    {t("parity.countSuffix")}
                  </span>
                </div>
                <small>{t("parity.comparableCountHelp")}</small>
                <small className="ai-parity-effective">
                  {t("parity.effective")}{" "}
                  <strong>
                    {t("parity.countValue", {
                      count: gate?.criteria.minComparableCount ?? 20,
                    })}
                  </strong>{" "}
                  {current.agentParityMinComparableCount != null
                    ? t("parity.workspaceOverride")
                    : t("parity.systemDefault")}
                </small>
              </label>

              <label className="ai-settings-field">
                <span>{t("fields.actionAgreement")}</span>
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
                <small>{t("parity.actionAgreementHelp")}</small>
                <small className="ai-parity-effective">
                  {t("parity.effective")}{" "}
                  <strong>
                    {percentLabel(gate?.criteria.minActionAgreementRate ?? 0.9)}
                  </strong>{" "}
                  {current.agentParityMinActionAgreementRate != null
                    ? t("parity.workspaceOverride")
                    : t("parity.systemDefault")}
                </small>
              </label>

              <label className="ai-settings-field">
                <span>{t("fields.targetAgreement")}</span>
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
                <small>{t("parity.targetAgreementHelp")}</small>
                <small className="ai-parity-effective">
                  {t("parity.effective")}{" "}
                  <strong>
                    {percentLabel(
                      gate?.criteria.minTargetPageAgreementRate ?? 0.85,
                    )}
                  </strong>{" "}
                  {current.agentParityMinTargetPageAgreementRate != null
                    ? t("parity.workspaceOverride")
                    : t("parity.systemDefault")}
                </small>
              </label>
            </div>

            <div className="ai-parity-overrides-actions">
              <IconButton
                icon={<RotateCcw size={14} />}
                label={t("actions.resetDefaults")}
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
            <h2>{t("modelRouting.title")}</h2>
            <p>{t("modelRouting.description")}</p>
          </div>
        </header>

        <div className="ai-settings-fields">
          <label className="ai-settings-field">
            <span>{t("fields.provider")}</span>
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
            <span>{t("fields.fastModel")}</span>
            <select
              value={agentModelFast}
              onChange={(event) =>
                setAgentModelFast(event.target.value as AgentModelPreset | "")
              }
              disabled={agentProvider === "inherit"}
            >
              <option value="">{t("providers.inherit")}</option>
              {modelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>

          <label className="ai-settings-field">
            <span>{t("fields.largeContextModel")}</span>
            <select
              value={agentModelLargeContext}
              onChange={(event) =>
                setAgentModelLargeContext(
                  event.target.value as AgentModelPreset | "",
                )
              }
              disabled={agentProvider === "inherit"}
            >
              <option value="">{t("providers.inherit")}</option>
              {modelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>

          <label className="ai-settings-field">
            <span>{t("fields.fastThreshold")}</span>
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
            label={t("modelRouting.provider")}
            value={
              currentModels?.provider
                ? providerLabel(currentModels.provider)
                : t("values.unconfigured")
            }
            source={sourceLabel(currentModels?.providerSource)}
          />
          <ModelRoute
            label={t("modelRouting.base")}
            value={fallbackValue(currentModels?.baseModel, "unconfigured")}
            source={sourceLabel(currentModels?.baseModelSource)}
          />
          <ModelRoute
            label={t("modelRouting.fast")}
            value={fallbackValue(currentModels?.fastModel, "default")}
            source={sourceLabel(currentModels?.fastModelSource)}
          />
          <ModelRoute
            label={t("modelRouting.large")}
            value={fallbackValue(currentModels?.largeContextModel, "default")}
            source={sourceLabel(currentModels?.largeContextModelSource)}
          />
          <ModelRoute
            label={t("modelRouting.threshold")}
            value={(currentModels?.fastThresholdTokens ?? 0).toLocaleString()}
            source={sourceLabel(currentModels?.fastThresholdSource)}
          />
        </div>

        <div className="ai-effective-settings">
          <span>{t("modelRouting.effective")}</span>
          <code>
            {diagnostics?.agentSettings.effective.provider
              ? providerLabel(diagnostics.agentSettings.effective.provider)
              : t("values.default")}{" "}
            /{" "}
            {diagnostics?.agentSettings.effective.modelFast ??
              t("values.default")}{" "}
            /{" "}
            {diagnostics?.agentSettings.effective.modelLargeContext ??
              t("values.default")}
          </code>
        </div>
      </section>

      <section className="ai-settings-panel ai-instructions-panel">
        <header className="ai-settings-panel-header">
          <span className="system-overview-icon" aria-hidden="true">
            <Bot size={17} />
          </span>
          <div>
            <h2>{t("instructions.title")}</h2>
            <p>{t("instructions.description")}</p>
          </div>
        </header>
        <textarea
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          rows={9}
          maxLength={20_000}
          placeholder={t("instructions.placeholder")}
        />
        <footer>
          {t("instructions.characterCount", {
            value: instructions.length.toLocaleString(),
          })}
        </footer>
      </section>

      <section className="ai-settings-panel">
        <header className="ai-settings-panel-header">
          <span className="system-overview-icon" aria-hidden="true">
            <Gauge size={17} />
          </span>
          <div>
            <h2>{t("shadowParity.title")}</h2>
            <p>{t("shadowParity.description")}</p>
          </div>
        </header>

        <div className="ai-parity-grid">
          <Metric
            label={t("shadowParity.metrics.comparable")}
            value={diagnostics?.agreement.comparableCount ?? 0}
          />
          <Metric
            label={t("shadowParity.metrics.action")}
            value={percentLabel(
              diagnostics?.agreement.actionAgreementRate ?? null,
            )}
          />
          <Metric
            label={t("shadowParity.metrics.target")}
            value={percentLabel(
              diagnostics?.agreement.targetPageAgreementRate ?? null,
            )}
          />
          <Metric
            label={t("shadowParity.metrics.full")}
            value={percentLabel(
              diagnostics?.agreement.fullAgreementRate ?? null,
            )}
          />
        </div>

        {gate && (
          <div className={`ai-gate-status ai-gate-status-${gate.status}`}>
            <div>
              <Badge tone={gateTone(gate.status)} size="sm">
                {t(`shadowParity.status.${gate.status}`)}
              </Badge>
              <strong>{gateReasonLabel(gate)}</strong>
            </div>
            <span>
              {t("shadowParity.gateSummary", {
                observedDays: gate.observedDays,
                minObservedDays: gate.criteria.minObservedDays,
                comparableCount: gate.comparableCount,
                minComparableCount: gate.criteria.minComparableCount,
                actionRate: percentLabel(gate.actionAgreementRate),
                targetRate: percentLabel(gate.targetPageAgreementRate),
              })}
            </span>
          </div>
        )}

        {diagnostics?.dailyAgreement.length ? (
          <div className="ai-daily-parity-table">
            {diagnostics.dailyAgreement.map((item) => (
              <div key={item.day} className="ai-daily-parity-row">
                <strong>{item.day}</strong>
                <span>
                  {t("shadowParity.dailyComparable", {
                    count: item.comparableCount,
                  })}
                </span>
                <code>
                  {t("shadowParity.dailyAgreement", {
                    actionRate: percentLabel(item.actionAgreementRate),
                    targetRate: percentLabel(item.targetPageAgreementRate),
                  })}
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
                  {item.classicAction ?? t("values.none")}
                  {" -> "}
                  {item.agentAction ?? t("values.none")}
                </code>
              </Link>
            ))}
          </div>
        ) : (
          <div className="system-empty">
            {loadingDiagnostics
              ? t("shadowParity.loadingDiagnostics")
              : t("shadowParity.noMismatches")}
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
      <span>{source}</span>
    </div>
  );
}
