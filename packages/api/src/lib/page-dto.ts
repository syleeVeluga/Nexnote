import { pages, pageRevisions, publishedSnapshots } from "@wekiflow/db";

type DateLike = Date | string | null | undefined;

function toIso(value: DateLike): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export const pageSummarySelect = {
  id: pages.id,
  workspaceId: pages.workspaceId,
  parentPageId: pages.parentPageId,
  parentFolderId: pages.parentFolderId,
  title: pages.title,
  slug: pages.slug,
  status: pages.status,
  sortOrder: pages.sortOrder,
  currentRevisionId: pages.currentRevisionId,
  lastAiUpdatedAt: pages.lastAiUpdatedAt,
  lastHumanEditedAt: pages.lastHumanEditedAt,
  createdAt: pages.createdAt,
  updatedAt: pages.updatedAt,
  latestRevisionActorType: pageRevisions.actorType,
  latestRevisionSource: pageRevisions.source,
  latestRevisionCreatedAt: pageRevisions.createdAt,
  latestRevisionSourceIngestionId: pageRevisions.sourceIngestionId,
  latestRevisionSourceDecisionId: pageRevisions.sourceDecisionId,
  publishedAt: publishedSnapshots.publishedAt,
  isLivePublished: publishedSnapshots.isLive,
};

export interface PageDtoInput {
  id: string;
  workspaceId: string;
  parentPageId: string | null;
  parentFolderId?: string | null;
  title: string;
  slug: string;
  status: string;
  sortOrder: number;
  currentRevisionId: string | null;
  lastAiUpdatedAt?: DateLike;
  lastHumanEditedAt?: DateLike;
  createdAt: DateLike;
  updatedAt: DateLike;
  latestRevisionActorType?: string | null;
  latestRevisionSource?: string | null;
  latestRevisionCreatedAt?: DateLike;
  latestRevisionSourceIngestionId?: string | null;
  latestRevisionSourceDecisionId?: string | null;
  publishedAt?: DateLike;
  isLivePublished?: boolean | null;
}

export function mapPageDto(page: PageDtoInput) {
  return {
    id: page.id,
    workspaceId: page.workspaceId,
    parentPageId: page.parentPageId,
    parentFolderId: page.parentFolderId ?? null,
    title: page.title,
    slug: page.slug,
    status: page.status,
    sortOrder: page.sortOrder,
    currentRevisionId: page.currentRevisionId,
    lastAiUpdatedAt: toIso(page.lastAiUpdatedAt),
    lastHumanEditedAt: toIso(page.lastHumanEditedAt),
    createdAt: toIso(page.createdAt)!,
    updatedAt: toIso(page.updatedAt)!,
    latestRevisionActorType: page.latestRevisionActorType ?? null,
    latestRevisionSource: page.latestRevisionSource ?? null,
    latestRevisionCreatedAt: toIso(page.latestRevisionCreatedAt),
    latestRevisionSourceIngestionId:
      page.latestRevisionSourceIngestionId ?? null,
    latestRevisionSourceDecisionId: page.latestRevisionSourceDecisionId ?? null,
    publishedAt: toIso(page.publishedAt),
    isLivePublished: page.isLivePublished === true,
  };
}
