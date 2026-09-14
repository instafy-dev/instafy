import { PROFILE_BIO_MAX_LENGTH } from "@instafy/sdk/human-profiles";
import { Field } from "./Field";
import { Textarea } from "./Textarea";
import { Text } from "./Text";

export function ProfileBioField({ id, value, onChange, disabled, isAgent = false }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  isAgent?: boolean;
}) {
  const length = Array.from(value).length;
  const invalid = length > PROFILE_BIO_MAX_LENGTH;
  return (
    <Field label="About" htmlFor={id}>
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        rows={4}
        aria-describedby={`${id}-help ${id}-count`}
        aria-invalid={invalid || undefined}
        className="min-h-28 resize-y leading-relaxed"
      />
      <div className="flex items-start justify-between gap-4">
        <Text id={`${id}-help`} as="p" variant="caption" tone="muted">
          {isAgent ? "Optional. Introduce this agent to teammates. This does not change its instructions."
            : "Optional. Share what you work on or how you can help."}
        </Text>
        <Text id={`${id}-count`} as="p" variant="caption" tone={invalid ? "danger" : "muted"} className="shrink-0 tabular-nums">
          {length}/{PROFILE_BIO_MAX_LENGTH}
        </Text>
      </div>
      {invalid ? <Text as="p" role="alert" variant="caption" tone="danger">Use {PROFILE_BIO_MAX_LENGTH} characters or fewer.</Text> : null}
    </Field>
  );
}
