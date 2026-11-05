import { useId, useRef, useState } from "react";
import { Minus, Plus, Xmark } from "iconoir-react";
import { Button, IconButton } from "../../../components/Button";
import { StudioDialogBody, StudioDialogFooter, StudioDialogHeader } from "../../../components/aria/StudioDialogLayout";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { useStudioMediaImmersive } from "../../../components/aria/studioMediaLayout";
import { useChatImageViewport } from "./useChatImageViewport";
import "./ChatImageLightbox.css";

type ImagePreview = { src: string; alt: string };

function ImagePreviewDialog({ image, onClose }: { image: ImagePreview; onClose: () => void }) {
  const immersive = useStudioMediaImmersive();
  const zoomDescriptionId = useId();
  const [mobileControlsVisible, setMobileControlsVisible] = useState(false);
  const controlsRef = useRef<HTMLDivElement>(null);
  const controlsVisible = !immersive || mobileControlsVisible;
  const revealControls = () => setMobileControlsVisible(true);
  const toggleMobileControls = () => {
    // Never hide a control while keyboard or assistive focus remains on it.
    if (immersive && !controlsRef.current?.contains(document.activeElement)) {
      setMobileControlsVisible(visible => !visible);
    }
  };
  const viewport = useChatImageViewport({ immersive, onDismiss: onClose,
    onImageTap: immersive ? toggleMobileControls : undefined,
  });
  const closeButton = <IconButton
    type="button" variant="ghost" tone={immersive ? "neutral" : "muted"} size="sm"
    onFocus={event => { if (event.target.matches(":focus-visible")) revealControls(); }}
    onPress={onClose} aria-label="Close image preview" data-testid="chat-image-lightbox-close"
  ><Xmark className="h-4 w-4" aria-hidden="true" /></IconButton>;

  return <StudioDialogModal
    isOpen isDismissable onOpenChange={(open) => { if (!open) onClose(); }}
    size="media" layout="media" gutter="responsive"
    appearance={immersive ? "dark" : "default"}
    dialogAriaLabel="Image preview" data-testid="chat-image-lightbox"
  >
    <StudioDialogHeader layout="media" title={image.alt || "Image preview"} trailing={closeButton} />
    <StudioDialogBody className="chat-image-preview-body" data-immersive={immersive} padding={immersive ? "none" : "default"}>
      <div
        ref={viewport.viewportRef} {...viewport.handlers}
        className="chat-image-preview-stage"
        data-testid="chat-image-lightbox-stage"
        data-immersive={immersive}
        data-mode={viewport.mode}
        data-zoomed={!viewport.isOverview}
        data-page-zoomed={viewport.pageZoomed}
        data-interacting={viewport.isInteracting}
        role="region" aria-label="Image inspection" tabIndex={0}
        onFocus={event => { if (event.currentTarget.matches(":focus-visible")) revealControls(); }}
        onKeyDown={event => {
          viewport.handlers.onKeyDown(event);
          if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
          if (immersive && (event.key === " " || event.key === "Enter")) {
            event.preventDefault();
            toggleMobileControls();
          } else if (event.key !== "Escape") revealControls();
        }}
        aria-description="Pinch to zoom. On mobile, double-tap to switch between the whole image and fit width. Drag to pan when enlarged. Tap the image or press Space or Enter to show or hide mobile controls. On desktop, double-click to zoom. Keyboard: plus and minus zoom, arrows pan, 0 fits the image, and 1 shows actual size."
      >
        <img
          src={image.src} alt={image.alt} draggable={false}
          className="chat-image-preview-image"
          data-testid="chat-image-lightbox-image"
          onLoad={viewport.onImageLoad}
          style={viewport.imageStyle}
        />
      </div>
    </StudioDialogBody>
    <div ref={controlsRef} className={`chat-image-preview-tools${immersive ? " bg-zinc-950" : ""}`}
      data-testid="chat-image-controls" data-immersive={immersive} data-visible={controlsVisible}
      onFocusCapture={revealControls} onClickCapture={revealControls}>
      <StudioDialogFooter padding="default" className={immersive ? "chat-image-preview-mobile-footer" : undefined}>
        <div className="chat-image-preview-controls" role="group" aria-label="Image zoom controls">
          <span id={zoomDescriptionId} className="sr-only">{viewport.ready ? `Current zoom: ${viewport.zoomPercent}%` : "Image loading"}</span>
          <IconButton variant="ghost" tone={viewport.canZoomOut ? "neutral" : "muted"} size="sm" aria-label="Zoom out" title="Zoom out (−)"
            data-testid="chat-image-zoom-out" aria-disabled={!viewport.canZoomOut}
            onPress={() => { if (viewport.canZoomOut) viewport.zoomOut(); }}>
            <Minus className="h-4 w-4" aria-hidden="true" />
          </IconButton>
          <Button preset="toolbar" variant="ghost" tone="neutral" aria-label="Actual size (100%)" title="Actual size (100%)"
            aria-describedby={zoomDescriptionId}
            data-testid="chat-image-actual-size" onPress={viewport.actualSize} aria-disabled={!viewport.ready}>
            <span className="w-12 tabular-nums">{viewport.ready ? `${viewport.zoomPercent}%` : "…"}</span>
          </Button>
          <IconButton variant="ghost" tone={viewport.canZoomIn ? "neutral" : "muted"} size="sm" aria-label="Zoom in" title="Zoom in (+)"
            data-testid="chat-image-zoom-in" aria-disabled={!viewport.canZoomIn}
            onPress={() => { if (viewport.canZoomIn) viewport.zoomIn(); }}>
            <Plus className="h-4 w-4" aria-hidden="true" />
          </IconButton>
          <Button preset="toolbarLabel" variant="ghost" tone="neutral"
            aria-label="Fit image" title="Fit image (0)"
            data-testid="chat-image-fit" onPress={viewport.fitOverview}>Fit</Button>
          <Button preset="toolbarLabel" variant="ghost" tone="neutral"
            aria-label="Fit width" title="Fit width"
            data-testid="chat-image-fit-width" onPress={viewport.fitWidth}>Width</Button>
        </div>
      </StudioDialogFooter>
    </div>
  </StudioDialogModal>;
}

export function ChatImageLightboxOverlay({ imageLightbox, onClose }: {
  imageLightbox: ImagePreview | null;
  onClose: () => void;
}) {
  return imageLightbox ? <ImagePreviewDialog key={imageLightbox.src} image={imageLightbox} onClose={onClose} /> : null;
}
