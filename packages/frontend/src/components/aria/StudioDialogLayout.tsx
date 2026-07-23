import type { ReactNode } from "react";
import { Xmark } from "iconoir-react";
import { IconButton } from "../Button";
import { Text } from "../Text";

const CLOSE_BUTTON_CLASS =
  "text-slate-400 hover:text-slate-700 data-[hovered]:text-slate-700 dark:text-slate-500 dark:hover:text-slate-200 dark:data-[hovered]:text-slate-200";

type StudioDialogHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  onClose?: (() => void) | null;
  closeLabel?: string;
  closeButtonDisabled?: boolean;
  className?: string;
  titleClassName?: string;
  descriptionClassName?: string;
};

export function StudioDialogHeader({
  title,
  description,
  leading,
  trailing,
  onClose = null,
  closeLabel = "Close dialog",
  closeButtonDisabled = false,
  className,
  titleClassName,
  descriptionClassName,
}: StudioDialogHeaderProps) {
  const leftClassName = leading ? "flex min-w-0 items-start gap-2" : "min-w-0";

  return (
    <div
      className={[
        "border-b border-slate-200/70 px-5 py-4 dark:border-[color:var(--color-studio-dark-divider)]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex items-start justify-between gap-4">
        <div className={leftClassName}>
          {leading}
          <div className="min-w-0">
            <Text
              as="h2"
              variant="bodyStrong"
              tone="primary"
              className={["truncate text-base", titleClassName].filter(Boolean).join(" ")}
            >
              {title}
            </Text>
            {description ? (
              <Text
                as="p"
                variant="body"
                tone="muted"
                className={["mt-1", descriptionClassName].filter(Boolean).join(" ")}
              >
                {description}
              </Text>
            ) : null}
          </div>
        </div>
        {trailing || onClose ? (
          <div className="flex shrink-0 items-center gap-2">
            {trailing}
            {onClose ? (
              <IconButton
                type="button"
                variant="ghost"
                size="sm"
                radius="full"
                onPress={onClose}
                aria-label={closeLabel}
                className={CLOSE_BUTTON_CLASS}
                isDisabled={closeButtonDisabled}
              >
                <Xmark className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type StudioDialogBodyProps = {
  children: ReactNode;
  className?: string;
};

export function StudioDialogBody({ children, className }: StudioDialogBodyProps) {
  return <div className={["px-5 py-4", className].filter(Boolean).join(" ")}>{children}</div>;
}

type StudioDialogSectionLabelProps = {
  children: ReactNode;
  className?: string;
};

export function StudioDialogSectionLabel({
  children,
  className,
}: StudioDialogSectionLabelProps) {
  return (
    <Text
      variant="caption"
      tone="muted"
      className={["text-xs font-semibold text-slate-500", className].filter(Boolean).join(" ")}
    >
      {children}
    </Text>
  );
}

type StudioDialogDividerProps = {
  className?: string;
};

export function StudioDialogDivider({ className }: StudioDialogDividerProps) {
  return (
    <div
      className={["h-px bg-slate-200/80 dark:bg-[var(--color-studio-dark-divider)]", className].filter(Boolean).join(" ")}
    />
  );
}
