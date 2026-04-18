import type { FullConfig } from "@playwright/test";
import { startE2EStack, stopE2EStack } from "./stack-processes.ts";

export default async function globalSetup(_config: FullConfig) {
  const children = await startE2EStack();

  return async () => {
    await stopE2EStack(children);
  };
}
