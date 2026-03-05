import { memo, type RefObject } from "react";

type TranslateFn = (ko: string, en: string) => string;
type MergeInsertPosition = "front" | "back" | "beforeActive" | "afterActive";

type MergePdfModalProps = {
  isOpen: boolean;
  tr: TranslateFn;
  mergeInsertPosition: MergeInsertPosition;
  setMergeInsertPosition: (position: MergeInsertPosition) => void;
  isAddingPdf: boolean;
  hasCurrentPdf: boolean;
  mergePdfPaths: string[];
  mergeDraggingPath: string | null;
  mergeDropPath: string | null;
  mergeListRef: RefObject<HTMLDivElement | null>;
  normalizeFileStem: (path: string) => string;
  onStartDrag: (path: string, index: number) => void;
  onClose: () => void;
  onApply: () => void;
};

function MergePdfModal({
  isOpen,
  tr,
  mergeInsertPosition,
  setMergeInsertPosition,
  isAddingPdf,
  hasCurrentPdf,
  mergePdfPaths,
  mergeDraggingPath,
  mergeDropPath,
  mergeListRef,
  normalizeFileStem,
  onStartDrag,
  onClose,
  onApply,
}: MergePdfModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="panel add-pdf-modal merge-pdf-modal" onClick={(event) => event.stopPropagation()}>
        <h2>{tr("PDF 병합", "Merge PDFs")}</h2>
        <p>{tr("드래그앤드랍으로 병합 순서를 정하세요.", "Drag and drop to reorder merge files.")}</p>
        <div className="modal-row">
          <span>{tr("삽입 위치", "Insert position")}</span>
          <label>
            <input
              type="radio"
              name="merge-position"
              value="front"
              checked={mergeInsertPosition === "front"}
              onChange={() => setMergeInsertPosition("front")}
              disabled={isAddingPdf}
            />
            {tr("앞쪽", "Front")}
          </label>
          <label>
            <input
              type="radio"
              name="merge-position"
              value="back"
              checked={mergeInsertPosition === "back"}
              onChange={() => setMergeInsertPosition("back")}
              disabled={isAddingPdf}
            />
            {tr("뒤쪽", "Back")}
          </label>
          <label>
            <input
              type="radio"
              name="merge-position"
              value="beforeActive"
              checked={mergeInsertPosition === "beforeActive"}
              onChange={() => setMergeInsertPosition("beforeActive")}
              disabled={isAddingPdf || !hasCurrentPdf}
            />
            {tr("현재 앞", "Before current")}
          </label>
          <label>
            <input
              type="radio"
              name="merge-position"
              value="afterActive"
              checked={mergeInsertPosition === "afterActive"}
              onChange={() => setMergeInsertPosition("afterActive")}
              disabled={isAddingPdf || !hasCurrentPdf}
            />
            {tr("현재 뒤", "After current")}
          </label>
        </div>
        <div className="merge-list" ref={mergeListRef}>
          {mergePdfPaths.map((path, index) => (
            <article
              key={path}
              className={`merge-item ${mergeDraggingPath === path ? "dragging" : ""} ${mergeDropPath === path ? "drop-target" : ""}`}
            >
              <span
                className="merge-drag-handle"
                title={tr("여기를 잡고 드래그하여 순서 이동", "Drag here to reorder")}
                aria-label={tr("드래그 핸들", "Drag handle")}
                onMouseDown={(event) => {
                  if (isAddingPdf) return;
                  event.preventDefault();
                  event.stopPropagation();
                  onStartDrag(path, index);
                }}
              >
                |||
              </span>
              <span className="merge-index">{index + 1}</span>
              <span className="merge-name">{normalizeFileStem(path)}</span>
            </article>
          ))}
        </div>
        <div className="modal-actions">
          <button className="ghost-btn" onClick={onClose} disabled={isAddingPdf} type="button">
            {tr("취소", "Cancel")}
          </button>
          <button className="primary-btn" onClick={onApply} disabled={isAddingPdf || mergePdfPaths.length === 0} type="button">
            {isAddingPdf ? tr("병합 중...", "Merging...") : tr("병합 실행", "Merge")}
          </button>
        </div>
      </section>
    </div>
  );
}

export default memo(MergePdfModal);
