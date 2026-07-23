import type { ChangeEvent } from "react";
import { FormField } from "./FormField";
import { toDataUrl } from "../utils/file";

type UploadFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
};

export function UploadField({ label, value, hint, onChange }: UploadFieldProps) {
  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const url = await toDataUrl(file);
    onChange(url);
  };

  return (
    <FormField label={label} hint={hint}>
      <div className="flex items-center gap-4">
        <div className="h-20 w-20 overflow-hidden rounded-2xl bg-purple-100 flex items-center justify-center text-xs text-purple-500">
          {value ? <img src={value} alt={label} className="h-full w-full object-cover" /> : "Upload"}
        </div>
        <input
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="rounded-full border border-purple-300 bg-white px-4 py-2 text-base shadow-sm sm:text-sm"
        />
      </div>
    </FormField>
  );
}
