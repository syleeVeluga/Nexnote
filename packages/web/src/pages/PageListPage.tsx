import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useWorkspace } from "../hooks/use-workspace.js";
import { pages as pagesApi, type Page } from "../lib/api-client.js";

export function PageListPage() {
  const { t } = useTranslation("pages");
  const { t: tc } = useTranslation("common");
  const { current } = useWorkspace();
  const navigate = useNavigate();
  const [pageList, setPageList] = useState<Page[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    setLoading(true);
    pagesApi
      .list(current.id, { limit: 50 })
      .then((res) => {
        if (!cancelled) {
          setPageList(res.data);
          setTotal(res.total);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [current]);

  if (!current) return null;

  return (
    <div className="page-list">
      <div className="page-list-header">
        <h1>{t("title")}</h1>
        <button
          className="btn-primary"
          onClick={() => navigate("/pages/new")}
        >
          {tc("newPage")}
        </button>
      </div>
      {loading ? (
        <p className="loading">{tc("loading")}</p>
      ) : pageList.length === 0 ? (
        <div className="empty-state">
          <p>{t("emptyState")}</p>
        </div>
      ) : (
        <>
          <table className="page-table">
            <thead>
              <tr>
                <th>{t("tableTitle")}</th>
                <th>{t("tableStatus")}</th>
                <th>{t("tableUpdated")}</th>
              </tr>
            </thead>
            <tbody>
              {pageList.map((page) => (
                <tr
                  key={page.id}
                  className="page-row"
                  onClick={() => navigate(`/pages/${page.id}`)}
                >
                  <td>
                    <Link to={`/pages/${page.id}`} className="page-title-link">
                      {page.title || tc("untitled")}
                    </Link>
                  </td>
                  <td>
                    <span className={`badge badge-${page.status}`}>
                      {page.status}
                    </span>
                  </td>
                  <td className="date-cell">
                    {new Date(page.updatedAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {total > pageList.length && (
            <p className="page-list-total">
              {t("showingOf", { shown: pageList.length, total })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
