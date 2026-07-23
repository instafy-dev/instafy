type PasswordSignInResult = {
  error?: unknown;
};

type PasswordSignInClient = {
  signInWithPassword: (credentials: {
    email: string;
    password: string;
  }) => Promise<PasswordSignInResult>;
  signOut: (options: { scope: "local" }) => Promise<unknown>;
};

export function isInvalidRefreshTokenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return normalized.includes("invalid refresh token") || normalized.includes("refresh token not found");
}

export async function signInWithPasswordRecoveringInvalidRefreshToken(
  auth: PasswordSignInClient,
  credentials: { email: string; password: string },
  options: { clearAuthStorage: () => void },
) {
  let result = await auth.signInWithPassword(credentials);
  if (result.error && isInvalidRefreshTokenError(result.error)) {
    await auth.signOut({ scope: "local" }).catch(() => {});
    options.clearAuthStorage();
    result = await auth.signInWithPassword(credentials);
  }
  if (result.error) {
    throw result.error;
  }
  return result;
}
