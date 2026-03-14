import { normalizeFileStem } from "./app-helpers";
import type { OutlineEntry, OutlinePanelMode, SidebarTab } from "./app-helpers";

export type SearchResultItem = {
  pageNumber: number;
  spanIndex: number;
};

export type WorkspaceTabSnapshot = {
  pdfPath: string | null;
  pageCount: number;
  activePage: number;
  pageInput: string;
  pageOrder: number[];
  selectedPages: number[];
  sidebarTab: SidebarTab;
  outlinePanelMode: OutlinePanelMode;
  outlineEntries: OutlineEntry[];
  hasLoadedOutlineOnce: boolean;
  quickSelectInput: string;
  rangeFromInput: string;
  rangeToInput: string;
  isAreaSelectMode: boolean;
  showSearchBar: boolean;
  searchQuery: string;
  debouncedSearchQuery: string;
  pageRotations: Record<number, number>;
  isCurrentPdfEncrypted: boolean;
};

export type WorkspaceTab = {
  id: string;
  title: string;
  snapshot: WorkspaceTabSnapshot;
};

export function buildWorkspaceTab(tabId: string, snapshot: WorkspaceTabSnapshot, title?: string | null): WorkspaceTab {
  return {
    id: tabId,
    title: normalizeFileStem(title ?? snapshot.pdfPath ?? "document.pdf"),
    snapshot,
  };
}

export function updateWorkspaceTabSnapshot(
  tabs: WorkspaceTab[],
  tabId: string,
  snapshot: WorkspaceTabSnapshot,
): WorkspaceTab[] {
  return tabs.map((tab) => (
    tab.id === tabId
      ? {
        ...tab,
        title: normalizeFileStem(snapshot.pdfPath ?? tab.title),
        snapshot,
      }
      : tab
  ));
}

export function reorderWorkspaceTabs(
  tabs: WorkspaceTab[],
  sourceTabId: string,
  targetTabId: string,
): WorkspaceTab[] {
  if (sourceTabId === targetTabId) return tabs;
  const sourceIndex = tabs.findIndex((tab) => tab.id === sourceTabId);
  const targetIndex = tabs.findIndex((tab) => tab.id === targetTabId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return tabs;
  const next = [...tabs];
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, moved);
  return next;
}

export function getWorkspaceTabShortcutLabel(index: number): string | null {
  if (index < 0 || index > 8) return null;
  return String(index + 1);
}
