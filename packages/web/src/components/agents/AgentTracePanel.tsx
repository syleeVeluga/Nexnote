import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  Database,
  FileJson,
  GitBranch,
  Radio,
  Search,
  Wrench,
} from "lucide-react";
import type { AgentRunDto, AgentRunTraceStep } from "../../lib/api-client.js";
import { Badge } from "../ui/Badge.js";

interface AgentTracePanelProps {
  agentRun: AgentRunDto | null;
  streamError?: string | null;
}

function stepIcon(type: AgentRunTraceStep["type"]) {
  switch (type) {
    case "model_selection":
      return <Bot size={13} />;
    case "ai_response":
      return <Radio size={13} />;
    case "tool_result":
      return <Search size={13} />;
    case "plan":
    case "replan":
      return <GitBranch size={13} />;
    case "mutation_result":
      return <Wrench size={13} />;
    case "context_compaction":
      return <Database size={13} />;
    case "shadow_execute_skipped":
    case "turn_aborted":
      return <Clock3 size={13} />;
    default:
      return <AlertTriangle size={13} />;
  }
}

function statusTone(status: AgentRunDto["status"]) {
  if (status === "running") return "blue" as const;
  if (status === "failed" || status === "timeout" || status === "aborted")
    return "red" as const;
  if (status === "shadow" || status === "partial") return "warm" as const;
  return "green" as const;
}

const TOOL_LABELS: Record<string, string> = {
  move_page: "Move page",
  rename_page: "Rename page",
  create_folder: "Create folder",
};

function stepTitle(step: AgentRunTraceStep): string {
  if (typeof step.payload["phase"] === "string") {
    return `${step.type} - ${step.payload["phase"]}`;
  }
  if (typeof step.payload["name"] === "string") {
    const name = step.payload["name"];
    return `${step.type} - ${TOOL_LABELS[name] ?? name}`;
  }
  if (typeof step.payload["tool"] === "string") {
    const tool = step.payload["tool"];
    return `${step.type} - ${TOOL_LABELS[tool] ?? tool}`;
  }
  return step.type;
}

function compactPayload(payload: Record<string, unknown>): string {
  const copy = { ...payload };
  if (typeof copy["contentExcerpt"] === "string") {
    copy["contentExcerpt"] = `${copy["contentExcerpt"]}`.slice(0, 800);
  }
  return JSON.stringify(copy, null, 2);
}

function stepTurnIndex(step: AgentRunTraceStep): number | null {
  if (typeof step.turnIndex === "number") return step.turnIndex;
  const payloadTurnIndex = step.payload["turnIndex"];
  return typeof payloadTurnIndex === "number" ? payloadTurnIndex : null;
}

function mutationResultStatus(step: AgentRunTraceStep): string | null {
  const result = step.payload["result"];
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const status = (result as Record<string, unknown>)["status"];
  return typeof status === "string" ? status : null;
}

// Counts only auto-applied results — suggested / needs_review decisions and
// the request_human_review fallback (ok:false, status:"failed") are excluded
// so the "applied" badge reflects what actually changed pages, not what was
// queued. agentRun.decisionsCount is the broader handled-decision counter.
function isAppliedMutationResult(step: AgentRunTraceStep): boolean {
  return (
    step.type === "mutation_result" &&
    step.payload["ok"] === true &&
    mutationResultStatus(step) === "auto_applied"
  );
}

function groupSteps(steps: AgentRunTraceStep[]) {
  const groups: Array<{
    key: string;
    title: string;
    steps: AgentRunTraceStep[];
  }> = [];
  const byKey = new Map<string, (typeof groups)[number]>();

  for (const step of steps) {
    const turnIndex = stepTurnIndex(step);
    const key = turnIndex === null ? "setup" : `turn-${turnIndex}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        title: turnIndex === null ? "Setup" : `Turn ${turnIndex + 1}`,
        steps: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.steps.push(step);
  }

  return groups.map((group) => {
    if (group.key === "setup") return group;
    const proposed =
      group.steps.find((step) => step.type === "plan" || step.type === "replan")
        ?.payload["mutationCount"] ?? 0;
    const applied = group.steps.filter(isAppliedMutationResult).length;
    return {
      ...group,
      title: `${group.title} - ${proposed} proposed, ${applied} applied`,
    };
  });
}

export function AgentTracePanel({
  agentRun,
  streamError,
}: AgentTracePanelProps) {
  if (!agentRun) {
    return (
      <div className="agent-trace-empty">
        <Clock3 size={15} aria-hidden="true" />
        <span>No agent run recorded for this ingestion.</span>
      </div>
    );
  }

  const sortedSteps = [...agentRun.steps].sort((a, b) => a.step - b.step);
  const groupedSteps = groupSteps(sortedSteps);
  const running = agentRun.status === "running";

  return (
    <div className="agent-trace-panel">
      <header className="agent-trace-header">
        <div className="agent-trace-title">
          <span className="agent-trace-title-icon" aria-hidden="true">
            {running ? <Radio size={15} /> : <FileJson size={15} />}
          </span>
          <div>
            <h3>Agent trace</h3>
            <p>
              {agentRun.totalTokens.toLocaleString()} tokens /{" "}
              {agentRun.totalLatencyMs.toLocaleString()} ms
            </p>
          </div>
        </div>
        <Badge tone={statusTone(agentRun.status)} size="sm">
          {agentRun.status}
        </Badge>
      </header>

      {streamError && (
        <div className="agent-trace-error">
          <AlertTriangle size={13} aria-hidden="true" />
          {streamError}
        </div>
      )}

      {sortedSteps.length === 0 ? (
        <div className="agent-trace-empty">
          <Clock3 size={15} aria-hidden="true" />
          <span>
            {running ? "Waiting for live steps..." : "No trace steps."}
          </span>
        </div>
      ) : (
        <div className="agent-trace-groups">
          {groupedSteps.map((group) => (
            <section key={group.key} className="agent-trace-group">
              <h4>{group.title}</h4>
              <ol className="agent-trace-list">
                {group.steps.map((step) => (
                  <li
                    key={`${step.step}-${step.ts}`}
                    className="agent-trace-step"
                  >
                    <div className="agent-trace-step-icon" aria-hidden="true">
                      {step.type === "error" || step.type === "turn_aborted" ? (
                        <AlertTriangle size={13} />
                      ) : step.type === "shadow_execute_skipped" ? (
                        <CheckCircle2 size={13} />
                      ) : (
                        stepIcon(step.type)
                      )}
                    </div>
                    <div className="agent-trace-step-body">
                      <div className="agent-trace-step-top">
                        <strong>{stepTitle(step)}</strong>
                        <span>{new Date(step.ts).toLocaleTimeString()}</span>
                      </div>
                      <pre>{compactPayload(step.payload)}</pre>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
