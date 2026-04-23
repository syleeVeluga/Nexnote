import "./load-test-env.ts";

import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

export function uniqueValue(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export async function setEnglishLocale(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem("wekiflow_lang", "en");
  });
}

export async function registerUser(page: Page, prefix: string): Promise<{
  email: string;
  password: string;
}> {
  const email = `${uniqueValue(prefix)}@example.com`;
  const password = "password123";

  await setEnglishLocale(page);
  await page.goto("/register");
  await page.getByLabel("Name").fill("E2E Tester");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Pages", level: 1 })).toBeVisible();

  return { email, password };
}
