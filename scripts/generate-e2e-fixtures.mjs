import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
  rgb,
} from "pdf-lib";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const fixtureDir = join(root, "public", "e2e");

function createLinkAnnotation(doc, rect, extras) {
  return doc.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: rect.map((value) => PDFNumber.of(value)),
    Border: [0, 0, 0],
    ...extras,
  });
}

async function buildLinkedPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page1 = doc.addPage([595, 842]);
  const page2 = doc.addPage([595, 842]);

  page1.drawText("E2E linked PDF", { x: 50, y: 780, size: 24, font, color: rgb(0.1, 0.1, 0.1) });
  page1.drawText("Go to page 2", { x: 50, y: 720, size: 18, font, color: rgb(0.1, 0.2, 0.8) });
  page1.drawText("Open external link", { x: 50, y: 680, size: 18, font, color: rgb(0.0, 0.5, 0.2) });
  page2.drawText("Page 2", { x: 50, y: 780, size: 24, font, color: rgb(0.1, 0.1, 0.1) });

  const page1Annots = doc.context.obj([]);
  const internalLink = createLinkAnnotation(doc, [48, 716, 176, 738], {
    Dest: PDFArray.withContext(doc.context),
  });
  internalLink.set(PDFName.of("Dest"), PDFArray.withContext(doc.context));
  internalLink.lookup(PDFName.of("Dest"), PDFArray).push(page2.ref);
  internalLink.lookup(PDFName.of("Dest"), PDFArray).push(PDFName.of("Fit"));

  const externalLink = createLinkAnnotation(doc, [48, 676, 214, 698], {
    A: doc.context.obj({
      Type: "Action",
      S: "URI",
      URI: PDFString.of("https://example.com/e2e"),
    }),
  });

  page1Annots.push(internalLink);
  page1Annots.push(externalLink);
  page1.node.set(PDFName.of("Annots"), page1Annots);

  return doc.save();
}

async function buildSimplePdf(title) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText(title, { x: 50, y: 780, size: 24, font, color: rgb(0.1, 0.1, 0.1) });
  page.drawText("Fixture PDF for Playwright smoke tests.", { x: 50, y: 730, size: 16, font, color: rgb(0.2, 0.2, 0.2) });
  return doc.save();
}

async function main() {
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(join(fixtureDir, "linked.pdf"), await buildLinkedPdf());
  await writeFile(join(fixtureDir, "secondary.pdf"), await buildSimplePdf("Secondary fixture"));
  console.log(`Generated E2E fixtures in ${fixtureDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
