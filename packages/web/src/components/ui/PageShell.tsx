import type { ReactNode } from "react";

interface PageShellProps {
  title?: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function PageShell({
  title,
  description,
  eyebrow,
  actions,
  children,
  className = "",
  contentClassName = "",
}: PageShellProps) {
  const hasHeader = title || description || eyebrow || actions;

  return (
    <section className={`page-shell ${className}`.trim()}>
      {hasHeader && (
        <header className="page-shell-header">
          <div className="page-shell-heading">
            {eyebrow && <p className="page-shell-eyebrow">{eyebrow}</p>}
            {title && <h1>{title}</h1>}
            {description && (
              <p className="page-shell-description">{description}</p>
            )}
          </div>
          {actions && <div className="page-shell-actions">{actions}</div>}
        </header>
      )}
      <div className={`page-shell-content ${contentClassName}`.trim()}>
        {children}
      </div>
    </section>
  );
}
