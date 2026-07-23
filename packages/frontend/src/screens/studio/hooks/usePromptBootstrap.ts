import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useProject } from "../../../projects/useProject";
import { usePromptActions, type SubmitPromptResult } from "../../../prompts/usePromptActions";

type PromptBootstrapCallback = (result: SubmitPromptResult) => void;

export function usePromptBootstrap(onHandled?: PromptBootstrapCallback) {
  const { projectInitialized } = useProject();
  const { submitPrompt } = usePromptActions();
  const location = useLocation();
  const navigate = useNavigate();
  const handledPromptRef = useRef<string | null>(null);
  const isProcessingRef = useRef(false);

  useEffect(() => {
    if (!projectInitialized || isProcessingRef.current) {
      return;
    }
    const params = new URLSearchParams(location.search);
    const prompt = params.get("prompt");
    if (!prompt) {
      handledPromptRef.current = null;
      return;
    }
    const trimmed = prompt.trim();
    if (!trimmed) {
      navigate("/studio", { replace: true });
      return;
    }
    if (handledPromptRef.current === trimmed) {
      navigate("/studio", { replace: true });
      return;
    }

    handledPromptRef.current = trimmed;
    isProcessingRef.current = true;

    void submitPrompt(trimmed)
      .then((result) => {
        onHandled?.(result);
      })
      .finally(() => {
        navigate("/studio", { replace: true });
        isProcessingRef.current = false;
      });
  }, [location.search, navigate, onHandled, projectInitialized, submitPrompt]);
}
