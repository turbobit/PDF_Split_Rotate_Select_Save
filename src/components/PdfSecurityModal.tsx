import { memo, useEffect, useRef } from "react";

type TranslateFn = (ko: string, en: string) => string;

type PdfSecurityModalProps = {
  isOpen: boolean;
  tr: TranslateFn;
  mode: "protect" | "unprotect" | "open";
  password: string;
  confirmPassword: string;
  errorText: string | null;
  isSubmitting: boolean;
  onChangePassword: (value: string) => void;
  onChangeConfirmPassword: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
};

function PdfSecurityModal({
  isOpen,
  tr,
  mode,
  password,
  confirmPassword,
  errorText,
  isSubmitting,
  onChangePassword,
  onChangeConfirmPassword,
  onClose,
  onSubmit,
}: PdfSecurityModalProps) {
  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  const isProtectMode = mode === "protect";
  const isOpenMode = mode === "open";
  const isUnlockMode = mode === "unprotect";

  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setTimeout(() => {
      passwordInputRef.current?.focus();
      passwordInputRef.current?.select();
    }, 30);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={isSubmitting ? undefined : onClose}>
      <section className="panel add-pdf-modal pdf-security-modal" onClick={(event) => event.stopPropagation()}>
        <div className={`pdf-security-hero ${isProtectMode ? "protect" : "unprotect"}`}>
          <span className="pdf-security-badge">
            {isProtectMode
              ? tr("암호 저장", "Protect PDF")
              : isOpenMode
                ? tr("암호 열기", "Open Locked PDF")
                : tr("보안 해제", "Unlock PDF")}
          </span>
          <h2>
            {isProtectMode
              ? tr("선택 페이지 암호 저장", "Save Selected Pages with Password")
              : isOpenMode
                ? tr("암호 PDF 열기", "Open Password-Protected PDF")
                : tr("현재 문서 보안 해제", "Unlock Current PDF")}
          </h2>
          <p>
            {isProtectMode
              ? tr("현재 선택한 페이지를 새 암호 PDF로 저장합니다.", "Save the current selection as a new password-protected PDF.")
              : isOpenMode
                ? tr("이 PDF는 비밀번호가 필요합니다. 비밀번호를 입력해 문서를 엽니다.", "This PDF requires a password. Enter it to open the document.")
                : tr("현재 열린 PDF를 암호 해제된 새 파일로 저장합니다.", "Save the current PDF as a new unlocked file.")}
          </p>
        </div>

        <label className="modal-range-field pdf-security-field">
          <span>
            {isProtectMode
              ? tr("새 비밀번호", "New password")
              : isOpenMode
                ? tr("PDF 비밀번호", "PDF password")
                : tr("문서 비밀번호", "Document password")}
          </span>
          <input
            ref={passwordInputRef}
            type="password"
            value={password}
            onChange={(event) => onChangePassword(event.currentTarget.value)}
            placeholder={
              isProtectMode
                ? tr("새 비밀번호 입력", "Enter a new password")
                : isOpenMode
                  ? tr("PDF 비밀번호 입력", "Enter the PDF password")
                  : tr("현재 비밀번호 입력", "Enter the current password")
            }
            disabled={isSubmitting}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSubmit();
            }}
          />
        </label>

        {isProtectMode ? (
          <label className="modal-range-field pdf-security-field">
            <span>{tr("비밀번호 확인", "Confirm password")}</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => onChangeConfirmPassword(event.currentTarget.value)}
              placeholder={tr("비밀번호 다시 입력", "Re-enter the password")}
              disabled={isSubmitting}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSubmit();
              }}
            />
          </label>
        ) : null}

        {errorText ? <div className="pdf-security-error">{errorText}</div> : null}

        <div className="modal-actions">
          <button className="ghost-btn" onClick={onClose} disabled={isSubmitting} type="button">
            {tr("취소", "Cancel")}
          </button>
          <button className="primary-btn" onClick={onSubmit} disabled={isSubmitting} type="button">
            {isSubmitting
              ? (isProtectMode
                ? tr("암호 저장 중...", "Saving protected PDF...")
                : isUnlockMode
                  ? tr("보안 해제 중...", "Unlocking PDF...")
                  : tr("PDF 여는 중...", "Opening PDF..."))
              : (isProtectMode
                ? tr("암호 저장", "Protect")
                : isUnlockMode
                  ? tr("보안 해제", "Unlock")
                  : tr("PDF 열기", "Open PDF"))}
          </button>
        </div>
      </section>
    </div>
  );
}

export default memo(PdfSecurityModal);
