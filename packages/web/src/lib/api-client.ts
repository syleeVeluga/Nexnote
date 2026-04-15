import type {
  Register,
  Login,
  UpdatePage,
  PageStatus,
  ActorType,
  RevisionSource,
  WorkspaceRole,
  RevisionDiffDto,
} from "@nexnote/shared";

const BASE_URL = "/api/v1";

let token: string | null = localStorage.getItem("nexnote_token");

export function setToken(t: string | null) {
  token = t;
  if (t) {
    localStorage.setItem("nexnote_token", t);
  } else {
    localStorage.removeItem("nexnote_token");
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

function buildQuery(params: Record<string, string | number | null | undefined>): string {
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
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const body = await res.json();

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
  list(workspaceId: string, params?: { parentFolderId?: string | null; limit?: number; offset?: number }) {
    const q = buildQuery({
      limit: params?.limit,
      offset: params?.offset,
      parentFolderId: params?.parentFolderId,
    });
    return request<Paginated<Folder>>(
      `/workspaces/${workspaceId}/folders${q}`,
    );
  },
  create(workspaceId: string, data: { name: string; slug: string; parentFolderId?: string | null }) {
    return request<{ data: Folder }>(
      `/workspaces/${workspaceId}/folders`,
      { method: "POST", body: JSON.stringify(data) },
    );
  },
};

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export interface Page {
  id: string;
  workspaceId: string;
  folderId: string | null;
  title: string;
  slug: string;
  status: PageStatus;
  sortOrder: number;
  currentRevisionId: string | null;
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
}

export type { RevisionDiffDto };

export interface CompareResultDto {
  from: string;
  to: string;
  diffMd: string;
  diffOpsJson: unknown[] | null;
  changedBlocks: number;
}

export const pages = {
  list(workspaceId: string, params?: { folderId?: string; status?: string; limit?: number; offset?: number }) {
    const q = buildQuery({
      limit: params?.limit,
      offset: params?.offset,
      folderId: params?.folderId,
      status: params?.status,
    });
    return request<Paginated<Page>>(
      `/workspaces/${workspaceId}/pages${q}`,
    );
  },
  get(workspaceId: string, pageId: string) {
    return request<{ page: Page; currentRevision: Revision | null }>(
      `/workspaces/${workspaceId}/pages/${pageId}`,
    );
  },
  create(
    workspaceId: string,
    data: { title: string; slug: string; folderId?: string | null; contentMd?: string; contentJson?: Record<string, unknown> },
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
    return request<void>(
      `/workspaces/${workspaceId}/pages/${pageId}`,
      { method: "DELETE" },
    );
  },

  createRevision(
    workspaceId: string,
    pageId: string,
    data: { contentMd: string; contentJson?: Record<string, unknown>; revisionNote?: string },
  ) {
    return request<{ revision: Revision }>(
      `/workspaces/${workspaceId}/pages/${pageId}/revisions`,
      { method: "POST", body: JSON.stringify(data) },
    );
  },
  listRevisions(workspaceId: string, pageId: string, params?: { limit?: number; offset?: number }) {
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
};
