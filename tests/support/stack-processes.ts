import "./load-test-env.ts";

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { waitFor } from "./wait.ts";
import { prepareTestDatabase } from "./services.ts";
import { repoRoot } from "./paths.ts";

const apiHost = process.env.API_HOST ?? "127.0.0.1";
const apiPort = Number(process.env.API_PORT ?? 3001);
const webPort = Number(process.env.WEB_PORT ?? 5173);

function spawnChild(
  label: string,
  command: string,
  args: string[],
): ChildProcess {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });

  child.once("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    console.error(
      `[e2e-stack] ${label} exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
    );
  });

  return child;
}

function spawnPnpmChild(label: string, args: string[]): ChildProcess {
  if (process.platform === "win32") {
    return spawnChild(label, "cmd.exe", [
      "/d",
      "/s",
      "/c",
      `corepack pnpm ${args.join(" ")}`,
    ]);
  }

  return spawnChild(label, "corepack", ["pnpm", ...args]);
}

async function waitForHttp(url: string, description: string): Promise<void> {
  await waitFor(
    async () => {
      try {
        const response = await fetch(url);
        return response.ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: 60_000, description },
  );
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolveDone) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
      });
      killer.once("exit", () => resolveDone());
      killer.once("error", () => resolveDone());
    });
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

let shuttingDown = false;

export async function startE2EStack(): Promise<ChildProcess[]> {
  await prepareTestDatabase();

  const children = [
    spawnChild("api", process.execPath, [
      "--import",
      "tsx",
      resolve(repoRoot, "packages/api/src/index.ts"),
    ]),
    spawnChild("worker", process.execPath, [
      "--import",
      "tsx",
      resolve(repoRoot, "packages/worker/src/index.ts"),
    ]),
    spawnPnpmChild("web", [
      "--filter",
      "@nexnote/web",
      "exec",
      "vite",
      "--host",
      apiHost,
      "--port",
      String(webPort),
      "--strictPort",
    ]),
  ];

  await waitForHttp(
    `http://${apiHost}:${apiPort}/health/ready`,
    "API readiness",
  );
  await waitForHttp(
    `http://${apiHost}:${webPort}/login`,
    "web readiness",
  );

  return children;
}

export async function stopE2EStack(children: ChildProcess[]): Promise<void> {
  shuttingDown = true;
  await Promise.allSettled(children.map((child) => killProcessTree(child)));
}
