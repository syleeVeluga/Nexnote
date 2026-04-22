import type { TFunction } from "i18next";

export function humanizePredicate(predicate: string) {
  return predicate.replace(/_/g, " ");
}

export function getPredicateDisplayLabel(
  t: TFunction,
  predicate: string,
): string {
  return t(`predicateLabels.${predicate}`, {
    ns: "editor",
    defaultValue: humanizePredicate(predicate),
  });
}
