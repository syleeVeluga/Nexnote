import "./load-test-env.ts";

import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

export interface AuthContext {
  token: string;
  userId: string;
  workspaceId: string;
  workspaceSlug: string;
}

export async function createAuthContext(
  app: FastifyInstance,
  prefix: string,
): Promise<AuthContext> {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@example.com`;
  const password = "password123";

  const registerResponse = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      email,
      password,
      name: "E2E Tester",
    },
  });
  assert.equal(registerResponse.statusCode, 201);

  const registerBody = registerResponse.json() as {
    token: string;
    user: { id: string };
  };
  const token = registerBody.token;

  const workspaceSlug = `${prefix}-${randomUUID().slice(0, 6)}`;
  const workspaceResponse = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: authHeaders(token),
    payload: {
      name: `${prefix} Workspace`,
      slug: workspaceSlug,
    },
  });
  assert.equal(workspaceResponse.statusCode, 201);

  const workspaceBody = workspaceResponse.json() as { id: string; slug: string };

  return {
    token,
    userId: registerBody.user.id,
    workspaceId: workspaceBody.id,
    workspaceSlug: workspaceBody.slug,
  };
}

export function authHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
  };
}
