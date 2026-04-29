import type { HTMLAttributes, ReactNode } from "react";

type BadgeTone =
  | "warm"
  | "blue"
  | "teal"
  | "green"
  | "orange"
  | "red"
  | "purple";

type BadgeSize = "sm" | "md";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: BadgeSize;
  icon?: ReactNode;
}

export function Badge({
  tone = "warm",
  size = "md",
  icon,
  children,
  className = "",
  ...props
}: BadgeProps) {
  return (
    <span
      className={`ui-badge ui-badge-${tone} ui-badge-${size} ${className}`.trim()}
      {...props}
    >
      {icon && <span className="ui-badge-icon">{icon}</span>}
      {children}
    </span>
  );
}

export type { BadgeSize, BadgeTone };
