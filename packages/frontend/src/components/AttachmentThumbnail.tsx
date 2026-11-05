import type { ImgHTMLAttributes } from "react";
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
  onImageError?: ImgHTMLAttributes<HTMLImageElement>["onError"];
};

/** Image content supplies the preview; shared buttons own focus and interaction. */
export function AttachmentThumbnail({ src, alt, size, onPress, onImageError, ...props }: AttachmentThumbnailProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      radius="lg"
      elevation="none"
      className={`${SIZE_CLASSES[size]} shrink-0 overflow-hidden`}
      onPress={onPress ? (event) => {
        // Touch activation may leave focus in the composer. Give the preview
        // an explicit return target so closing it does not reopen the keyboard.
        if (event.target instanceof HTMLElement) event.target.focus({ preventScroll: true });
        onPress(event);
      } : undefined}
      aria-label={`Open ${alt}`}
      {...props}
    >
      <img src={src} alt={alt} onError={onImageError} className="h-full w-full object-cover" />
    </Button>
  );
}
