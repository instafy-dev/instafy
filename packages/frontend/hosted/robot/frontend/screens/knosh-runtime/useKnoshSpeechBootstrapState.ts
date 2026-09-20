import { useCallback, useState } from "react";
import {
  bootstrapSpeechDependencies,
  type SpeechBootstrapResult,
  type SpeechDependencyStatus,
} from "@instafy/frontend/feature-api/voice";

type ShowStatus = (message: string, intent?: "success" | "error" | "warning" | "info", durationMs?: number) => void;

type UseKnoshSpeechBootstrapStateOptions = {
  setSpeechDependencyStatus: (
    value:
      | SpeechDependencyStatus
      | null
      | ((current: SpeechDependencyStatus | null) => SpeechDependencyStatus | null),
  ) => void;
  refreshSpeechDependencies: () => Promise<void>;
  showStatus: ShowStatus;
};

export function useKnoshSpeechBootstrapState({
  refreshSpeechDependencies,
  setSpeechDependencyStatus,
  showStatus,
}: UseKnoshSpeechBootstrapStateOptions) {
  const [speechBootstrapBusy, setSpeechBootstrapBusy] = useState(false);
  const [speechBootstrapResult, setSpeechBootstrapResult] =
    useState<SpeechBootstrapResult | null>(null);

  const runSpeechBootstrap = useCallback(
    async (action: "check" | "install_transcription", dryRun = false) => {
      setSpeechBootstrapBusy(true);
      try {
        const { result } = await bootstrapSpeechDependencies({ action, dryRun });
        setSpeechBootstrapResult(result);
        if (result?.status) {
          setSpeechDependencyStatus(result.status);
        } else {
          await refreshSpeechDependencies();
        }
        if (result?.ok === false && result.error) {
          showStatus(result.error, "error", 4500);
          return;
        }
        if (action === "install_transcription" && result?.ok) {
          showStatus(
            "Speech backend install finished. Start the local speech service next.",
            "success",
            4000,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatus(message, "error", 4500);
      } finally {
        setSpeechBootstrapBusy(false);
      }
    },
    [refreshSpeechDependencies, setSpeechDependencyStatus, showStatus],
  );

  return {
    speechBootstrapBusy,
    speechBootstrapResult,
    runSpeechBootstrap,
  };
}
