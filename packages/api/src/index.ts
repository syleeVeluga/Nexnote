import { buildApp } from "./app.js";

const API_PORT = Number(process.env.API_PORT ?? 3001);
const API_HOST = process.env.API_HOST ?? "0.0.0.0";

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: API_PORT, host: API_HOST });
    app.log.info(`NexNote API listening on ${API_HOST}:${API_PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
