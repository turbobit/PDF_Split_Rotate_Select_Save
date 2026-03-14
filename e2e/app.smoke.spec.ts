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

function sidebarTabButton(page: Page, mode: "thumbnails" | "outline") {
  const name = mode === "thumbnails" ? /썸네일|Thumbnails/ : /목차|Outline/;
  return page.locator(".sidebar-tab-row").getByRole("button", { name });
}

function activeThumbnailCard(page: Page) {
  return page.locator(".thumb-card.active").first();
}

test.describe("PDF workspace smoke", () => {
  test("keeps empty-state sidebar tab selection without bouncing back", async ({ page }) => {
    await page.goto("/?e2e=1");

    const outlineButton = sidebarTabButton(page, "outline");
    const thumbnailsButton = sidebarTabButton(page, "thumbnails");

    await outlineButton.click();
    await expect(outlineButton).toHaveClass(/tab-active/);
    await expect(thumbnailsButton).not.toHaveClass(/tab-active/);
    await expect(page.locator(".outline-viewport .empty-panel")).toBeVisible();
    await page.waitForTimeout(300);
    await expect(outlineButton).toHaveClass(/tab-active/);
    await expect(page.locator(".outline-viewport .empty-panel")).toBeVisible();

    await thumbnailsButton.click();
    await expect(thumbnailsButton).toHaveClass(/tab-active/);
    await expect(page.locator(".thumbnail-viewport .empty-panel")).toBeVisible();
  });

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

  test("keeps sidebar current-page indication after normal and fullscreen navigation", async ({ page }) => {
    await page.goto("/?e2e=1");
    await openFixture(page, "/e2e/linked.pdf", "linked.pdf");

    await expect(activeThumbnailCard(page)).toContainText("1p");

    await page.locator(".preview-link-overlay.internal").first().click();
    await expect(page.getByTestId("page-input")).toHaveValue("2");
    await expect(activeThumbnailCard(page)).toContainText("2p");

    await page.keyboard.press("Control+L");
    await page.waitForFunction(() => Boolean(document.fullscreenElement));

    await page.keyboard.press("PageUp");
    await expect(page.getByTestId("page-input")).toHaveValue("1");

    await page.keyboard.press("Control+L");
    await page.waitForFunction(() => !document.fullscreenElement);
    await expect(activeThumbnailCard(page)).toContainText("1p");
  });
});
