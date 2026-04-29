type StatusTone = "neutral" | "active" | "success" | "warning" | "danger";

interface StatusDotProps {
  tone?: StatusTone;
  pulse?: boolean;
  label?: string;
  className?: string;
}

export function StatusDot({
  tone = "neutral",
  pulse = false,
  label,
  className = "",
}: StatusDotProps) {
  return (
    <span
      className={`status-dot status-dot-${tone}${pulse ? " status-dot-pulse" : ""} ${className}`.trim()}
      aria-label={label}
      title={label}
      role={label ? "img" : undefined}
    />
  );
}

export type { StatusTone };
