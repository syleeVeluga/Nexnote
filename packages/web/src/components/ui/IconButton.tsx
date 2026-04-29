import type { ButtonHTMLAttributes, ReactNode } from "react";

type IconButtonSize = "sm" | "md" | "lg";
type IconButtonTone = "default" | "primary" | "quiet" | "danger";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  label: string;
  size?: IconButtonSize;
  tone?: IconButtonTone;
  showLabel?: boolean;
}

export function IconButton({
  icon,
  label,
  size = "md",
  tone = "default",
  showLabel = false,
  className = "",
  type = "button",
  title,
  children,
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={`ui-icon-button ui-icon-button-${size} ui-icon-button-${tone}${
        showLabel ? " ui-icon-button-with-label" : ""
      } ${className}`.trim()}
      aria-label={label}
      title={title ?? label}
      {...props}
    >
      <span className="ui-icon-button-glyph" aria-hidden="true">
        {icon}
      </span>
      {showLabel && (
        <span className="ui-icon-button-label">{children ?? label}</span>
      )}
    </button>
  );
}

export type { IconButtonSize, IconButtonTone };
