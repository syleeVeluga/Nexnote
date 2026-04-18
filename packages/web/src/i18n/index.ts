import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import enCommon from "./locales/en/common.json";
import enAuth from "./locales/en/auth.json";
import enEditor from "./locales/en/editor.json";
import enPages from "./locales/en/pages.json";
import enDocs from "./locales/en/docs.json";
import enReview from "./locales/en/review.json";
import enAdmin from "./locales/en/admin.json";
import koCommon from "./locales/ko/common.json";
import koAuth from "./locales/ko/auth.json";
import koEditor from "./locales/ko/editor.json";
import koPages from "./locales/ko/pages.json";
import koDocs from "./locales/ko/docs.json";
import koReview from "./locales/ko/review.json";
import koAdmin from "./locales/ko/admin.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: enCommon, auth: enAuth, editor: enEditor, pages: enPages, docs: enDocs, review: enReview, admin: enAdmin },
      ko: { common: koCommon, auth: koAuth, editor: koEditor, pages: koPages, docs: koDocs, review: koReview, admin: koAdmin },
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
