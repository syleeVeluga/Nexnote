import {
  QUEUE_KEYS,
  type QueueKey,
  type Register,
  type Login,
  type UpdatePage,
  type PageStatus,
  type ActorType,
  type RevisionSource,
  type WorkspaceRole,
  type RevisionDiffDto,
  type GraphNode,
  type GraphEdge,
  type GraphData,
  type EntityProvenance,
  type IngestionAction,
  type IngestionStatus,
  type DecisionStatus,
} from "@wekiflow/shared";

const BASE_URL = "/api/v1";

let token: string | null = localStorage.getItem("wekiflow_token");

export function setToken(t: string | null) {
  token = t;
  if (t) {
    localStorage.setItem("wekiflow_token", t);
  } else {
    localStorage.removeItem("wekiflow_token");
  }
}

export function getToken() {
  return token;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function buildQuery(
  params: Record<string, string | number | null | undefined>,
): string {
  const qs = new URLSearchParams();
  for (const [key, val] of Object.entries(params)) {
    if (val != null && val !== "") {
      qs.set(key, String(val));
    }
  }
  const q = qs.toString();
  return q ? `?${q}` : "";
}

async function request<T>(
  path: string,
  options: RequestInit & { skipAuth?: boolean } = {},
): Promise<T> {
  const { skipAuth, ...fetchOptions } = options;
  const headers: Record<string, string> = {
    ...(fetchOptions.headers as Record<string, string>),
  };

  if (fetchOptions.body != null && headers["Content-Type"] == null) {
    headers["Content-Type"] = "application/json";
  }

  if (token && !skipAuth) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...fetchOptions,
    headers,
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const rawText = await res.text();
  let body: { code?: string; error?: string; [key: string]: unknown } = {};
  if (rawText.length > 0) {
    try {
      body = JSON.parse(rawText);
    } catch {
      if (res.ok) {
        throw new ApiError(
          res.status,
          "INVALID_JSON",
          "Server returned a non-JSON response",
        );
      }
      // For error responses with non-JSON bodies, fall through with empty body
      // so the status-based ApiError below still fires with a sensible message.
    }
  }

  if (!res.ok) {
    throw new ApiError(
      res.status,
      body.code ?? "UNKNOWN",
      body.error ?? res.statusText,
    );
  }

  return body as T;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
  createdAt?: string;
}

interface AuthResponse {
  token: string;
  user: User;
}

export const auth = {
  register(data: Register) {
    return request<AuthResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  login(data: Login) {
    return request<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  me() {
    return request<{ user: User }>("/auth/me");
  },
};

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  defaultAiPolicy: string | null;
  role?: WorkspaceRole;
  createdAt: string;
  updatedAt: string;
}

interface Paginated<T> {
  data: T[];
  total: number;
}

export const workspaces = {
  list(params?: { limit?: number; offset?: number }) {
    const q = buildQuery({ limit: params?.limit, offset: params?.offset });
    return request<Paginated<Workspace>>(`/workspaces${q}`);
  },
  get(id: string) {
    return request<Workspace & { role: WorkspaceRole }>(`/workspaces/${id}`);
  },
  create(data: { name: string; slug: string }) {
    return request<Workspace>("/workspaces", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  update(id: string, data: { name?: string }) {
    return request<Workspace>(`/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },
};

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export interface Folder {
  id: string;
  workspaceId: string;
  parentFolderId: string | null;
  name: string;
  slug: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export const folders = {
  list(
    workspaceId: string,
    params?: {
      parentFolderId?: string | null;
      limit?: number;
      offset?: number;
    },
  ) {
    const q = buildQuery({
      limit: params?.limit,
      offset: params?.offset,
      parentFolderId: params?.parentFolderId,
    });
    return request<Paginated<Folder>>(`/workspaces/${workspaceId}/folders${q}`);
  },
  create(
    workspaceId: string,
    data: { name: string; slug: string; parentFolderId?: string | null },
  ) {
    return request<{ data: Folder }>(`/workspaces/${workspaceId}/folders`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },
  patch(
    workspaceId: string,
    folderId: string,
    data: { name?: string; slug?: string; parentFolderId?: string | null },
  ) {
    return request<{ data: Folder }>(
      `/workspaces/${workspaceId}/folders/${folderId}`,
      { method: "PATCH", body: JSON.stringify(data) },
    );
  },
  delete(workspaceId: string, folderId: string) {
    return request<void>(`/workspaces/${workspaceId}/folders/${folderId}`, {
      method: "DELETE",
    });
  },
};

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export interface Page {
  id: string;
  workspaceId: string;
  parentPageId: string | null;
  title: string;
  slug: string;
  status: PageStatus;
  sortOrder: number;
  currentRevisionId: string | null;
  lastAiUpdatedAt: string | null;
  lastHumanEditedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Revision {
  id: string;
  pageId: string;
  baseRevisionId: string | null;
  actorUserId: string | null;
  modelRunId: string | null;
  actorType: ActorType;
  source: RevisionSource;
  contentMd: string;
  contentJson: unknown;
  revisionNote: string | null;
  createdAt: string;
}

export interface RevisionSummary {
  id: string;
  pageId: string;
  baseRevisionId: string | null;
  actorUserId: string | null;
  actorType: ActorType;
  source: RevisionSource;
  revisionNote: string | null;
  createdAt: string;
  changedBlocks: number | null;
  sourceIngestionId: string | null;
  sourceDecisionId: string | null;
}

export type { RevisionDiffDto };

export interface CompareResultDto {
  from: string;
  to: string;
  diffMd: string;
  diffOpsJson: unknown[] | null;
  changedBlocks: number;
}

// Re-export shared types for consumers importing from api-client
export type {
  GraphNode,
  GraphEdge,
  GraphData,
  EntityProvenance,
} from "@wekiflow/shared";
export type {
  IngestionAction,
  IngestionStatus,
  DecisionStatus,
} from "@wekiflow/shared";

export const pages = {
  list(
    workspaceId: string,
    params?: {
      parentPageId?: string;
      status?: string;
      limit?: number;
      offset?: number;
    },
  ) {
    const q = buildQuery({
      limit: params?.limit,
      offset: params?.offset,
      parentPageId: params?.parentPageId,
      status: params?.status,
    });
    return request<Paginated<Page>>(`/workspaces/${workspaceId}/pages${q}`);
  },
  get(workspaceId: string, pageId: string) {
    return request<{ page: Page; currentRevision: Revision | null }>(
      `/workspaces/${workspaceId}/pages/${pageId}`,
    );
  },
  create(
    workspaceId: string,
    data: {
      title: string;
      slug: string;
      parentPageId?: string | null;
      contentMd?: string;
      contentJson?: Record<string, unknown>;
    },
  ) {
    return request<{ page: Page; revision: Revision }>(
      `/workspaces/${workspaceId}/pages`,
      { method: "POST", body: JSON.stringify(data) },
    );
  },
  update(workspaceId: string, pageId: string, data: UpdatePage) {
    return request<{ page: Page }>(
      `/workspaces/${workspaceId}/pages/${pageId}`,
      { method: "PATCH", body: JSON.stringify(data) },
    );
  },
  delete(workspaceId: string, pageId: string) {
    return request<{
      deletedPageIds: string[];
      deletedCount: number;
      rootTitle: string;
    }>(`/workspaces/${workspaceId}/pages/${pageId}`, { method: "DELETE" });
  },
  unpublish(workspaceId: string, pageId: string) {
    return request<{ unpublishedCount: number }>(
      `/workspaces/${workspaceId}/pages/${pageId}/unpublish`,
      { method: "POST", body: "{}" },
    );
  },
  listTrash(workspaceId: string) {
    return request<{
      data: Array<{
        id: string;
        title: string;
        slug: string;
        deletedAt: string | null;
        deletedByUserId: string | null;
        deletedByUserName: string | null;
        descendantCount: number;
      }>;
      total: number;
    }>(`/workspaces/${workspaceId}/pages/trash`);
  },
  restore(workspaceId: string, pageId: string) {
    return request<{
      restoredPageIds: string[];
      restoredCount: number;
      rootTitle: string;
    }>(`/workspaces/${workspaceId}/pages/${pageId}/restore`, {
      method: "POST",
      body: "{}",
    });
  },
  purge(workspaceId: string, pageId: string) {
    return request<{ purgedPageIds: string[]; purgedCount: number }>(
      `/workspaces/${workspaceId}/pages/${pageId}/purge`,
      { method: "DELETE" },
    );
  },

  createRevision(
    workspaceId: string,
    pageId: string,
    data: {
      contentMd: string;
      contentJson?: Record<string, unknown>;
      revisionNote?: string;
    },
  ) {
    return request<{ revision: Revision }>(
      `/workspaces/${workspaceId}/pages/${pageId}/revisions`,
      { method: "POST", body: JSON.stringify(data) },
    );
  },
  listRevisions(
    workspaceId: string,
    pageId: string,
    params?: { limit?: number; offset?: number },
  ) {
    const q = buildQuery({ limit: params?.limit, offset: params?.offset });
    return request<Paginated<RevisionSummary>>(
      `/workspaces/${workspaceId}/pages/${pageId}/revisions${q}`,
    );
  },
  getRevision(workspaceId: string, pageId: string, revisionId: string) {
    return request<{ revision: Revision }>(
      `/workspaces/${workspaceId}/pages/${pageId}/revisions/${revisionId}`,
    );
  },
  getRevisionDiff(workspaceId: string, pageId: string, revisionId: string) {
    return request<{ diff: RevisionDiffDto }>(
      `/workspaces/${workspaceId}/pages/${pageId}/revisions/${revisionId}/diff`,
    );
  },
  rollbackRevision(
    workspaceId: string,
    pageId: string,
    revisionId: string,
    data?: { revisionNote?: string },
  ) {
    return request<{ revision: Revision }>(
      `/workspaces/${workspaceId}/pages/${pageId}/revisions/${revisionId}/rollback`,
      { method: "POST", body: JSON.stringify(data ?? {}) },
    );
  },
  compareRevisions(
    workspaceId: string,
    pageId: string,
    fromId: string,
    toId: string,
  ) {
    const q = buildQuery({ from: fromId, to: toId });
    return request<CompareResultDto>(
      `/workspaces/${workspaceId}/pages/${pageId}/revisions/compare${q}`,
    );
  },

  graph(
    workspaceId: string,
    pageId: string,
    params?: {
      depth?: number;
      limit?: number;
      minConfidence?: number;
      locale?: "ko" | "en";
    },
  ) {
    const q = buildQuery({
      depth: params?.depth,
      limit: params?.limit,
      minConfidence: params?.minConfidence,
      locale: params?.locale,
    });
    return request<GraphData>(
      `/workspaces/${workspaceId}/pages/${pageId}/graph${q}`,
    );
  },

  entityProvenance(
    workspaceId: string,
    entityId: string,
    params?: { limit?: number; locale?: "ko" | "en"; signal?: AbortSignal },
  ) {
    const q = buildQuery({ limit: params?.limit, locale: params?.locale });
    return request<EntityProvenance>(
      `/workspaces/${workspaceId}/entities/${entityId}/provenance${q}`,
      { signal: params?.signal },
    );
  },

  publish(workspaceId: string, pageId: string, data?: { revisionId?: string }) {
    return request<{ snapshot: PublishedSnapshotSummary }>(
      `/workspaces/${workspaceId}/pages/${pageId}/publish`,
      { method: "POST", body: JSON.stringify(data ?? {}) },
    );
  },

  search(
    workspaceId: string,
    params: { q: string; limit?: number; offset?: number },
  ) {
    const q = buildQuery({
      q: params.q,
      limit: params.limit,
      offset: params.offset,
    });
    return request<{ data: Page[]; total: number; q: string }>(
      `/workspaces/${workspaceId}/pages/search${q}`,
    );
  },

  async aiEdit(
    workspaceId: string,
    pageId: string,
    data: {
      mode: string;
      instruction: string;
      selection?: { from: number; to: number; text: string };
    },
    onChunk: (text: string) => void,
    onDone: (result: string, baseRevisionId: string) => void,
    onError: (message: string) => void,
  ): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(
      `${BASE_URL}/workspaces/${workspaceId}/pages/${pageId}/ai-edit`,
      { method: "POST", headers, body: JSON.stringify(data) },
    );

    if (!res.ok || !res.body) {
      onError(`HTTP ${res.status}`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const eventMatch = /^event: (\S+)/.exec(part);
        const dataMatch = /^data: (.+)$/m.exec(part);
        if (!eventMatch || !dataMatch) continue;
        const event = eventMatch[1];
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(dataMatch[1]);
        } catch {
          continue;
        }

        if (event === "chunk") onChunk((payload.text as string) ?? "");
        else if (event === "done")
          onDone(
            (payload.result as string) ?? "",
            (payload.baseRevisionId as string) ?? "",
          );
        else if (event === "error")
          onError((payload.message as string) ?? "Unknown error");
      }
    }
  },

  reformat(
    workspaceId: string,
    pageId: string,
    data?: { instructions?: string },
  ) {
    return request<{
      jobId: string | null;
      status: "queued" | "already_pending";
      decisionId?: string;
    }>(`/workspaces/${workspaceId}/pages/${pageId}/reformat`, {
      method: "POST",
      body: JSON.stringify(data ?? {}),
    });
  },
};

// ---------------------------------------------------------------------------
// Ingestions & Decisions (supervision loop — stages ③/④)
// ---------------------------------------------------------------------------

export interface IngestionSummary {
  id: string;
  workspaceId: string;
  apiTokenId: string;
  sourceName: string;
  externalRef: string | null;
  idempotencyKey: string;
  contentType: string;
  titleHint: string | null;
  status: IngestionStatus;
  receivedAt: string;
  processedAt: string | null;
  hasOriginal?: boolean;
  originalSizeBytes?: number | null;
}

export interface IngestionDetail extends IngestionSummary {
  rawPayload: Record<string, unknown>;
  normalizedText: string | null;
  decisions: DecisionSummary[];
}

interface DecisionBase {
  id: string;
  ingestionId: string;
  targetPageId: string | null;
  proposedRevisionId: string | null;
  modelRunId: string;
  action: IngestionAction;
  status: DecisionStatus;
  proposedPageTitle: string | null;
  confidence: number;
  createdAt: string;
}

export type CandidateMatchSource = "title" | "fts" | "trigram" | "entity";

export interface DecisionCandidate {
  id: string;
  title: string;
  slug: string;
  matchSources?: CandidateMatchSource[];
}

export interface DecisionConflict {
  type: "conflict_with_human_edit";
  humanRevisionId: string;
  humanUserId: string | null;
  humanEditedAt: string;
  humanRevisionNote: string | null;
  baseRevisionId: string | null;
}

export interface DecisionSummary extends DecisionBase {
  rationale: {
    reason?: string;
    candidates?: DecisionCandidate[];
    baseRevisionId?: string | null;
    conflict?: DecisionConflict;
  } | null;
}

export interface DecisionListItem extends DecisionBase {
  reason: string | null;
  hasConflict?: boolean;
  ingestion: {
    sourceName: string;
    titleHint: string | null;
    receivedAt: string;
  };
  targetPage: {
    id: string;
    title: string;
    slug: string | null;
  } | null;
}

export interface DecisionDetail extends Omit<DecisionListItem, "ingestion"> {
  candidates: DecisionCandidate[];
  conflict: DecisionConflict | null;
  ingestion: {
    id: string;
    sourceName: string;
    titleHint: string | null;
    receivedAt: string;
    normalizedText: string | null;
    rawPayload: Record<string, unknown>;
    contentType: string;
    externalRef: string | null;
    hasOriginal: boolean;
    originalSizeBytes: number | null;
  };
  proposedRevision: {
    id: string;
    contentMd: string;
    diffMd: string | null;
    changedBlocks: number | null;
  } | null;
}

export interface DecisionCounts {
  auto_applied: number;
  suggested: number;
  needs_review: number;
  approved: number;
  rejected: number;
  noop: number;
  failed: number;
  pending: number;
}

export const ingestions = {
  list(
    workspaceId: string,
    params?: { status?: IngestionStatus; limit?: number; offset?: number },
  ) {
    const q = buildQuery({
      status: params?.status,
      limit: params?.limit,
      offset: params?.offset,
    });
    return request<{
      items: IngestionSummary[];
      total: number;
      limit: number;
      offset: number;
    }>(`/workspaces/${workspaceId}/ingestions${q}`);
  },
  get(workspaceId: string, ingestionId: string) {
    return request<IngestionDetail>(
      `/workspaces/${workspaceId}/ingestions/${ingestionId}`,
    );
  },
  async downloadOriginal(
    workspaceId: string,
    ingestionId: string,
  ): Promise<void> {
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(
      `${BASE_URL}/workspaces/${workspaceId}/ingestions/${ingestionId}/original`,
      { method: "GET", headers },
    );
    if (!res.ok) {
      let body: { code?: string; error?: string } = {};
      try {
        body = await res.json();
      } catch {
        /* non-JSON body, ignore */
      }
      throw new ApiError(
        res.status,
        body.code ?? "UNKNOWN",
        body.error ?? res.statusText,
      );
    }
    // Pull the filename the server suggested; fall back to a generic one.
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const filename = match ? decodeURIComponent(match[1]) : `ingestion-${ingestionId}`;

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  },
  async importFile(
    workspaceId: string,
    file: File,
    options?: { titleHint?: string; idempotencyKey?: string; forceRefresh?: boolean },
  ): Promise<IngestionSummary & { replayed: boolean }> {
    const form = new FormData();
    form.append("file", file);
    if (options?.titleHint) form.append("titleHint", options.titleHint);
    if (options?.idempotencyKey)
      form.append("idempotencyKey", options.idempotencyKey);
    if (options?.forceRefresh) form.append("forceRefresh", "true");

    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(
      `${BASE_URL}/workspaces/${workspaceId}/ingestions/upload`,
      { method: "POST", headers, body: form },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(
        res.status,
        body.code ?? "UNKNOWN",
        body.error ?? res.statusText,
      );
    }
    return { ...(body as IngestionSummary), replayed: res.status === 200 };
  },
  async importUrl(
    workspaceId: string,
    body: {
      url: string;
      mode?: "readable";
      titleHint?: string;
      idempotencyKey?: string;
      forceRefresh?: boolean;
    },
  ): Promise<IngestionSummary & { replayed: boolean }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(
      `${BASE_URL}/workspaces/${workspaceId}/ingestions/url`,
      { method: "POST", headers, body: JSON.stringify(body) },
    );
    const responseBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(
        res.status,
        responseBody.code ?? "UNKNOWN",
        responseBody.error ?? res.statusText,
      );
    }
    return {
      ...(responseBody as IngestionSummary),
      replayed: res.status === 200,
    };
  },
  async importText(
    workspaceId: string,
    body: {
      content: string;
      sourceName?: string;
      contentType?: string;
      titleHint?: string;
      idempotencyKey?: string;
    },
  ): Promise<IngestionSummary & { replayed: boolean }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(
      `${BASE_URL}/workspaces/${workspaceId}/ingestions/text`,
      { method: "POST", headers, body: JSON.stringify(body) },
    );
    const responseBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new ApiError(
        res.status,
        responseBody.code ?? "UNKNOWN",
        responseBody.error ?? res.statusText,
      );
    }
    return {
      ...(responseBody as IngestionSummary),
      replayed: res.status === 200,
    };
  },
};

export const decisions = {
  list(
    workspaceId: string,
    params?: {
      status?: DecisionStatus | DecisionStatus[];
      sinceDays?: number;
      limit?: number;
      offset?: number;
    },
  ) {
    const statusParam = Array.isArray(params?.status)
      ? params?.status.join(",")
      : params?.status;
    const q = buildQuery({
      status: statusParam,
      sinceDays: params?.sinceDays,
      limit: params?.limit,
      offset: params?.offset,
    });
    return request<{
      data: DecisionListItem[];
      total: number;
      limit: number;
      offset: number;
    }>(`/workspaces/${workspaceId}/decisions${q}`);
  },
  counts(workspaceId: string) {
    return request<{ counts: DecisionCounts }>(
      `/workspaces/${workspaceId}/decisions/counts`,
    );
  },
  get(workspaceId: string, decisionId: string) {
    return request<DecisionDetail>(
      `/workspaces/${workspaceId}/decisions/${decisionId}`,
    );
  },
  approve(workspaceId: string, decisionId: string) {
    return request<
      | {
          status: "applied";
          action: "create" | "update" | "append";
          ingestionId: string;
          pageId: string;
          revisionId: string;
        }
      | {
          status: "acknowledged";
          action: "noop" | "needs_review";
          ingestionId: string;
        }
    >(`/workspaces/${workspaceId}/decisions/${decisionId}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
  reject(workspaceId: string, decisionId: string, reason?: string) {
    return request<{ status: "rejected"; ingestionId: string }>(
      `/workspaces/${workspaceId}/decisions/${decisionId}/reject`,
      {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {}),
      },
    );
  },
  edit(
    workspaceId: string,
    decisionId: string,
    data: {
      action?: IngestionAction;
      targetPageId?: string | null;
      proposedPageTitle?: string | null;
    },
  ) {
    return request<{
      id: string;
      action: IngestionAction;
      targetPageId: string | null;
      proposedPageTitle: string | null;
      proposedRevisionId: string | null;
      status: DecisionStatus;
    }>(`/workspaces/${workspaceId}/decisions/${decisionId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },
};

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

export type ActivityActorType = "ai" | "user" | "system";
export type ActivityEntityType =
  | "page"
  | "ingestion"
  | "folder"
  | "workspace"
  | "decision";

export interface ActivityItem {
  id: string;
  createdAt: string;
  action: string;
  entityType: string;
  entityId: string;
  actor: {
    type: ActivityActorType;
    user: { id: string; name: string; email: string } | null;
    aiModel: { provider: string; modelName: string } | null;
  };
  entity: {
    type: string;
    id: string;
    label: string | null;
    slug: string | null;
    deleted: boolean;
  } | null;
  context: {
    source: string | null;
    ingestion: { id: string; sourceName: string } | null;
    decisionId: string | null;
    revisionId: string | null;
  };
}

export interface ActivityListParams {
  actorType?: ActivityActorType;
  entityType?: ActivityEntityType;
  action?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export const activity = {
  list(workspaceId: string, params?: ActivityListParams) {
    const q = buildQuery({
      actorType: params?.actorType,
      entityType: params?.entityType,
      action: params?.action,
      from: params?.from,
      to: params?.to,
      limit: params?.limit,
      offset: params?.offset,
    });
    return request<{
      data: ActivityItem[];
      total: number;
      limit: number;
      offset: number;
    }>(`/workspaces/${workspaceId}/activity${q}`);
  },
};

// ---------------------------------------------------------------------------
// Admin — Queue health (BullMQ visibility)
// ---------------------------------------------------------------------------

export { QUEUE_KEYS, type QueueKey };

export interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
  stalled: number;
}

export interface QueueSummary {
  key: QueueKey;
  name: string;
  counts: QueueCounts;
  stalledCountCapped: boolean;
  isPaused: boolean;
}

export interface FailedJob {
  id: string | null;
  name: string;
  attemptsMade: number;
  maxAttempts: number | null;
  failedReason: string | null;
  stackFirstLine: string | null;
  timestamp: string | null;
  processedOn: string | null;
  finishedOn: string | null;
  workspaceId: string | null;
  ingestionId: string | null;
  pageId: string | null;
  isCrossWorkspace: boolean;
}

export const adminQueues = {
  overview(workspaceId: string) {
    return request<{ queues: QueueSummary[] }>(
      `/workspaces/${workspaceId}/admin/queues`,
    );
  },
  failed(workspaceId: string, queueName: QueueKey) {
    return request<{ queue: QueueKey; items: FailedJob[] }>(
      `/workspaces/${workspaceId}/admin/queues/${queueName}/failed`,
    );
  },
  stalled(workspaceId: string, queueName: QueueKey) {
    return request<{ queue: QueueKey; items: FailedJob[] }>(
      `/workspaces/${workspaceId}/admin/queues/${queueName}/stalled`,
    );
  },
  retry(workspaceId: string, queueName: QueueKey, jobId: string) {
    return request<{ status: "retried"; jobId: string }>(
      `/workspaces/${workspaceId}/admin/queues/${queueName}/jobs/${encodeURIComponent(jobId)}/retry`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },
  remove(workspaceId: string, queueName: QueueKey, jobId: string) {
    return request<{ status: "removed"; jobId: string }>(
      `/workspaces/${workspaceId}/admin/queues/${queueName}/jobs/${encodeURIComponent(jobId)}/remove`,
      { method: "POST", body: JSON.stringify({}) },
    );
  },
};

// ---------------------------------------------------------------------------
// Published Snapshots
// ---------------------------------------------------------------------------

export interface PublishedSnapshotSummary {
  id: string;
  pageId: string;
  versionNo: number;
  publicPath: string;
  title: string;
  isLive: boolean;
  publishedAt: string;
}

export interface PublicDoc {
  id: string;
  pageId: string;
  title: string;
  html: string;
  markdown: string;
  toc: TocEntry[] | null;
  versionNo: number;
  publicPath: string;
  publishedAt: string;
  workspace: {
    name: string;
    slug: string;
  };
}

export interface TocEntry {
  id: string;
  text: string;
  level: number;
}

export interface PublicDocListItem {
  id: string;
  pageId: string;
  title: string;
  publicPath: string;
  versionNo: number;
  publishedAt: string;
}

export const docs = {
  get(workspaceSlug: string, pagePath: string) {
    return request<PublicDoc>(`/docs/${workspaceSlug}/${pagePath}`, {
      skipAuth: true,
    });
  },
  list(workspaceSlug: string) {
    return request<{
      workspace: { name: string; slug: string };
      docs: PublicDocListItem[];
    }>(`/docs/${workspaceSlug}`, { skipAuth: true });
  },
};
