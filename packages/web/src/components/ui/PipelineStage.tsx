import type { ReactNode } from "react";
import { StatusDot, type StatusTone } from "./StatusDot.js";

interface PipelineStageProps {
  label: string;
  count: number | string;
  status?: StatusTone;
  icon?: ReactNode;
  active?: boolean;
  className?: string;
}

export function PipelineStage({
  label,
  count,
  status = "neutral",
  icon,
  active = false,
  className = "",
}: PipelineStageProps) {
  return (
    <div
      className={`pipeline-stage${active ? " active" : ""} ${className}`.trim()}
    >
      <div className="pipeline-stage-topline">
        {icon && <span className="pipeline-stage-icon">{icon}</span>}
        <StatusDot tone={status} pulse={active} />
      </div>
      <strong>{count}</strong>
      <span>{label}</span>
    </div>
  );
}
