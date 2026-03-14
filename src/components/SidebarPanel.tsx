import { memo, type KeyboardEventHandler, type MouseEvent, type UIEventHandler } from "react";
import { OUTLINE_MAX_DEPTH, THUMB_ITEM_HEIGHT } from "../app/app-helpers";
import { normalizeOutlineDepth, normalizeFileStem, type OutlineEntry, type OutlinePanelMode, type SidebarTab } from "../app/app-helpers";

type TranslateFn = (ko: string, en: string) => string;

type SidebarPanelProps = {
  tr: TranslateFn;
  pdfPath: string | null;
  sidebarTab: SidebarTab;
  outlinePanelMode: OutlinePanelMode;
  loadedThumbCount: number;
  pageCount: number;
  thumbQueueCount: number;
  selectedPageNumbers: number[];
  outlineEntries: OutlineEntry[];
  pdfLoaded: boolean;
  isBusy: boolean;
  isLoadingOutline: boolean;
  isGeneratingOutline: boolean;
  thumbViewportRef: React.RefObject<HTMLDivElement | null>;
  outlineListRef: React.RefObject<HTMLDivElement | null>;
  handleArrowPageNavigation: KeyboardEventHandler<HTMLDivElement>;
  onThumbScroll: UIEventHandler<HTMLDivElement>;
  totalThumbHeight: number;
  visiblePageNumbers: number[];
  activePage: number;
  draggingPage: number | null;
  dropTargetPage: number | null;
  pageOrderIndexMap: Record<number, number>;
  selectedPages: Set<number>;
  thumbnailUrls: Record<number, string>;
  pageRotations: Record<number, number>;
  draggingOutlineId: string | null;
  outlineDropTargetId: string | null;
  onShowThumbnails: () => void;
  onShowOutline: () => void;
  onSelectAllPages: () => void;
  onClearSelectedPages: () => void;
  onToggleOutlinePanelMode: () => void;
  onStartPageReorder: (pageNumber: number, pageIndex: number | null, event: MouseEvent<HTMLSpanElement>) => void;
  onTogglePageSelection: (pageNumber: number) => void;
  onDeletePage: (pageNumber: number) => void;
  onActivatePage: (pageNumber: number) => void;
  onJumpToOutlinePage: (pageNumber: number) => void;
  onReloadOutlineFromPdf: () => void;
  onAppendOutlineFromBodyText: () => void;
  onAddManualOutlineAtActivePage: () => void;
  onClearOutlineEntries: () => void;
  onStartOutlineReorder: (entryId: string, index: number, event: MouseEvent<HTMLSpanElement>) => void;
  onMoveOutlineEntry: (entryId: string, direction: -1 | 1) => void;
  onUpdateOutlineTitle: (entryId: string, value: string) => void;
  onUpdateOutlinePageNumber: (entryId: string, value: string) => void;
  onUpdateOutlineDepth: (entryId: string, depth: number) => void;
  onRemoveOutlineEntry: (entryId: string) => void;
};

