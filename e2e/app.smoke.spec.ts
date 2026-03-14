import { expect, test, type Page } from "@playwright/test";
import { PDFDocument, degrees } from "pdf-lib";

declare global {
  interface Window {
    __PDF_APP_E2E__?: {
      openPdfFromUrl: (url: string, title?: string) => Promise<boolean>;
      openPdfFromBytes: (bytes: number[], title?: string) => Promise<boolean>;
      exportSelectedPdfBytes: () => Promise<number[]>;
    };
  }
}

async function openFixture(page: Page, url: string, title: string) {
  await page.waitForFunction(() => typeof window.__PDF_APP_E2E__?.openPdfFromUrl === "function");
  await page.evaluate(async ({ fixtureUrl, fixtureTitle }) => {
    await window.__PDF_APP_E2E__?.openPdfFromUrl(fixtureUrl, fixtureTitle);
  }, { fixtureUrl: url, fixtureTitle: title });
}

async function openPdfFromBytes(page: Page, bytes: Uint8Array | number[], title: string) {
  await page.waitForFunction(() => typeof window.__PDF_APP_E2E__?.openPdfFromBytes === "function");
  await page.evaluate(async ({ data, fixtureTitle }) => {
    await window.__PDF_APP_E2E__?.openPdfFromBytes(data, fixtureTitle);
  }, { data: Array.from(bytes), fixtureTitle: title });
  await expect(page.getByTestId("page-input")).toHaveValue("1");
}

async function exportSelectedPdfBytes(page: Page) {
  await expect(page.getByTestId("page-input")).toHaveValue(/^\d+$/);
  return page.evaluate(() => window.__PDF_APP_E2E__!.exportSelectedPdfBytes());
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

    await page.evaluate(() => Promise.all([
      window.__PDF_APP_E2E__!.openPdfFromUrl("/e2e/secondary.pdf", "secondary.pdf"),
      window.__PDF_APP_E2E__!.openPdfFromUrl("/e2e/secondary.pdf", "secondary.pdf"),
    ]));
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

  test("deletes the clicked thumbnail page and keeps surviving page rotation", async ({ page }) => {
    await page.goto("/?e2e=1");
    await openFixture(page, "/e2e/linked.pdf", "linked.pdf");

    await page.locator(".preview-link-overlay.internal").first().click();
    await expect(page.getByTestId("page-input")).toHaveValue("2");

    await page.getByRole("button", { name: /오른쪽 회전|Rotate Right/ }).click();
    await expect(page.locator(".thumb-card.active img")).toHaveCSS("transform", /matrix/);

    await page.locator(".thumb-card").first().locator(".thumb-trash-btn").click();

    await expect(page.locator(".thumb-card")).toHaveCount(1);
    await expect(page.getByTestId("page-input")).toHaveValue("1");
    await expect(activeThumbnailCard(page)).toContainText("1p");
    await expect(page.locator(".thumb-card.active img")).toHaveCSS("transform", /matrix/);
  });

  test("exports rotated pages as a real rotated PDF and restores that rotation when reopened", async ({ page }) => {
    await page.goto("/?e2e=1");
    await openFixture(page, "/e2e/linked.pdf", "linked.pdf");

    await page.getByRole("button", { name: /오른쪽 회전|Rotate Right/ }).click();
    await expect(page.locator(".thumb-card.active img")).toHaveCSS("transform", /matrix/);

    const exportedBytes = await exportSelectedPdfBytes(page);
    const exportedPdf = await PDFDocument.load(Uint8Array.from(exportedBytes), { updateMetadata: false });
    expect(exportedPdf.getPage(0).getRotation().angle).toBe(90);

    await openPdfFromBytes(page, exportedBytes, "rotated-export.pdf");
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(page.getByRole("tab", { name: /rotated-export/i })).toHaveAttribute("aria-selected", "true");
  });

  test("exports left-rotated pages as a real rotated PDF", async ({ page }) => {
    await page.goto("/?e2e=1");
    await openFixture(page, "/e2e/linked.pdf", "linked.pdf");

    await page.getByRole("button", { name: /왼쪽 회전|Rotate Left/ }).click();
    await expect(page.locator(".thumb-card.active img")).toHaveCSS("transform", /matrix/);

    const exportedBytes = await exportSelectedPdfBytes(page);
    const exportedPdf = await PDFDocument.load(Uint8Array.from(exportedBytes), { updateMetadata: false });
    expect(exportedPdf.getPage(0).getRotation().angle).toBe(270);
  });

  test("exports 180-degree rotated pages as a real rotated PDF", async ({ page }) => {
    await page.goto("/?e2e=1");
    await openFixture(page, "/e2e/linked.pdf", "linked.pdf");

    await page.getByRole("button", { name: /오른쪽 회전|Rotate Right/ }).click();
    await page.getByRole("button", { name: /오른쪽 회전|Rotate Right/ }).click();
    await expect(page.locator(".thumb-card.active img")).toHaveCSS("transform", /matrix/);

    const exportedBytes = await exportSelectedPdfBytes(page);
    const exportedPdf = await PDFDocument.load(Uint8Array.from(exportedBytes), { updateMetadata: false });
    expect(exportedPdf.getPage(0).getRotation().angle).toBe(180);
  });

  test("reopening a pdf with intrinsic rotation keeps its original rotation", async ({ page }) => {
    await page.goto("/?e2e=1");

    const sourcePdf = await PDFDocument.create();
    const rotatedPage = sourcePdf.addPage([200, 300]);
    rotatedPage.drawText("Intrinsic rotation", { x: 24, y: 260 });
    rotatedPage.setRotation(degrees(90));
    const sourceBytes = await sourcePdf.save();

    await openPdfFromBytes(page, sourceBytes, "intrinsic-rotation.pdf");
    const exportedBytes = await exportSelectedPdfBytes(page);
    const exportedPdf = await PDFDocument.load(Uint8Array.from(exportedBytes), { updateMetadata: false });
    expect(exportedPdf.getPage(0).getRotation().angle).toBe(90);
  });
});
