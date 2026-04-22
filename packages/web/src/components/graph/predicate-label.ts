import type { TFunction } from "i18next";

export function humanizePredicate(predicate: string) {
  return predicate.replace(/_/g, " ");
}

export function getPredicateDisplayLabel(
  t: TFunction,
  predicate: string,
  preferredLabel?: string | null,
): string {
  const fallbackLabel = humanizePredicate(predicate);
  const missingTranslation = `__missing_predicate_label__${predicate}`;
  const translatedLabel = t(`predicateLabels.${predicate}`, {
    ns: "editor",
    defaultValue: missingTranslation,
  });

  if (
    translatedLabel !== missingTranslation &&
    translatedLabel !== `predicateLabels.${predicate}`
  ) {
    return translatedLabel;
  }

  if (preferredLabel) {
    return preferredLabel;
  }

  return fallbackLabel;
}
