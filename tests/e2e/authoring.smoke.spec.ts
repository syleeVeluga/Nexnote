import { test, expect } from "@playwright/test";
import { registerUser, uniqueValue } from "../support/e2e-helpers.ts";

test("registers, authors, publishes, and reads a page", { tag: "@smoke" }, async ({ page }) => {
  await registerUser(page, "authoring");

  await page.getByRole("button", { name: "New document" }).click();
  await page.getByLabel("Title").fill("Playwright Publish Page");
  await page.getByLabel("Slug").fill(uniqueValue("playwright-publish"));
  await page.getByRole("button", { name: "Create page" }).click();

  await page.getByRole("button", { name: "Source" }).click();
  await page.locator("textarea.source-editor").fill(
    "# Playwright Publish Page\n\nPublished from the browser smoke test.",
  );
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();

  await page.getByRole("button", { name: "Publish" }).click();
  await page.locator(".publish-banner-confirm").getByRole("button", { name: "Publish" }).click();

  const publishedLink = page.locator("a.publish-banner-link");
  await expect(publishedLink).toBeVisible();
  const href = await publishedLink.getAttribute("href");
  await page.goto(href!);

  await expect(page.locator(".doc-title")).toHaveText("Playwright Publish Page");
  await expect(page.getByText("Published from the browser smoke test.")).toBeVisible();
});
