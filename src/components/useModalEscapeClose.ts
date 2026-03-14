import { useEffect } from "react";

type UseModalEscapeCloseOptions = {
  isOpen: boolean;
  onClose: () => void;
  disabled?: boolean;
};

export function useModalEscapeClose({ isOpen, onClose, disabled = false }: UseModalEscapeCloseOptions) {
  useEffect(() => {
    if (!isOpen || disabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [disabled, isOpen, onClose]);
}
