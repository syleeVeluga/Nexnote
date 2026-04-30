import { test, expect } from "@playwright/test";
import { registerUser } from "../support/e2e-helpers.ts";

test(
  "registers suggested content and approves it from new knowledge",
  { tag: "@smoke" },
  async ({ page }) => {
    await registerUser(page, "review");

    await page.goto("/import");
    await page.getByRole("tab", { name: "Direct input" }).click();
    await page.getByLabel("Title hint (optional)").fill("Suggested Smoke");
    await page
      .getByLabel("Markdown or plain text")
      .fill(
        "# [E2E_SUGGEST]\n\n[E2E_SUGGEST] requires human approval before publish.",
      );
    await page.getByRole("button", { name: "Register knowledge" }).click();

    const reviewLink = page.getByRole("button", { name: "Open review queue" });
    await expect(reviewLink).toBeVisible();
    await reviewLink.click();

    const suggestedItem = page.getByRole("button", {
      name: /New page: E2E Suggested Page/,
    });
    await expect(suggestedItem).toBeVisible({ timeout: 15_000 });
    await suggestedItem.click();

    await page.getByRole("button", { name: "Approve" }).click();
    await expect(
      page.locator(".review-detail").getByText("approved", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    await page.goto("/wiki");
    await expect(
      page
        .getByRole("table")
        .getByRole("link", { name: "E2E Suggested Page", exact: true }),
    ).toBeVisible({ timeout: 15_000 });
  },
);
