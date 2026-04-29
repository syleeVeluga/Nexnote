import type { ReactNode } from "react";
import { StatusDot } from "../ui/StatusDot.js";
import { Breadcrumbs, type TopBarCrumb } from "./Breadcrumbs.js";

interface TopBarProps {
  breadcrumbs: TopBarCrumb[];
  actions?: ReactNode;
  statusLabel?: string;
  className?: string;
}

export function TopBar({
  breadcrumbs,
  actions,
  statusLabel,
  className = "",
}: TopBarProps) {
  return (
    <header className={`top-bar ${className}`.trim()}>
      <Breadcrumbs breadcrumbs={breadcrumbs} />
      <div className="top-bar-actions">
        {statusLabel && (
          <span className="top-bar-status">
            <StatusDot tone="active" pulse label={statusLabel} />
            {statusLabel}
          </span>
        )}
        {actions}
      </div>
    </header>
  );
}

export type { TopBarCrumb };
