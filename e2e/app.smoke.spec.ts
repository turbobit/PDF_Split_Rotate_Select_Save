import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    __PDF_APP_E2E__?: {
      openPdfFromUrl: (url: string, title?: string) => Promise<boolean>;
    };
  }
}

async function openFixture(page: Page, url: string, title: string) {
  await page.waitForFunction(() => typeof window.__PDF_APP_E2E__?.openPdfFromUrl === "function");
  await page.evaluate(async ({ fixtureUrl, fixtureTitle }) => {
    await window.__PDF_APP_E2E__?.openPdfFromUrl(fixtureUrl, fixtureTitle);
  }, { fixtureUrl: url, fixtureTitle: title });
}

test.describe("PDF workspace smoke", () => {
  test("opens PDFs into tabs and switches with keyboard", async ({ page }) => {
    await page.goto("/?e2e=1");

    await openFixture(page, "/e2e/linked.pdf", "linked.pdf");
    await expect(page.getByTestId("page-input")).toHaveValue("1");
    await expect(page.getByRole("tab", { name: /linked/i })).toBeVisible();

    await openFixture(page, "/e2e/linked.pdf", "linked.pdf");
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(page.getByRole("tab", { name: /linked/i })).toHaveAttribute("aria-selected", "true");

    await openFixture(page, "/e2e/secondary.pdf", "secondary.pdf");
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(page.getByRole("tab", { name: /secondary/i })).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Control+1");
    await expect(page.getByRole("tab", { name: /linked/i })).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Control+2");
    await expect(page.getByRole("tab", { name: /secondary/i })).toHaveAttribute("aria-selected", "true");
  });

  test("follows internal and external links from the preview body", async ({ page, context }) => {
    await page.goto("/?e2e=1");
    await openFixture(page, "/e2e/linked.pdf", "linked.pdf");

    const internalLink = page.locator(".preview-link-overlay.internal").first();
    await expect(internalLink).toBeVisible();
    await internalLink.click();
    await expect(page.getByTestId("page-input")).toHaveValue("2");

    await page.keyboard.press("PageUp");
    await expect(page.getByTestId("page-input")).toHaveValue("1");

    const popupPromise = context.waitForEvent("page");
    await page.locator(".preview-link-overlay.external").first().click();
    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");
    await expect(popup).toHaveURL(/example\.com\/e2e/);
    await popup.close();
  });
});
