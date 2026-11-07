import { forwardRef, type ReactNode } from "react";
import { composeRenderProps, type ButtonProps, type PopoverProps } from "react-aria-components";
import { ControlChevron } from "./ControlChevron";
import { ControlTrigger } from "./ControlTrigger";
import { StudioPopover } from "./aria/StudioPopover";

type FormPickerTriggerProps = Omit<ButtonProps, "children"> & {
  children: ReactNode;
  leading?: ReactNode;
};

/** Form-sized menu trigger; the owning picker keeps its selection and actions. */
export const FormPickerTrigger = forwardRef<HTMLButtonElement, FormPickerTriggerProps>(function FormPickerTrigger(
  { children, leading, className, ...props },
  ref,
) {
  return (
    <ControlTrigger
      {...props}
      ref={ref}
      aria-haspopup="menu"
      className={composeRenderProps(className, (extra) => [
        "justify-between gap-2",
        extra,
      ].filter(Boolean).join(" "))}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
        {leading ? <span className="shrink-0">{leading}</span> : null}
        <span className="truncate">{children}</span>
      </span>
      <ControlChevron />
    </ControlTrigger>
  );
});

export function FormPickerPopover(props: PopoverProps) {
  return (
    <StudioPopover
      isNonModal
      placement="bottom start"
      layout="form"
      {...props}
    />
  );
}
