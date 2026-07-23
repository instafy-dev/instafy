export type ShowStatusFn = (
  message: string,
  intent?: "success" | "info" | "warning" | "error",
  duration?: number,
  options?: { id?: string; actionLabel?: string; onAction?: () => void },
) => void;
