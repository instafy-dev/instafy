import assert from "node:assert/strict";

const step = "      - name: Install fixture display, database and compiler prerequisites\n";
const current = `${step}        timeout-minutes: 10\n`;
const previous = `${step}        timeout-minutes: 5\n`;
const count = (source, text) => source.split(text).length - 1;

const chromium = "      - name: Install locked Chromium and operating-system dependencies\n";
const selfHosted = "        if: runner.environment == 'self-hosted'\n";
const withDeps = "        run: pnpm --filter @instafy/frontend exec playwright install --with-deps chromium\n";
// Browser UI shares the Chromium step name; only the Shared children bind the
// launcher next, so every span below is anchored on that neighbour.
const bind = "      - name: Bind the launcher to the locked test Chromium\n";
export const HOSTED_CHROMIUM_STEP = [
  "      - name: Install locked Chromium on the provisioned hosted image",
  "        if: runner.environment == 'github-hosted'",
  "        timeout-minutes: 10",
  "        run: |",
  "          pnpm --filter @instafy/frontend exec playwright install chromium",
  "          node scripts/ensure-hosted-chromium-host.mjs install",
  "",
].join("\n");
const guards = "scripts/lib/sharedStudioProvider.test.mjs scripts/check-shared-browser-ci.test.mjs";
const hostedGuard = " scripts/ensure-hosted-chromium-host.test.mjs";

// Test-only inverse for the hosted Chromium split: removes exactly the two
// hosted steps, the two self-hosted guards and the two unit-test arguments.
export function withoutHostedChromiumInstall(file, source) {
  if (file !== "browser-e2e.yml") return source;
  const pair = `${chromium}${selfHosted}${withDeps}${HOSTED_CHROMIUM_STEP}${bind}`;
  assert.equal(count(source, pair), 2, "both Shared children must pair the self-hosted --with-deps step with the hosted Chromium step");
  assert.equal(count(source, `${chromium}${withDeps}`), 1, "only Browser UI keeps the unconditional Chromium step");
  assert.equal(count(source, HOSTED_CHROMIUM_STEP), 2, "exactly two hosted Chromium steps");
  assert.equal(count(source, `${guards}${hostedGuard}\n`), 2, "both Shared guard steps must run the hosted-image unit tests");
  assert.equal(count(source, "scripts/ensure-hosted-chromium-host.mjs"), 2);
  assert.equal(count(source, "scripts/ensure-hosted-chromium-host.test.mjs"), 2);
  return source.replaceAll(pair, `${chromium}${withDeps}${bind}`).replaceAll(`${guards}${hostedGuard}\n`, `${guards}\n`);
}

const apt = "apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30";
const packageCheck = "            [[ \"$(dpkg-query --show --showformat='${Status}' \"$package\")\" == 'install ok installed' ]]\n          done\n";
// [current, previous]: the PATH-resolved CMake with its 3.28 floor and the
// explicit LLD check, against the former unconditional Ubuntu cmake package.
export const PATH_RESOLVED_CMAKE = [
  `          sudo -n env DEBIAN_FRONTEND=noninteractive ${apt} install --yes --no-install-recommends x11-utils sqlite3 postgresql-client build-essential pkg-config libssl-dev clang lld libcap-dev protobuf-compiler\n`
    + "          for package in x11-utils sqlite3 postgresql-client build-essential pkg-config libssl-dev clang lld libcap-dev protobuf-compiler; do\n"
    + packageCheck
    + "          # Hosted images put a newer CMake first on PATH; only hosts without one fetch Ubuntu's.\n"
    + "          if ! command -v cmake >/dev/null; then\n"
    + `            sudo -n env DEBIAN_FRONTEND=noninteractive ${apt} install --yes --no-install-recommends cmake\n`
    + "            [[ \"$(dpkg-query --show --showformat='${Status}' cmake)\" == 'install ok installed' ]]\n"
    + "          fi\n"
    + "          IFS=. read -r cmake_major cmake_minor _ < <(cmake --version | sed -n '1s/^cmake version //p')\n"
    + "          (( cmake_major > 3 || (cmake_major == 3 && cmake_minor >= 28) ))\n"
    + "          command -v cmake\n"
    + "          ld.lld --version\n"
    + "          pkg-config --exists libcap openssl\n",
  `          sudo -n env DEBIAN_FRONTEND=noninteractive ${apt} install --yes --no-install-recommends x11-utils sqlite3 postgresql-client build-essential pkg-config libssl-dev clang lld cmake libcap-dev protobuf-compiler\n`
    + "          for package in x11-utils sqlite3 postgresql-client build-essential pkg-config libssl-dev clang lld cmake libcap-dev protobuf-compiler; do\n"
    + packageCheck
    + "          pkg-config --exists libcap openssl\n",
];

// Test-only inverse for the PATH-resolved CMake in both Shared prerequisite steps.
export function withoutPathResolvedCmake(file, source) {
  if (file !== "browser-e2e.yml") return source;
  const [now, before] = PATH_RESOLVED_CMAKE;
  assert.equal(count(source, now), 2, "both Shared prerequisite steps must resolve CMake from PATH with the reviewed floor");
  source = source.replaceAll(now, before);
  assert.equal(count(source, "cmake"), 4, "CMake appears only in the two former package lists and checks");
  assert.equal(count(source, "ld.lld"), 0);
  return source;
}

// Test-only inverse for the two prerequisite budget increases. Use only when
// reconstructing historical whole-workflow hashes; current workflow contracts
// inspect the actual budgets, commands and job placement without normalization.
// The later hosted Chromium split and PATH-resolved CMake are reversed first, exactly.
export function withoutSharedPrerequisiteTimeout(file, source) {
  if (file !== "browser-e2e.yml") return source;
  source = withoutPathResolvedCmake(file, withoutHostedChromiumInstall(file, source));
  assert.equal(source.split(step).length - 1, 2, "exactly two Shared prerequisite steps must remain");
  assert.equal(source.split(current).length - 1, 2, "both Shared prerequisite steps must have the reviewed 10-minute budget");
  return source.replaceAll(current, previous);
}
