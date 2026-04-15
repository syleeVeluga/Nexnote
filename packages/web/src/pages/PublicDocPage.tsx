import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  docs as docsApi,
  type PublicDoc,
  type TocEntry,
} from "../lib/api-client.js";
import "../styles/docs.css";

function TocSidebar({ toc }: { toc: TocEntry[] }) {
  const { t } = useTranslation("docs");

  if (toc.length === 0) return null;

  return (
    <nav className="doc-toc">
      <h3 className="doc-toc-title">{t("tableOfContents")}</h3>
      <ul className="doc-toc-list">
        {toc.map((entry) => (
          <li
            key={entry.id}
            className="doc-toc-item"
            style={{ paddingLeft: `${(entry.level - 1) * 12}px` }}
          >
            <a href={`#${entry.id}`} className="doc-toc-link">
              {entry.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function PublicDocPage() {
  const { t } = useTranslation("docs");
  const { workspaceSlug, "*": pagePath } = useParams<{
    workspaceSlug: string;
    "*": string;
  }>();

  const [doc, setDoc] = useState<PublicDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!workspaceSlug || !pagePath) return;
    let cancelled = false;
    setLoading(true);
    setNotFound(false);

    docsApi
      .get(workspaceSlug, pagePath)
      .then((res) => {
        if (!cancelled) setDoc(res);
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceSlug, pagePath]);

  if (loading) {
    return <div className="doc-page loading">{t("loading")}</div>;
  }

  if (notFound || !doc) {
    return (
      <div className="doc-page doc-not-found">
        <h1>{t("notFound")}</h1>
        <p>{t("notFoundDescription")}</p>
        {workspaceSlug && (
          <Link to={`/docs/${workspaceSlug}`} className="doc-back-link">
            {t("backToList")}
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="doc-page">
      <header className="doc-header">
        <div className="doc-header-inner">
          <Link to={`/docs/${doc.workspace.slug}`} className="doc-back-link">
            {doc.workspace.name}
          </Link>
          <span className="doc-header-sep">/</span>
          <span className="doc-header-title">{doc.title}</span>
        </div>
      </header>

      <div className="doc-layout">
        {doc.toc && doc.toc.length > 0 && <TocSidebar toc={doc.toc} />}

        <article className="doc-content">
          <h1 className="doc-title">{doc.title}</h1>
          <div className="doc-meta">
            <span>{t("publishedOn", { date: new Date(doc.publishedAt).toLocaleDateString() })}</span>
            <span className="doc-meta-sep">&middot;</span>
            <span>{t("version", { version: doc.versionNo })}</span>
          </div>
          <div
            className="doc-body"
            dangerouslySetInnerHTML={{ __html: doc.html }}
          />
        </article>
      </div>
    </div>
  );
}
