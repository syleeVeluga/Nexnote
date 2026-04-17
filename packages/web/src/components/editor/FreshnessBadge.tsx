import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { timeAgo } from "../../lib/time-ago.js";

interface FreshnessBadgeProps {
  lastAiUpdatedAt: string | null;
  lastHumanEditedAt: string | null;
  staleAfterDays?: number;
}

type Tone = "ai" | "human" | "stale" | "none";

export function FreshnessBadge({
  lastAiUpdatedAt,
  lastHumanEditedAt,
  staleAfterDays = 30,
}: FreshnessBadgeProps) {
  const { t } = useTranslation(["editor"]);

  const { tone, label, tooltip } = useMemo(() => {
    const aiTs = lastAiUpdatedAt ? new Date(lastAiUpdatedAt).getTime() : 0;
    const humanTs = lastHumanEditedAt ? new Date(lastHumanEditedAt).getTime() : 0;

    if (!aiTs && !humanTs) {
      return {
        tone: "none" as Tone,
        label: t("freshnessNever"),
        tooltip: t("freshnessTooltipNone"),
      };
    }

    const latestIsAi = aiTs >= humanTs;
    const latestStr = (latestIsAi ? lastAiUpdatedAt : lastHumanEditedAt) as string;
    const ageDays = (Date.now() - Math.max(aiTs, humanTs)) / (1000 * 60 * 60 * 24);
    const stale = ageDays > staleAfterDays;
    const ago = timeAgo(latestStr, t);

    const tooltipParts: string[] = [];
    if (lastAiUpdatedAt) {
      tooltipParts.push(
        t("freshnessTooltipAi", {
          date: new Date(lastAiUpdatedAt).toLocaleString(),
        }),
      );
    }
    if (lastHumanEditedAt) {
      tooltipParts.push(
        t("freshnessTooltipHuman", {
          date: new Date(lastHumanEditedAt).toLocaleString(),
        }),
      );
    }

    return {
      tone: (stale ? "stale" : latestIsAi ? "ai" : "human") as Tone,
      label: stale
        ? t("freshnessStale", { ago })
        : latestIsAi
          ? t("freshnessAiRecent", { ago })
          : t("freshnessHumanRecent", { ago }),
      tooltip: tooltipParts.join("\n"),
    };
  }, [lastAiUpdatedAt, lastHumanEditedAt, staleAfterDays, t]);

  return (
    <span className={`freshness-badge freshness-badge-${tone}`} title={tooltip}>
      {label}
    </span>
  );
}
