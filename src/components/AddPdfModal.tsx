import { memo } from "react";

type TranslateFn = (ko: string, en: string) => string;

type AddPdfModalProps = {
  isOpen: boolean;
  tr: TranslateFn;
  addPdfLabel: string;
  addPdfPageCount: number;
  addInsertPosition: "front" | "back";
  setAddInsertPosition: (position: "front" | "back") => void;
  addRangeInput: string;
  setAddRangeInput: (value: string) => void;
  isAddingPdf: boolean;
  onClose: () => void;
  onApply: () => void;
};

function AddPdfModal({
  isOpen,
  tr,
  addPdfLabel,
  addPdfPageCount,
  addInsertPosition,
  setAddInsertPosition,
  addRangeInput,
  setAddRangeInput,
  isAddingPdf,
  onClose,
  onApply,
}: AddPdfModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="panel add-pdf-modal" onClick={(event) => event.stopPropagation()}>
        <h2>{tr("PDF 추가", "Add PDF")}</h2>
        <p>
          {tr("파일", "File")}: <strong>{addPdfLabel}</strong>
          {" · "}
          {tr("페이지", "Pages")} {addPdfPageCount}
        </p>
        <div className="modal-row">
          <span>{tr("추가 위치", "Insert position")}</span>
          <label>
            <input
              type="radio"
              name="add-position"
              value="front"
              checked={addInsertPosition === "front"}
              onChange={() => setAddInsertPosition("front")}
              disabled={isAddingPdf}
            />
            {tr("앞쪽으로", "To front")}
          </label>
          <label>
            <input
              type="radio"
              name="add-position"
              value="back"
              checked={addInsertPosition === "back"}
              onChange={() => setAddInsertPosition("back")}
              disabled={isAddingPdf}
            />
            {tr("뒤쪽으로", "To back")}
          </label>
        </div>
        <label className="modal-range-field">
          <span>{tr("추가 범위", "Pages to add")}</span>
          <input
            value={addRangeInput}
            onChange={(event) => setAddRangeInput(event.currentTarget.value)}
            placeholder="1-3, 5, 9"
            disabled={isAddingPdf}
          />
          <small>{tr("비워두면 전체 페이지를 추가합니다.", "Leave empty to add all pages.")}</small>
        </label>
        <div className="modal-actions">
          <button className="ghost-btn" onClick={onClose} disabled={isAddingPdf} type="button">
            {tr("취소", "Cancel")}
          </button>
          <button className="primary-btn" onClick={onApply} disabled={isAddingPdf} type="button">
            {isAddingPdf ? tr("추가 중...", "Adding...") : tr("추가 실행", "Add")}
          </button>
        </div>
      </section>
    </div>
  );
}

export default memo(AddPdfModal);
