import { memo } from "react";
import { useModalEscapeClose } from "./useModalEscapeClose";

type TranslateFn = (ko: string, en: string) => string;

export type PdfInfoField = {
  label: string;
  value: string;
};

export type PdfFontInfo = {
  name: string;
  pageCount: number;
};

type PdfInfoModalProps = {
  isOpen: boolean;
  tr: TranslateFn;
  activeTab: "metadata" | "fonts";
  onChangeTab: (tab: "metadata" | "fonts") => void;
  onClose: () => void;
  isLoading: boolean;
  loadingText: string;
  onCancelLoading: () => void;
  metadataFields: PdfInfoField[];
  fonts: PdfFontInfo[];
  onCopyFontName: (fontName: string) => void;
  onSearchFontInfo: (fontName: string) => void;
};

function PdfInfoModal({
  isOpen,
  tr,
  activeTab,
  onChangeTab,
  onClose,
  isLoading,
  loadingText,
  onCancelLoading,
  metadataFields,
  fonts,
  onCopyFontName,
  onSearchFontInfo,
}: PdfInfoModalProps) {
  useModalEscapeClose({
    isOpen,
    onClose,
  });

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
        {isLoading ? (
          <div className="empty-panel">
            <div>{loadingText || tr("PDF 정보를 불러오는 중...", "Loading PDF info...")}</div>
            <button className="ghost-btn micro-btn" type="button" onClick={onCancelLoading}>
              {tr("중지", "Stop")}
            </button>
          </div>
        ) : null}
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
            {fonts.length > 0 ? fonts.map((font) => (
              <div key={font.name} className="pdf-font-item">
                <div className="pdf-font-item-top">
                  <input
                    className="pdf-font-name-input"
                    type="text"
                    value={font.name}
                    readOnly
                    onFocus={(event) => event.currentTarget.select()}
                    aria-label={tr("폰트 이름", "Font name")}
                    title={font.name}
                  />
                  <span className="pdf-font-meta">
                    {tr("사용 페이지", "Used on pages")} {font.pageCount}
                  </span>
                </div>
                <div className="pdf-font-actions">
                  <button className="ghost-btn micro-btn" type="button" onClick={() => onCopyFontName(font.name)}>
                    {tr("복사", "Copy")}
                  </button>
                  <button className="ghost-btn micro-btn" type="button" onClick={() => onSearchFontInfo(font.name)}>
                    {tr("폰트정보검색", "Search Font Info")}
                  </button>
                </div>
              </div>
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
