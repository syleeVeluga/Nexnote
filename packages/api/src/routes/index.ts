import type { FastifyPluginAsync } from "fastify";
import healthRoutes from "./health.js";
import authRoutes from "./v1/auth.js";
import workspaceRoutes from "./v1/workspaces.js";
import folderRoutes from "./v1/folders.js";
import pageRoutes from "./v1/pages.js";
import entityRoutes from "./v1/entities.js";
import ingestionRoutes from "./v1/ingestions.js";
import decisionRoutes from "./v1/decisions.js";
import docRoutes from "./v1/docs.js";
import auditLogRoutes from "./v1/audit-logs.js";
import modelRunRoutes from "./v1/model-runs.js";
import adminQueueRoutes from "./v1/admin-queues.js";
import activityRoutes from "./v1/activity.js";
import slackWebhookRoutes from "./v1/webhooks/slack-events.js";

export const routes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(healthRoutes);

  await fastify.register(
    async (scoped) => {
      await scoped.register(authRoutes);
      await scoped.register(slackWebhookRoutes, { prefix: "/webhooks/slack" });
      await scoped.register(workspaceRoutes, { prefix: "/workspaces" });
      await scoped.register(folderRoutes, {
        prefix: "/workspaces/:workspaceId/folders",
      });
      await scoped.register(pageRoutes, {
        prefix: "/workspaces/:workspaceId/pages",
      });
      await scoped.register(entityRoutes, {
        prefix: "/workspaces/:workspaceId/entities",
      });
      await scoped.register(ingestionRoutes, {
        prefix: "/workspaces/:workspaceId/ingestions",
      });
      await scoped.register(decisionRoutes, {
        prefix: "/workspaces/:workspaceId/decisions",
      });
      await scoped.register(auditLogRoutes, {
        prefix: "/workspaces/:workspaceId/audit-logs",
      });
      await scoped.register(modelRunRoutes, {
        prefix: "/workspaces/:workspaceId/model-runs",
      });
      await scoped.register(adminQueueRoutes, {
        prefix: "/workspaces/:workspaceId/admin/queues",
      });
      await scoped.register(activityRoutes, {
        prefix: "/workspaces/:workspaceId/activity",
      });
      // Public docs — no auth required (handled inside the plugin)
      await scoped.register(docRoutes, { prefix: "/docs" });
    },
    { prefix: "/api/v1" },
  );
};
