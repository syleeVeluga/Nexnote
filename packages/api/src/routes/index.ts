import type { FastifyPluginAsync } from "fastify";
import healthRoutes from "./health.js";

export const routes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(healthRoutes);

  await fastify.register(
    async () => {
      // Domain route modules will be registered here
    },
    { prefix: "/api/v1" },
  );
};
