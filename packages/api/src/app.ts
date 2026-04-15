import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { routes } from "./routes/index.js";
import { dbPlugin } from "./plugins/db.js";
import { authPlugin } from "./plugins/auth.js";
import { queuePlugin } from "./plugins/queue.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { requestLoggingPlugin } from "./plugins/request-logging.js";

export async function buildApp() {
  const app = Fastify({
    logger: true,
    disableRequestLogging: true,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(cors, { origin: true });
  await app.register(sensible);
  await app.register(errorHandlerPlugin);
  await app.register(requestLoggingPlugin);
  await app.register(dbPlugin);
  await app.register(authPlugin);
  await app.register(queuePlugin);
  await app.register(routes);

  return app;
}
