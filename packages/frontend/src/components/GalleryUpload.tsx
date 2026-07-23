import { useRef } from "react";
import { Button } from "./Button";
import { toDataUrl } from "../utils/file";

type GalleryUploadProps = {
  images: string[];
  onChange: (images: string[]) => void;
};

export function GalleryUpload({ images, onChange }: GalleryUploadProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleAdd = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    const file = files[0];
    const url = await toDataUrl(file);
    onChange([...images, url]);
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  };

  const handleRemove = (index: number) => {
    const next = images.filter((_, i) => i !== index);
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {images.map((image, index) => (
          <div key={image + index} className="relative">
            <img src={image} alt={`Gallery ${index + 1}`} className="h-20 w-20 rounded-2xl object-cover" />
            <Button
              onPress={() => handleRemove(index)}
              variant="ghost"
              size="icon"
              radius="full"
              className="absolute -top-2 -right-2 h-6 w-6 bg-purple-600 text-xs text-white hover:bg-purple-700 data-[hovered]:bg-purple-700"
            >
              ×
            </Button>
          </div>
        ))}
        <Button
          onPress={() => inputRef.current?.click()}
          variant="ghost"
          size="icon"
          radius="2xl"
          className="h-20 w-20 border-2 border-dashed border-purple-300 text-sm text-purple-500 hover:bg-purple-50 data-[hovered]:bg-purple-50"
        >
          + Add
        </Button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={async (event) => {
          await handleAdd(event.target.files);
        }}
      />
    </div>
  );
}
