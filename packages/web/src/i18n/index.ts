import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import enCommon from "./locales/en/common.json";
import enAuth from "./locales/en/auth.json";
import enEditor from "./locales/en/editor.json";
import enPages from "./locales/en/pages.json";
import koCommon from "./locales/ko/common.json";
import koAuth from "./locales/ko/auth.json";
import koEditor from "./locales/ko/editor.json";
import koPages from "./locales/ko/pages.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: enCommon, auth: enAuth, editor: enEditor, pages: enPages },
      ko: { common: koCommon, auth: koAuth, editor: koEditor, pages: koPages },
    },
    fallbackLng: "ko",
    defaultNS: "common",
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "nexnote_lang",
    },
  });

export default i18n;
