import { ChangeEvent, KeyboardEvent } from "react";

interface CertIdInputProps {
  value: string;                          // e.g. "MV141" (or "141" if returnFullId=false)
  onChange: (value: string) => void;
  returnFullId?: boolean;                 // default true — emits "MV141"; false emits "141"
  maxDigits?: number;                     // default 6
  placeholder?: string;                   // shown inside the digits portion only
  disabled?: boolean;
  error?: boolean;                        // toggles red border
  bordered?: boolean;                     // default true — set false when embedding in an outer styled wrapper
  className?: string;                     // applied to outer wrapper
  inputClassName?: string;                // applied to inner <input>
  prefixClassName?: string;               // applied to "MV" block
  autoFocus?: boolean;
  ariaLabel?: string;
  onEnter?: () => void;
  id?: string;
  testId?: string;
}

function extractDigits(raw: string, max: number): string {
  // Strip optional "MV" or "MV-" prefix (case-insensitive), keep only digits
  return raw.replace(/^MV-?/i, "").replace(/[^0-9]/g, "").slice(0, max);
}

export default function CertIdInput({
  value,
  onChange,
  returnFullId = true,
  maxDigits = 6,
  placeholder = "",
  disabled = false,
  error = false,
  bordered = true,
  className = "",
  inputClassName = "",
  prefixClassName = "",
  autoFocus = false,
  ariaLabel = "Certificate number",
  onEnter,
  id,
  testId,
}: CertIdInputProps) {
  const digits = extractDigits(value, maxDigits);

  function emit(nextDigits: string) {
    const clean = nextDigits.slice(0, maxDigits);
    onChange(returnFullId ? `MV${clean}` : clean);
  }

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    emit(extractDigits(e.target.value, maxDigits));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && onEnter) {
      e.preventDefault();
      onEnter();
      return;
    }
    const allowed = [
      "Backspace", "Delete", "Tab",
      "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
      "Home", "End",
    ];
    if (allowed.includes(e.key) || e.ctrlKey || e.metaKey) return;
    if (!/^[0-9]$/.test(e.key)) e.preventDefault();
  }

  const wrapperStyle: React.CSSProperties = bordered
    ? {
        border: `1px solid ${error ? "#b33" : "var(--v2-line, #E8E4DC)"}`,
        backgroundColor: "var(--v2-paper, #FFFFFF)",
        opacity: disabled ? 0.6 : 1,
      }
    : { opacity: disabled ? 0.6 : 1 };

  return (
    <div
      className={`flex items-stretch overflow-hidden ${className}`}
      style={wrapperStyle}
    >
      <span
        aria-hidden="true"
        className={`flex items-center px-3 font-mono text-sm select-none ${prefixClassName}`}
        style={{
          color: "var(--v2-ink-mute, #999999)",
          backgroundColor: "var(--v2-paper-raised, #FAFAF8)",
          borderRight: "1px solid var(--v2-line, #E8E4DC)",
          letterSpacing: "0.05em",
        }}
      >
        MV
      </span>
      <input
        id={id}
        data-testid={testId}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        maxLength={maxDigits}
        value={digits}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        className={`flex-1 bg-transparent outline-none px-3 py-2 font-mono text-sm ${inputClassName}`}
        style={{ color: "var(--v2-ink, #1A1A1A)", minWidth: 0 }}
      />
    </div>
  );
}
