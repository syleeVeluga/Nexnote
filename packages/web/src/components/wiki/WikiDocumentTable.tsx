import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Archive,
  Bot,
  CheckCircle2,
  Clock,
  FileText,
  UserRound,
} from "lucide-react";
import type { Page } from "../../lib/api-client.js";
import { Badge, type BadgeTone } from "../ui/Badge.js";
import { useTimeAgo } from "../../hooks/use-time-ago.js";

interface WikiDocumentTableProps {
  pages: Page[];
  emptyMessage: string;
  folderNames?: Map<string, string>;
  showFolder?: boolean;
}

function reflectionMeta(
  page: Page,
  t: ReturnType<typeof useTranslation>["t"],
): { label: string; tone: BadgeTone; icon: ReactNode } {
  if (page.isLivePublished || page.status === "published") {
    return {
      label: t("wiki.status.reflected", { defaultValue: "Reflected" }),
      tone: "teal",
      icon: <CheckCircle2 size={12} />,
    };
  }
  if (page.status === "archived") {
    return {
      label: t("wiki.status.archived", { defaultValue: "Archived" }),
      tone: "warm",
      icon: <Archive size={12} />,
    };
  }
  return {
    label: t("wiki.status.draft", { defaultValue: "Drafting" }),
    tone: "orange",
    icon: <Clock size={12} />,
  };
}

function registrationMeta(
  page: Page,
  t: ReturnType<typeof useTranslation>["t"],
): { label: string; tone: BadgeTone; icon: ReactNode } {
  if (page.latestRevisionActorType === "ai") {
    return {
      label: t("wiki.method.ai", { defaultValue: "AI auto" }),
      tone: "blue",
      icon: <Bot size={12} />,
    };
  }

  if (page.latestRevisionActorType === "user") {
    return {
      label: t("wiki.method.human", { defaultValue: "Manual" }),
      tone: "warm",
      icon: <UserRound size={12} />,
    };
  }

  if (page.latestRevisionActorType === "system") {
    return {
      label: t("wiki.method.system", { defaultValue: "System" }),
      tone: "warm",
      icon: <FileText size={12} />,
    };
  }

  return {
    label: t("wiki.method.manual", { defaultValue: "Manual" }),
    tone: "warm",
    icon: <FileText size={12} />,
  };
}

export function WikiDocumentTable({
  pages,
  emptyMessage,
  folderNames,
  showFolder = false,
}: WikiDocumentTableProps) {
  const { t } = useTranslation(["pages", "common"]);
  const navigate = useNavigate();
  const timeAgo = useTimeAgo();

  if (pages.length === 0) {
    return <div className="wiki-empty-table">{emptyMessage}</div>;
  }

  return (
    <div className="wiki-table-wrap">
      <table className="wiki-table">
        <thead>
          <tr>
            <th>{t("wiki.columns.title", { defaultValue: "Title" })}</th>
            <th>
              {t("wiki.columns.reflection", {
                defaultValue: "Bot status",
              })}
            </th>
            <th>
              {t("wiki.columns.method", {
                defaultValue: "Source",
              })}
            </th>
            {showFolder && (
              <th>
                {t("wiki.columns.folder", {
                  defaultValue: "Folder",
                })}
              </th>
            )}
            <th>
              {t("wiki.columns.updated", {
                defaultValue: "Recent change",
              })}
            </th>
          </tr>
        </thead>
        <tbody>
          {pages.map((page) => {
            const reflection = reflectionMeta(page, t);
            const registration = registrationMeta(page, t);
            const folderName =
              page.parentFolderId && folderNames
                ? folderNames.get(page.parentFolderId)
                : null;

            return (
              <tr
                key={page.id}
                className="wiki-table-row"
                onClick={() => navigate(`/pages/${page.id}`)}
              >
                <td className="wiki-title-cell">
                  <Link
                    to={`/pages/${page.id}`}
                    className="wiki-title-link"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <FileText size={15} aria-hidden="true" />
                    <span>
                      <strong>
                        {page.title || t("common:untitled")}
                      </strong>
                    </span>
                  </Link>
                </td>
                <td>
                  <Badge
                    tone={reflection.tone}
                    size="sm"
                    icon={reflection.icon}
                  >
                    {reflection.label}
                  </Badge>
                </td>
                <td>
                  <Badge
                    tone={registration.tone}
                    size="sm"
                    icon={registration.icon}
                  >
                    {registration.label}
                  </Badge>
                </td>
                {showFolder && (
                  <td className="wiki-muted-cell">
                    {folderName ??
                      t("wiki.rootFolder", { defaultValue: "Top level" })}
                  </td>
                )}
                <td className="wiki-muted-cell">
                  {timeAgo(page.updatedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
