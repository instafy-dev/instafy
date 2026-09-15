import { useRef, type ReactNode } from "react";
import { EditPencil } from "iconoir-react";
import { Button } from "./Button";

/** One accessible photo target shared by people, teams and spaces. */
export function IdentityPhotoButton({ children, label, disabled, square = false, onSelect,
  accept = "image/*", testId, inputTestId }: {
  children: ReactNode;
  label: string;
  disabled?: boolean;
  square?: boolean;
  onSelect: (file: File) => void;
  accept?: string;
  testId?: string;
  inputTestId?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <input ref={input} type="file" accept={accept} aria-label={label} disabled={disabled}
      className="hidden" data-testid={inputTestId} onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) onSelect(file);
      }} />
    <Button aria-label={label} title={label} onPress={() => input.current?.click()}
      isDisabled={disabled} variant="ghost" size="icon" radius={square ? "xl" : "full"}
      className="group relative h-16 w-16 shrink-0" data-testid={testId}>
      {children}
      <span aria-hidden="true" className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm group-hover:bg-slate-50 dark:border-[color:var(--color-studio-dark-raised-control-border)] dark:bg-[var(--color-studio-dark-raised-control)] dark:text-slate-100 dark:group-hover:bg-[var(--color-studio-dark-control-hover)]">
        <EditPencil className="h-3.5 w-3.5" />
      </span>
    </Button>
  </>;
}
