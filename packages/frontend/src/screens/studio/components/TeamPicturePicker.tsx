import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import { getOrgInitials } from "../../../org/orgNaming";
import { validateTeamAvatar } from "./teamAvatar";

export function TeamPicturePicker({
  name, file, onChange, disabled = false, testId = "new-team-picture",
}: {
  name: string;
  file: File | null;
  onChange: (file: File | null) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <div className="space-y-2" data-testid={testId}>
      <Text variant="caption" tone="muted">Team picture (optional)</Text>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-200/80 text-sm font-semibold text-slate-600 dark:bg-white/[0.08] dark:text-slate-300">
          {preview ? <img src={preview} alt="Selected team picture" className="h-full w-full object-cover" /> : getOrgInitials(name)}
        </span>
        <input ref={input} type="file" accept="image/*" className="hidden" disabled={disabled}
          data-testid={`${testId}-input`} onChange={(event) => {
            const next = event.target.files?.[0];
            event.target.value = "";
            if (!next) return;
            const invalid = validateTeamAvatar(next);
            setError(invalid);
            if (!invalid) onChange(next);
          }} />
        <Button type="button" variant="outline" size="xs" radius="full" isDisabled={disabled}
          onPress={() => input.current?.click()}>{file ? "Change picture" : "Add picture"}</Button>
        {file ? <Button type="button" variant="ghost" size="xs" isDisabled={disabled}
          onPress={() => { onChange(null); setError(null); }}>Remove</Button> : null}
      </div>
      <Text variant="caption" tone="muted">Images up to 2 MB. You can change this later in Team profile.</Text>
      {error ? <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{error}</p> : null}
    </div>
  );
}
