export type DesktopUpdaterDownloadState = {
  phase: "idle" | "checking" | "update_available" | "downloading" | "downloaded" | "up_to_date" | "error";
  lastError?: string;
};

/**
 * Electron EventEmitter listeners cannot surface rejected promises. Keep the
 * download transition in a settling helper so both native prompts and renderer
 * actions report a durable error state instead of creating an unhandled
 * rejection in the main process.
 */
export async function settleDesktopUpdaterDownload(
  state: DesktopUpdaterDownloadState,
  download: () => Promise<unknown>,
  onFailure: (message: string) => void,
): Promise<void> {
  state.phase = "downloading";
  state.lastError = undefined;
  try {
    await download();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.phase = "error";
    state.lastError = message;
    onFailure(message);
  }
}
