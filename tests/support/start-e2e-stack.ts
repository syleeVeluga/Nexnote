import "./load-test-env.ts";

import type { ChildProcess } from "node:child_process";
import { startE2EStack, stopE2EStack } from "./stack-processes.ts";

let children: ChildProcess[] = [];
let shuttingDown = false;

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  await stopE2EStack(children);
  process.exit(exitCode);
}

process.on("SIGINT", () => {
  void shutdown(0);
});
process.on("SIGTERM", () => {
  void shutdown(0);
});

children = await startE2EStack();

await new Promise(() => undefined);
