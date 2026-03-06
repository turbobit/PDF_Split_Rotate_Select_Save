# PDF Split Rotate Select Save

Desktop app built with Tauri + React for fast local PDF split, reorder, rotate, merge, and export workflows.

<img  alt="image" src="https://github.com/user-attachments/assets/214043cd-2b4a-4394-b6ef-111a3515e244" />

## Latest Update (v0.1.3)

- Improved toolbar UX: collapsible toolbar with localStorage persistence and refined control ordering/alignment.
- Added PDF file-association flow support: opening a PDF from Explorer/Finder now loads directly in a new app window flow.
- Updated Tauri runtime behavior to better support multi-window usage from external file-open entry paths.

## Features

- Open a PDF and preview pages with virtualized thumbnails.
- Select pages by checkbox, quick input (`1,3,5-9`), and range add/remove controls.
- Reorder pages by drag and drop in the thumbnail list.
- Remove a page from selection using the trash action beside each thumbnail checkbox.
- Rotate pages (left/right) before export.
- Zoom preview (`-`, `+`, fit).
- Add another PDF into the current document (front/back) with optional page range input (`1-3, 5, 9`).
- Merge multiple PDFs with drag-and-drop merge order and insert position options (front/back/before current/after current).
- Export selected pages as PDF (`<source>_<UUID>_selected.pdf`) or PNG/JPG (one file per selected page).
- Optional "open explorer after save" behavior.
- Korean/English UI language toggle.

## Tech Stack

- Tauri 2
- React 19 + TypeScript
- Vite
- `pdf-lib` for PDF merge/copy/export
- `pdfjs-dist` for rendering preview/thumbnails

## Prerequisites

- Node.js 18+ (or newer LTS)
- Rust toolchain (for Tauri desktop build)
- GitHub CLI (`gh`) installed and authenticated (`gh auth login`)

## Development

Install dependencies:

```bash
npm install
```

Run web dev server:

```bash
npm run dev
```

Run Tauri desktop app in dev mode:

```bash
npm run tauri dev
```

Build frontend bundle:

```bash
npm run build
```

Build desktop app:

```bash
npm run tauri build
```

Build and publish GitHub Release (create/update by `package.json` version tag):

```bash
npm run release
```

Release script behavior:
- fetches and syncs tags automatically (`git fetch --tags --force`)
- creates local tag `v<version>` on `HEAD` if missing
- pushes tag to `origin` if missing remotely
- stops with an error if local/remote tag points to a different commit than `HEAD`

## Project Structure

- `src/App.tsx`: main UI and PDF workflow logic
- `src/App.css`: app styling
- `src-tauri/`: Tauri (Rust) desktop wrapper

## Notes

- All PDF processing is local on your machine.
- Very large PDFs are handled with thumbnail virtualization and queue-based rendering.
- Reordered thumbnail order is used when exporting selected pages.
- Per-page rotation is applied to PDF and image export output.

## Korean README

- See [README.ko.md](./README.ko.md)
