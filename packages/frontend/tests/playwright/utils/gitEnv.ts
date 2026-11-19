// The environment for git that a test runs in its own temp folder. git exports GIT_DIR, an absolute path in a linked
// worktree, to the commands `git rebase --exec` runs and to hooks, and GIT_INDEX_FILE to commit hooks. A test's git
// that inherited them would init, check out, commit and push in the developer's repository instead of its temp
// folder. These are the variables git itself clears when it moves into another repository
// (`git rev-parse --local-env-vars`); everything else, such as a proxy the git server needs, is kept.
const REPOSITORY_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

export function testGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const name of REPOSITORY_VARIABLES) {
    delete env[name];
  }
  return env;
}
