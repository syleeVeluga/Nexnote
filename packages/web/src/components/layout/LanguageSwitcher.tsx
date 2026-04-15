import { useTranslation } from "react-i18next";

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const current = i18n.language?.startsWith("ko") ? "ko" : "en";

  function toggle() {
    i18n.changeLanguage(current === "ko" ? "en" : "ko");
  }

  return (
    <button className="btn-lang" onClick={toggle} title={current === "ko" ? "English" : "한국어"}>
      {current === "ko" ? "EN" : "한국어"}
    </button>
  );
}
