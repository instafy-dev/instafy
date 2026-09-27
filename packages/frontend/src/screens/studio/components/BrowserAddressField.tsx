import { forwardRef, useId, type FormEventHandler } from "react";
import { NavArrowRight } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { Input, type InputProps } from "../../../components/Input";

type BrowserAddressFieldProps = Pick<InputProps, "value" | "placeholder" | "disabled" | "onChange" | "onBlur"> & {
  testIdPrefix: string;
  errorId?: string;
  invalid?: boolean;
  onSubmit: FormEventHandler<HTMLFormElement>;
};

// Personal and Shared browsing keep their navigation state and authorization
// in their own controllers; this is their common address/submit presentation.
export const BrowserAddressField = forwardRef<HTMLInputElement, BrowserAddressFieldProps>(function BrowserAddressField({
  testIdPrefix, errorId, invalid, onSubmit, ...inputProps
}, ref) {
  const id = useId();
  return (
    <form className="relative w-full min-w-0" data-testid={`${testIdPrefix}-address-form`} onSubmit={onSubmit}>
      <label className="sr-only" htmlFor={id}>Address</label>
      <Input
        {...inputProps}
        ref={ref}
        id={id}
        aria-label="Address"
        aria-describedby={errorId}
        aria-invalid={invalid || undefined}
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        type="text"
        size="xs"
        radius="full"
        className="h-8 min-w-0 pl-3 pr-9 aria-invalid:border-rose-400 aria-invalid:focus-visible:ring-rose-500/20 max-[540px]:h-10 max-[540px]:pr-11 pointer-coarse:h-11 pointer-coarse:pr-12"
        data-testid={`${testIdPrefix}-address`}
      />
      <span className="absolute inset-y-0 right-0 flex items-center">
        <IconButton
          aria-label="Go"
          title="Go"
          data-testid={`${testIdPrefix}-go`}
          type="submit"
          size="xs"
          radius="full"
          variant="ghost"
          className="max-[540px]:h-10 max-[540px]:w-10"
          isDisabled={inputProps.disabled}
        >
          <NavArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
        </IconButton>
      </span>
    </form>
  );
});
