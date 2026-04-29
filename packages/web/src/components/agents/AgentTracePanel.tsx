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
      return <GitBranch size={13} />;
    case "mutation_result":
      return <Wrench size={13} />;
    case "context_compaction":
      return <Database size={13} />;
    case "shadow_execute_skipped":
      return <Clock3 size={13} />;
    default:
      return <AlertTriangle size={13} />;
  }
}

function statusTone(status: AgentRunDto["status"]) {
  if (status === "running") return "blue" as const;
  if (status === "failed" || status === "timeout") return "red" as const;
  if (status === "shadow") return "warm" as const;
  return "green" as const;
}

function stepTitle(step: AgentRunTraceStep): string {
  if (typeof step.payload["phase"] === "string") {
    return `${step.type} - ${step.payload["phase"]}`;
  }
  if (typeof step.payload["name"] === "string") {
    return `${step.type} - ${step.payload["name"]}`;
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
        <ol className="agent-trace-list">
          {sortedSteps.map((step) => (
            <li key={`${step.step}-${step.ts}`} className="agent-trace-step">
              <div className="agent-trace-step-icon" aria-hidden="true">
                {step.type === "error" ? (
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
      )}
    </div>
  );
}