function SidebarPanel({
  tr,
  pdfPath,
  sidebarTab,
  outlinePanelMode,
  loadedThumbCount,
  pageCount,
  thumbQueueCount,
  selectedPageNumbers,
  outlineEntries,
  pdfLoaded,
  isBusy,
  isLoadingOutline,
  isGeneratingOutline,
  thumbViewportRef,
  outlineListRef,
  handleArrowPageNavigation,
  onThumbScroll,
  totalThumbHeight,
  visiblePageNumbers,
  activePage,
  draggingPage,
  dropTargetPage,
  pageOrderIndexMap,
  selectedPages,
  thumbnailUrls,
  pageRotations,
  draggingOutlineId,
  outlineDropTargetId,
  onShowThumbnails,
  onShowOutline,
  onSelectAllPages,
  onClearSelectedPages,
  onToggleOutlinePanelMode,
  onStartPageReorder,
  onTogglePageSelection,
  onDeletePage,
  onActivatePage,
  onJumpToOutlinePage,
  onReloadOutlineFromPdf,
  onAppendOutlineFromBodyText,
  onAddManualOutlineAtActivePage,
  onClearOutlineEntries,
  onStartOutlineReorder,
  onMoveOutlineEntry,
  onUpdateOutlineTitle,
  onUpdateOutlinePageNumber,
  onUpdateOutlineDepth,
  onRemoveOutlineEntry,
}: SidebarPanelProps) {
  return (
    <aside className="panel sidebar">
      <div className="sidebar-head">
        <strong
          className="sidebar-title"
          title={pdfPath ? normalizeFileStem(pdfPath) : tr("불러온 PDF 없음", "No PDF loaded")}
        >
          {pdfPath ? normalizeFileStem(pdfPath) : tr("불러온 PDF 없음", "No PDF loaded")}
        </strong>
        <div className="sidebar-tab-row">
          <button
            className={`ghost-btn micro-btn ${sidebarTab === "thumbnails" ? "tab-active" : ""}`}
            onClick={onShowThumbnails}
            type="button"
          >
            {tr("썸네일", "Thumbnails")}
          </button>
          <button
            className={`ghost-btn micro-btn ${sidebarTab === "outline" ? "tab-active" : ""}`}
            onClick={onShowOutline}
            type="button"
          >
            {tr("목차", "Outline")}
          </button>
        </div>
        <div className="sidebar-info-row">
          {sidebarTab === "thumbnails" ? (
            <>
              <span className="sidebar-info-text">
                {tr("썸네일", "Thumbnails")} {loadedThumbCount}/{pageCount} ({tr("대기/처리", "queued/working")} {thumbQueueCount})
              </span>
              <div className="sidebar-buttons">
                <button
                  className="ghost-btn micro-btn"
                  onClick={onSelectAllPages}
                  disabled={!pdfLoaded || isBusy || pageCount === 0}
                  title={tr("전체 선택", "Select all")}
                >
                  {tr("전체", "All")}
                </button>
                <button
                  className="ghost-btn micro-btn"
                  onClick={onClearSelectedPages}
                  disabled={!pdfLoaded || isBusy || selectedPageNumbers.length === 0}
                  title={tr("선택 취소", "Clear selection")}
                >
                  {tr("취소", "Clear")}
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="sidebar-info-text">{tr("목차 항목", "Outline entries")} {outlineEntries.length}</span>
              <div className="sidebar-buttons">
                <button
                  className="ghost-btn micro-btn"
                  onClick={onToggleOutlinePanelMode}
                  disabled={!pdfLoaded || isBusy || isLoadingOutline}
                  type="button"
                  title={outlinePanelMode === "view" ? tr("수정/추가 모드", "Switch to edit/add mode") : tr("기본 보기 모드", "Switch to viewer mode")}
                >
                  {outlinePanelMode === "view" ? tr("수정/추가", "Edit/Add") : tr("기본보기", "Viewer")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {sidebarTab === "thumbnails" ? (
        <div
          className="thumbnail-viewport"
          ref={thumbViewportRef}
          tabIndex={0}
          onMouseDown={(event) => event.currentTarget.focus()}
          onKeyDown={handleArrowPageNavigation}
          onScroll={onThumbScroll}
        >
          {pageCount === 0 ? <div className="empty-panel">{tr("PDF를 열면 페이지가 표시됩니다.", "Pages appear after opening a PDF.")}</div> : (
            <div className="thumbnail-inner" style={{ height: `${totalThumbHeight}px` }}>
              {visiblePageNumbers.map((pageNumber) => (
                <article
                  key={pageNumber}
                  className={`thumb-card ${activePage === pageNumber ? "active" : ""} ${draggingPage === pageNumber ? "dragging" : ""} ${dropTargetPage === pageNumber ? "drop-target" : ""}`}
                  style={{ top: `${(pageOrderIndexMap[pageNumber] ?? 0) * THUMB_ITEM_HEIGHT}px` }}
                >
                  <div className="thumb-head">
                    <span className="thumb-head-left">
                      <span
                        className="thumb-drag-handle"
                        title={tr("여기를 잡고 드래그하면 순서 이동", "Drag here to reorder")}
                        aria-label={tr("드래그 핸들", "Drag handle")}
                        onMouseDown={(event) => {
                          if (isBusy) return;
                          onStartPageReorder(pageNumber, pageOrderIndexMap[pageNumber] ?? null, event);
                        }}
                      >
                        |||
                      </span>
                      <span>{pageNumber}p</span>
                    </span>
                    <div className="thumb-actions" onClick={(event) => event.stopPropagation()}>
                      <label className="thumb-check">
                        <input type="checkbox" checked={selectedPages.has(pageNumber)} onChange={() => onTogglePageSelection(pageNumber)} />
                        {tr("선택", "Pick")}
                      </label>
                      <button
                        type="button"
                        className="thumb-trash-btn"
                        onClick={() => onDeletePage(pageNumber)}
                        disabled={isBusy}
                        title={tr("현재 작업본에서 이 페이지를 삭제합니다.", "Delete this page from the current workspace.")}
                      >
                        {tr("휴지통", "Trash")}
                      </button>
                    </div>
                  </div>
                  <button className="thumb-preview-btn" onClick={() => onActivatePage(pageNumber)} type="button">
                    {thumbnailUrls[pageNumber] ? (
                      <img
                        src={thumbnailUrls[pageNumber]}
                        alt={`${tr("페이지", "Page")} ${pageNumber}`}
                        style={{ transform: `rotate(${pageRotations[pageNumber] ?? 0}deg)` }}
                      />
                    ) : (
                      <div className="thumb-loading">{tr("렌더링 중...", "Rendering...")}</div>
                    )}
                  </button>
                </article>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div
          className="outline-viewport"
          tabIndex={0}
          onMouseDown={(event) => event.currentTarget.focus()}
          onKeyDown={handleArrowPageNavigation}
        >
          {pageCount === 0 ? <div className="empty-panel">{tr("PDF를 열면 목차 편집이 가능합니다.", "Open a PDF to edit outlines.")}</div> : null}
          {pageCount > 0 && isLoadingOutline ? <div className="empty-panel">{tr("목차를 불러오는 중...", "Loading outlines...")}</div> : null}
          {pageCount > 0 && !isLoadingOutline && outlineEntries.length === 0 ? (
            <div className="empty-panel">
              {outlinePanelMode === "edit"
                ? tr("목차가 없습니다. 아래 버튼으로 생성하세요.", "No outlines yet. Use buttons below to generate.")
                : tr("목차가 없습니다. 수정/추가 모드에서 생성할 수 있습니다.", "No outlines. Create them in edit/add mode.")}
            </div>
          ) : null}
          {pageCount > 0 && !isLoadingOutline && outlineEntries.length > 0 && outlinePanelMode === "view" ? (
            <div className="outline-view-list">
              {outlineEntries.map((entry) => (
                <button
                  key={entry.id}
                  className={`outline-view-item ${activePage === entry.pageNumber ? "active" : ""}`}
                  type="button"
                  onClick={() => onJumpToOutlinePage(entry.pageNumber)}
                  style={{ paddingLeft: `${10 + normalizeOutlineDepth(entry.depth) * 16}px` }}
                  title={`${entry.title} (${tr("페이지", "Page")} ${entry.pageNumber})`}
                >
                  <span className="outline-view-title">{entry.title}</span>
                  <span className="outline-view-page">{entry.pageNumber}</span>
                </button>
              ))}
            </div>
          ) : null}
          {pageCount > 0 && !isLoadingOutline && outlinePanelMode === "edit" ? (
            <>
              <div className="outline-toolbar">
                <button
                  className="ghost-btn micro-btn"
                  onClick={onReloadOutlineFromPdf}
                  disabled={!pdfLoaded || isBusy || isLoadingOutline}
                  type="button"
                  title={tr("PDF 원본 목차를 다시 불러옵니다.", "Reload outline items from the PDF file.")}
                >
                  {tr("PDF목차", "Load PDF Outline")}
                </button>
                <button
                  className="ghost-btn micro-btn"
                  onClick={onAppendOutlineFromBodyText}
                  disabled={!pdfLoaded || isBusy || isGeneratingOutline}
                  type="button"
                  title={tr("본문 텍스트를 분석해 목차 후보를 추가합니다.", "Analyze page text and append outline candidates.")}
                >
                  {isGeneratingOutline ? tr("분석중", "Analyzing...") : tr("본문추가", "Add from Text")}
                </button>
                <button
                  className="ghost-btn micro-btn"
                  onClick={onAddManualOutlineAtActivePage}
                  disabled={!pdfLoaded || isBusy}
                  type="button"
                  title={tr("현재 페이지로 새 목차 항목을 추가합니다.", "Add a new outline entry for the current page.")}
                >
                  {tr("현재추가", "Add Current")}
                </button>
                <button
                  className="ghost-btn micro-btn"
                  onClick={onClearOutlineEntries}
                  disabled={!pdfLoaded || isBusy || outlineEntries.length === 0}
                  type="button"
                  title={tr("현재 목차 항목을 모두 삭제합니다.", "Remove all current outline entries.")}
                >
                  {tr("전체비움", "Clear All")}
                </button>
              </div>
              {outlineEntries.length > 0 ? (
                <div className="outline-list" ref={outlineListRef}>
                  {outlineEntries.map((entry, index) => (
                    <article
                      key={entry.id}
                      data-outline-id={entry.id}
                      className={`outline-item ${activePage === entry.pageNumber ? "active" : ""} ${draggingOutlineId === entry.id ? "dragging" : ""} ${outlineDropTargetId === entry.id ? "drop-target" : ""}`}
                    >
                      <div className="outline-item-top">
                        <span
                          className="outline-drag-handle"
                          title={tr("여기를 잡고 드래그하여 목차 순서 이동", "Drag here to reorder outline items")}
                          aria-label={tr("목차 드래그 핸들", "Outline drag handle")}
                          onMouseDown={(event) => {
                            if (isBusy) return;
                            onStartOutlineReorder(entry.id, index, event);
                          }}
                        >
                          |||
                        </span>
                        <button
                          className="ghost-btn micro-btn"
                          type="button"
                          onClick={() => onJumpToOutlinePage(entry.pageNumber)}
                          title={tr(`이 목차 페이지(${entry.pageNumber}p)로 이동`, `Jump to this outline page (${entry.pageNumber}p)`)}
                        >
                          {entry.pageNumber}p
                        </button>
                        <span
                          className={`outline-source ${entry.source}`}
                          title={
                            entry.source === "pdf"
                              ? tr("PDF 원본 목차에서 불러온 항목", "Imported from PDF outline")
                              : entry.source === "text"
                                ? tr("본문 텍스트 기반으로 생성한 항목", "Generated from body text")
                                : tr("수동으로 추가한 항목", "Added manually")
                          }
                        >
                          {entry.source === "pdf" ? "PDF" : entry.source === "text" ? tr("본문", "Text") : tr("수동", "Manual")}
                        </span>
                        <button
                          className="ghost-btn micro-btn"
                          type="button"
                          onClick={() => onMoveOutlineEntry(entry.id, -1)}
                          disabled={index === 0}
                          title={tr("목차 순서를 한 칸 위로 이동", "Move this outline item one step up")}
                        >
                          ↑
                        </button>
                        <button
                          className="ghost-btn micro-btn"
                          type="button"
                          onClick={() => onMoveOutlineEntry(entry.id, 1)}
                          disabled={index === outlineEntries.length - 1}
                          title={tr("목차 순서를 한 칸 아래로 이동", "Move this outline item one step down")}
                        >
                          ↓
                        </button>
                      </div>
                      <div className="outline-edit-row">
                        <input
                          className="outline-title-input"
                          value={entry.title}
                          onChange={(event) => onUpdateOutlineTitle(entry.id, event.currentTarget.value)}
                          placeholder={tr("목차 제목", "Outline title")}
                          title={tr("목차에 표시할 제목 문구를 입력", "Edit the visible outline title text")}
                        />
                      </div>
                      <div className="outline-meta-row">
                        <input
                          className="outline-page-input"
                          value={entry.pageNumber}
                          onChange={(event) => onUpdateOutlinePageNumber(entry.id, event.currentTarget.value)}
                          inputMode="numeric"
                          title={tr("이 목차가 가리킬 페이지 번호", "Page number this outline item points to")}
                        />
                        <select
                          className="outline-depth-select"
                          value={entry.depth}
                          onChange={(event) => onUpdateOutlineDepth(entry.id, Number.parseInt(event.currentTarget.value, 10))}
                          title={tr("목차 들여쓰기(레벨) 설정", "Set nesting/indent level")}
                        >
                          {Array.from({ length: OUTLINE_MAX_DEPTH + 1 }, (_, depth) => (
                            <option key={depth} value={depth}>
                              L{depth}
                            </option>
                          ))}
                        </select>
                        <button
                          className="ghost-btn micro-btn"
                          type="button"
                          onClick={() => onJumpToOutlinePage(entry.pageNumber)}
                          title={tr("설정한 페이지로 즉시 이동", "Go to the configured page")}
                        >
                          {tr("이동", "Go")}
                        </button>
                        <button
                          className="ghost-btn micro-btn"
                          type="button"
                          onClick={() => onRemoveOutlineEntry(entry.id)}
                          title={tr("이 목차 항목 삭제", "Delete this outline item")}
                        >
                          {tr("삭제", "Del")}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </aside>
  );
}

export default memo(SidebarPanel);
