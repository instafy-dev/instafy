declare module "@novnc/novnc/lib/rfb" {
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: unknown);

    disconnect(): void;

    addEventListener(type: string, listener: (...args: unknown[]) => void): void;
    removeEventListener(type: string, listener: (...args: unknown[]) => void): void;

    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    compressionLevel: number;
    qualityLevel: number;
  }
}
