/**
 * The variables that point git at a repository, index, object store or ref namespace other than the
 * one its folder and its own arguments name. git exports them to the commands it runs: GIT_DIR, an
 * absolute path in a linked worktree, to a `git rebase --exec` command, a `!` alias and every hook,
 * and GIT_INDEX_FILE to a commit hook. `--git-dir` and `--work-tree` replace GIT_DIR and
 * GIT_WORK_TREE but not the rest, so `instafy git add` run from a commit hook would otherwise stage
 * into that hook's index.
 *
 * They are what `git rev-parse --local-env-vars` lists, which git clears itself before it works in
 * another repository, less GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT, which it keeps for that
 * repository too (they carry `-c` settings, not a location). Added to them: a push's ref namespace, the
 * quarantine a pre-receive hook's objects wait in, and the submodule prefix an older git sets.
 */
export const GIT_REPOSITORY_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_GRAFT_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_PREFIX",
  "GIT_NAMESPACE",
  "GIT_QUARANTINE_PATH",
  "GIT_INTERNAL_SUPER_PREFIX",
] as const;

/** A copy of `env` without {@link GIT_REPOSITORY_ENV}. */
export function withoutGitRepositoryEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of GIT_REPOSITORY_ENV) {
    delete copy[key];
  }
  return copy;
}
