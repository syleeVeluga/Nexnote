import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { routes } from "./routes/index.js";
import { dbPlugin } from "./plugins/db.js";

export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  await app.register(cors, { origin: true });
  await app.register(sensible);
  await app.register(dbPlugin);
  await app.register(routes);

  return app;
}
