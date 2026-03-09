import { memo } from "react";

type TranslateFn = (ko: string, en: string) => string;

export type PdfInfoField = {
  label: string;
  value: string;
};

type PdfInfoModalProps = {
  isOpen: boolean;
  tr: TranslateFn;
  activeTab: "metadata" | "fonts";
  onChangeTab: (tab: "metadata" | "fonts") => void;
  onClose: () => void;
  isLoading: boolean;
  metadataFields: PdfInfoField[];
  fontNames: string[];
};

function PdfInfoModal({
  isOpen,
  tr,
  activeTab,
  onChangeTab,
  onClose,
  isLoading,
  metadataFields,
  fontNames,
}: PdfInfoModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="panel add-pdf-modal pdf-info-modal" onClick={(event) => event.stopPropagation()}>
        <h2>{tr("PDF 정보", "PDF Info")}</h2>
        <div className="pdf-info-tab-row">
          <button
            className={`ghost-btn micro-btn ${activeTab === "metadata" ? "tab-active" : ""}`}
            type="button"
            onClick={() => onChangeTab("metadata")}
          >
            {tr("문서 정보", "Document Info")}
          </button>
          <button
            className={`ghost-btn micro-btn ${activeTab === "fonts" ? "tab-active" : ""}`}
            type="button"
            onClick={() => onChangeTab("fonts")}
          >
            {tr("폰트 목록", "Fonts")}
          </button>
        </div>
        {isLoading ? <div className="empty-panel">{tr("PDF 정보를 불러오는 중...", "Loading PDF info...")}</div> : null}
        {!isLoading && activeTab === "metadata" ? (
          <div className="pdf-info-list">
            {metadataFields.length > 0 ? metadataFields.map((field) => (
              <div key={field.label} className="pdf-info-item">
                <strong>{field.label}</strong>
                <span>{field.value}</span>
              </div>
            )) : (
              <div className="empty-panel">{tr("표시할 문서 정보가 없습니다.", "No document info available.")}</div>
            )}
          </div>
        ) : null}
        {!isLoading && activeTab === "fonts" ? (
          <div className="pdf-font-list">
            {fontNames.length > 0 ? fontNames.map((fontName) => (
              <div key={fontName} className="pdf-font-item">{fontName}</div>
            )) : (
              <div className="empty-panel">{tr("감지된 폰트가 없습니다.", "No fonts detected.")}</div>
            )}
          </div>
        ) : null}
        <div className="modal-actions">
          <button className="ghost-btn" onClick={onClose} type="button">
            {tr("닫기", "Close")}
          </button>
        </div>
      </section>
    </div>
  );
}

export default memo(PdfInfoModal);
