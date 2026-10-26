import { Button, type ButtonProps } from "./Button";

type AttachmentThumbnailSize = "composer" | "message";

const SIZE_CLASSES: Record<AttachmentThumbnailSize, string> = {
  composer: "h-12 w-12",
  message: "h-24 w-24",
};

export type AttachmentThumbnailProps = {
  src: string;
  alt: string;
  size: AttachmentThumbnailSize;
  onPress?: ButtonProps["onPress"];
  "aria-label"?: string;
  "data-testid"?: string;
  title?: string;
};

/** Image content supplies the preview; shared buttons own focus and interaction. */
export function AttachmentThumbnail({ src, alt, size, onPress, ...props }: AttachmentThumbnailProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      radius="lg"
      elevation="none"
      className={`${SIZE_CLASSES[size]} shrink-0 overflow-hidden`}
      onPress={onPress}
      aria-label={`Open ${alt}`}
      {...props}
    >
      <img src={src} alt={alt} className="h-full w-full object-cover" />
    </Button>
  );
}
