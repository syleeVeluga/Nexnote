import type { FastifyReply } from "fastify";
import type { Database } from "@nexnote/db";
import { eq, and } from "drizzle-orm";
import { workspaceMembers } from "@nexnote/db";
import type { WorkspaceRole } from "@nexnote/shared";
import { WORKSPACE_ROLES } from "@nexnote/shared";
import { z } from "zod";
import { uuidSchema } from "@nexnote/shared";

export const ADMIN_PLUS_ROLES: readonly WorkspaceRole[] = WORKSPACE_ROLES.filter(
  (r) => r === "owner" || r === "admin",
);

export const EDITOR_PLUS_ROLES: readonly WorkspaceRole[] = WORKSPACE_ROLES.filter(
  (r) => r !== "viewer",
);

export const workspaceParamsSchema = z.object({
  workspaceId: uuidSchema,
});

export async function getMemberRole(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);

  return (row?.role as WorkspaceRole) ?? null;
}

export function forbidden(reply: FastifyReply) {
  return reply.code(403).send({
    error: "Forbidden",
    code: "FORBIDDEN",
    details: "You are not a member of this workspace",
  });
}

export function insufficientRole(reply: FastifyReply) {
  return reply.code(403).send({
    error: "Forbidden",
    code: "INSUFFICIENT_ROLE",
    details: "Your role does not permit this action",
  });
}
