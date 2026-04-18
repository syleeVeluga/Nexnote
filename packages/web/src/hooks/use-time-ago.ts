import { useCallback } from "react";
import { useTranslation } from "react-i18next";

export function useTimeAgo() {
  const { t } = useTranslation("common");
  return useCallback(
    (iso: string | null | undefined): string => {
      if (!iso) return t("timeAgo.empty");
      const diff = Date.now() - new Date(iso).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return t("timeAgo.now");
      if (mins < 60) return t("timeAgo.minutes", { count: mins });
      const hours = Math.floor(mins / 60);
      if (hours < 24) return t("timeAgo.hours", { count: hours });
      const days = Math.floor(hours / 24);
      if (days < 30) return t("timeAgo.days", { count: days });
      return new Date(iso).toLocaleDateString();
    },
    [t],
  );
}
