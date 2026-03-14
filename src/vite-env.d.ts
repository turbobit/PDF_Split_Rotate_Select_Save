/// <reference types="vite/client" />

interface Window {
  __TAURI__?: any;
  __TAURI_INTERNALS__?: any;
  __PDF_APP_E2E__?: {
    openPdfFromUrl: (url: string, title?: string) => Promise<boolean>;
    openPdfFromBytes: (bytes: number[], title?: string) => Promise<boolean>;
    exportSelectedPdfBytes: () => Promise<number[]>;
  };
}
