# PDF Split and Reorder Tool

Desktop app built with Tauri + React for fast local PDF page extraction and reordering.

<img  alt="image" src="https://github.com/user-attachments/assets/214043cd-2b4a-4394-b6ef-111a3515e244" />

## Features

- Open a PDF and preview pages with virtualized thumbnails.
- Select pages by:
  - Checkbox
  - Quick range input (`1,3,5-9`)
  - Range add/remove controls
- Reorder pages by drag and drop in the thumbnail list.
- Remove a page from selection using the trash action beside each thumbnail checkbox.
- Rotate pages (left/right) before export.
- Zoom preview (`-`, `+`, fit).
- Add another PDF into the current document:
  - Insert to front or back
  - Choose source pages by range input (`1-3, 5, 9`)
- Export selected pages as:
  - PDF (`<source>_<UUID>_selected.pdf`)
  - PNG/JPG (one file per selected page)
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

## Project Structure

- `src/App.tsx`: main UI and PDF workflow logic
- `src/App.css`: app styling
- `src-tauri/`: Tauri (Rust) desktop wrapper

## Notes

- All PDF processing is local on your machine.
- Very large PDFs are handled with thumbnail virtualization and queue-based rendering.
- Reordered thumbnail order is used when exporting selected pages.

## Korean README

- See [README.ko.md](./README.ko.md)
