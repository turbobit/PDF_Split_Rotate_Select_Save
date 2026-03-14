import { memo, type DragEvent as ReactDragEvent } from "react";
import { getWorkspaceTabShortcutLabel, type WorkspaceTab } from "../app/workspace-tabs";

type TranslateFn = (ko: string, en: string) => string;

type WorkspaceTabStripProps = {
  tr: TranslateFn;
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  draggingTabId: string | null;
  dropTargetTabId: string | null;
  isBusy: boolean;
  onSwitchTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onDragStartTab: (tabId: string, event: ReactDragEvent<HTMLDivElement>) => void;
  onDragOverTab: (tabId: string, event: ReactDragEvent<HTMLDivElement>) => void;
  onDropTab: (tabId: string, event: ReactDragEvent<HTMLDivElement>) => void;
  onDragEndTab: () => void;
};

function WorkspaceTabStrip({
  tr,
  tabs,
  activeTabId,
  draggingTabId,
  dropTargetTabId,
  isBusy,
  onSwitchTab,
  onCloseTab,
  onDragStartTab,
  onDragOverTab,
  onDropTab,
  onDragEndTab,
}: WorkspaceTabStripProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="panel workspace-tab-strip" role="tablist" aria-label={tr("열린 PDF 탭", "Open PDF tabs")} data-testid="workspace-tab-strip">
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTabId;
        const shortcutLabel = getWorkspaceTabShortcutLabel(index);
        return (
          <div
            key={tab.id}
            className={`workspace-tab ${isActive ? "active" : ""} ${draggingTabId === tab.id ? "dragging" : ""} ${dropTargetTabId === tab.id ? "drop-target" : ""}`}
            draggable={!isBusy}
            onDragStart={(event) => onDragStartTab(tab.id, event)}
            onDragOver={(event) => onDragOverTab(tab.id, event)}
            onDrop={(event) => onDropTab(tab.id, event)}
            onDragEnd={onDragEndTab}
          >
            <button
              className="workspace-tab-button"
              type="button"
              role="tab"
              data-testid={`workspace-tab-${index + 1}`}
              aria-selected={isActive}
              title={tab.snapshot.pdfPath ?? tab.title}
              onClick={() => onSwitchTab(tab.id)}
              disabled={isBusy && !isActive}
            >
              {shortcutLabel ? <span className="workspace-tab-index">{shortcutLabel}</span> : null}
              <span className="workspace-tab-title" title={tab.title}>{tab.title}</span>
              <span className="workspace-tab-meta">{tab.snapshot.pageCount}p</span>
            </button>
            <button
              className="workspace-tab-close"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
              disabled={isBusy}
              title={tr("탭 닫기", "Close tab")}
              aria-label={tr("탭 닫기", "Close tab")}
            >
              x
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default memo(WorkspaceTabStrip);
