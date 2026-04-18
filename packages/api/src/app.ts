import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import sensible from "@fastify/sensible";
import { routes } from "./routes/index.js";
import { dbPlugin } from "./plugins/db.js";
import { authPlugin } from "./plugins/auth.js";
import { queuePlugin } from "./plugins/queue.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { requestLoggingPlugin } from "./plugins/request-logging.js";

const MAX_UPLOAD_BYTES = (() => {
  const raw = process.env["INGESTION_MAX_UPLOAD_BYTES"];
  if (!raw) return 20 * 1024 * 1024;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 20 * 1024 * 1024;
})();

export async function buildApp() {
  const app = Fastify({
    logger: true,
    disableRequestLogging: true,
    genReqId: () => crypto.randomUUID(),
    // Default (1 MiB) applies globally. The /ingestions/upload route opts in
    // to MAX_UPLOAD_BYTES via its own route-level bodyLimit; multipart fileSize
    // below bounds the file part independently.
  });

  await app.register(cors, { origin: true });
  await app.register(sensible);
  await app.register(multipart, {
    limits: {
      fileSize: MAX_UPLOAD_BYTES,
      files: 1,
      fields: 10,
    },
  });
  await app.register(errorHandlerPlugin);
  await app.register(requestLoggingPlugin);
  await app.register(dbPlugin);
  await app.register(authPlugin);
  await app.register(queuePlugin);
  await app.register(routes);

  return app;
}
