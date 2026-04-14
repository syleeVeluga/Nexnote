import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { getDb, closeConnection, type Database } from "@nexnote/db/client";

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
  }
}

async function dbPluginImpl(fastify: FastifyInstance) {
  fastify.decorate("db", getDb());

  fastify.addHook("onClose", async () => {
    await closeConnection();
  });
}

export const dbPlugin = fp(dbPluginImpl, {
  name: "nexnote-db",
});
