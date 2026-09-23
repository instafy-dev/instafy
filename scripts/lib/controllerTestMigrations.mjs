/**
 * Whether `pnpm test:controller` should bring the local database up to the
 * repository's migrations before running.
 *
 * A running local stack does not migrate itself when the repository gains new
 * migrations, so a stack started days ago silently runs the suite against an
 * old schema. That surfaces as dozens of unrelated "column does not exist"
 * failures. Applying the pending migrations first removes the whole class.
 *
 * Only the local stack is ever touched. An explicit TEST_DATABASE_URL or
 * DATABASE_URL may point at CI or at somebody else's database, so it is used
 * exactly as given.
 */
export const SKIP_MIGRATIONS_ENV = "INSTAFY_TEST_CONTROLLER_SKIP_MIGRATIONS";

export function shouldApplyLocalMigrations({ explicitDbUrl, env = process.env } = {}) {
  if (explicitDbUrl) {
    return false;
  }
  const skip = String(env[SKIP_MIGRATIONS_ENV] ?? "").trim().toLowerCase();
  return !(skip === "1" || skip === "true" || skip === "yes");
}
