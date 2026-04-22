export type SupportedLocale = "ko" | "en";

export function resolveSupportedLocale(
  language?: string | null,
): SupportedLocale {
  return language?.toLowerCase().startsWith("ko") ? "ko" : "en";
}
