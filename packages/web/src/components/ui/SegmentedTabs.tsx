import type { ReactNode } from "react";

interface SegmentedTab {
  id: string;
  label: string;
  count?: number;
  icon?: ReactNode;
  disabled?: boolean;
}

interface SegmentedTabsProps {
  tabs: SegmentedTab[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
}

export function SegmentedTabs({
  tabs,
  value,
  onChange,
  ariaLabel,
  className = "",
}: SegmentedTabsProps) {
  return (
    <div
      className={`ui-segmented-tabs ${className}`.trim()}
      role="tablist"
      aria-label={ariaLabel}
    >
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            className={`ui-segmented-tab${selected ? " active" : ""}`}
            role="tab"
            aria-selected={selected}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
          >
            {tab.icon && (
              <span className="ui-segmented-tab-icon">{tab.icon}</span>
            )}
            <span>{tab.label}</span>
            {typeof tab.count === "number" && (
              <span className="ui-segmented-tab-count">{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export type { SegmentedTab };
