// The skill packs bundled beside the packaged runtime-agent (`<runtime-agent dir>/skill-packs`), each
// described by its manifest and checked against its content: tree_sha256 is the sha256 over every file
// except `.instafy-pack.json`, in byte order of the "/"-separated path, each fed as path, NUL, bytes,
// NUL (the same digest scripts/install-skill-packs.mjs checks against the pin).
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PACK_MANIFEST = ".instafy-pack.json";

function packTreeDigest(dir) {
  const files = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Skill pack ${dir} holds a link: ${child}`);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        if (child !== PACK_MANIFEST) files.push(child);
      } else throw new Error(`Skill pack ${dir} holds a special file: ${child}`);
    }
  };
  walk("");
  files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel).update("\0").update(fs.readFileSync(path.join(dir, rel))).update("\0");
  }
  return hash.digest("hex");
}

/// [{name, version, tree_sha256}] for every pack in `root`, by name. Throws when a pack's content
/// does not match its manifest. A missing `root` holds no packs.
function describeSkillPacks(root) {
  if (!fs.existsSync(root)) return [];
  const packs = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    const manifestPath = path.join(dir, PACK_MANIFEST);
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.name !== entry.name) {
      throw new Error(`Skill pack ${dir} names ${JSON.stringify(manifest.name)} in its manifest`);
    }
    const tree = packTreeDigest(dir);
    if (tree !== manifest.tree_sha256) {
      throw new Error(`Skill pack ${entry.name} content ${tree} does not match its manifest ${manifest.tree_sha256}`);
    }
    packs.push({ name: manifest.name, version: manifest.version, tree_sha256: tree });
  }
  return packs.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { describeSkillPacks, packTreeDigest };
