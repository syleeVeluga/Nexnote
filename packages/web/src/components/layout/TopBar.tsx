import { ChevronRight } from "lucide-react";
import { NavLink } from "react-router-dom";
import type { ReactNode } from "react";
import { StatusDot } from "../ui/StatusDot.js";

interface TopBarCrumb {
  label: string;
  to?: string;
}

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
      <nav className="top-bar-breadcrumbs" aria-label="Breadcrumb">
        {breadcrumbs.map((crumb, index) => {
          const current = index === breadcrumbs.length - 1;
          const label = <span>{crumb.label}</span>;

          return (
            <span key={`${crumb.label}-${index}`} className="top-bar-crumb">
              {crumb.to && !current ? (
                <NavLink to={crumb.to}>{label}</NavLink>
              ) : (
                <span className={current ? "current" : ""}>{label}</span>
              )}
              {!current && <ChevronRight size={12} aria-hidden="true" />}
            </span>
          );
        })}
      </nav>
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
