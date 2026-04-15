import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { docs as docsApi, type PublicDocListItem } from "../lib/api-client.js";
import "../styles/docs.css";

export function PublicDocListPage() {
  const { t } = useTranslation("docs");
  const { workspaceSlug } = useParams<{ workspaceSlug: string }>();

  const [workspaceName, setWorkspaceName] = useState("");
  const [docList, setDocList] = useState<PublicDocListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!workspaceSlug) return;
    let cancelled = false;
    setLoading(true);

    docsApi
      .list(workspaceSlug)
      .then((res) => {
        if (cancelled) return;
        setWorkspaceName(res.workspace.name);
        setDocList(res.docs);
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
  }, [workspaceSlug]);

  if (loading) {
    return <div className="doc-page loading">{t("loading")}</div>;
  }

  if (notFound) {
    return (
      <div className="doc-page doc-not-found">
        <h1>{t("notFound")}</h1>
      </div>
    );
  }

  return (
    <div className="doc-page">
      <header className="doc-header">
        <div className="doc-header-inner">
          <span className="doc-header-title">{workspaceName}</span>
        </div>
      </header>

      <div className="doc-list-container">
        <h1 className="doc-list-title">{t("title")}</h1>

        {docList.length === 0 ? (
          <p className="doc-list-empty">{t("noDocs")}</p>
        ) : (
          <ul className="doc-list">
            {docList.map((doc) => (
              <li key={doc.id} className="doc-list-item">
                <Link to={doc.publicPath} className="doc-list-link">
                  <span className="doc-list-link-title">{doc.title}</span>
                  <span className="doc-list-link-meta">
                    {t("version", { version: doc.versionNo })}
                    <span className="doc-meta-sep">&middot;</span>
                    {new Date(doc.publishedAt).toLocaleDateString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
