#!/usr/bin/env python3
"""Inspect a signed Android App Bundle without extracting it.

usage: inspect-aab.py <aab> <trust-key-sha256> <version-name> <version-code> <source-sha>

Proves, from the final bytes rather than from a sidecar:
  * zip hygiene: safe unique entry names, regular files, bounded sizes, a JAR
    signature block (META-INF/*.RSA|DSA|EC) and a base/ module;
  * no credential-bearing entries (auth.json, .env, .env.*) anywhere and no
    private markers under base/assets/ or base/root/capacitor.config.json;
  * base/manifest/AndroidManifest.xml (aapt2 protobuf, Resources.proto XmlNode)
    names dev.instafy.studio with exactly the committed versionName/versionCode;
  * base/assets/capacitor.config.json is the only Capacitor config, with appId
    dev.instafy.studio, LiveUpdate defaultChannel internal, autoUpdateStrategy
    none, and a canonical SPKI PEM publicKey whose sha256 equals the trust key
    fingerprint from scripts/release/android/trust-key.mjs (the same digest
    the OTA authority computes from its canonical SPKI export);
  * the web bundle carries exactly the internal OTA channel marker and the
    exact source commit.
Prints one JSON object: schemaVersion, applicationId, versionName, versionCode,
channel, trustKeySha256, nativeArtifactSha256, sourceSha. Failures print only a
fixed check label, never archive content.
"""
import hashlib
import json
import os
import pathlib
import re
import stat
import sys
import zipfile

APPLICATION_ID = "dev.instafy.studio"
CHANNEL = "internal"
MAX_ARCHIVE = 10 * 1024**3
MAX_EXPANDED = 4 * 1024**3
MAX_TEXT = 64 * 1024**2
MAX_FILES = 100000
ANDROID_NS = "http://schemas.android.com/apk/res/android"
# Character classes keep repository scanners from matching this source file.
OTA_MARKER = re.compile(r"instafy[-]native-ota-channel:([a-z][a-z0-9-]{0,31})")
PRIVATE_PRODUCT = re.compile(r"k[n]osh", re.IGNORECASE)
SIGNATURE_BLOCK = re.compile(r"META-INF/[^/]+\.(RSA|DSA|EC)")


class InspectionError(Exception):
    pass


def require(condition, label):
    if not condition:
        raise InspectionError(label)


def unique_json(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate-json-key")
        result[key] = value
    return result


def varint(data, offset):
    value = 0
    for shift in range(0, 70, 7):
        require(offset < len(data), "manifest-protobuf")
        byte = data[offset]
        offset += 1
        require(shift != 63 or byte <= 1, "manifest-protobuf")
        value |= (byte & 127) << shift
        if byte < 128:
            return value, offset
    raise InspectionError("manifest-protobuf")


def protobuf(data):
    result = {}
    offset = 0
    count = 0
    while offset < len(data):
        count += 1
        require(count <= 100000, "manifest-protobuf")
        tag, offset = varint(data, offset)
        field, wire = tag >> 3, tag & 7
        require(0 < field < 2**29, "manifest-protobuf")
        if wire == 0:
            value, offset = varint(data, offset)
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
            require(offset + size <= len(data), "manifest-protobuf")
            value = data[offset:offset + size]
            offset += size
        elif wire == 2:
            size, offset = varint(data, offset)
            require(size <= MAX_TEXT and offset + size <= len(data), "manifest-protobuf")
            value = data[offset:offset + size]
            offset += size
        else:
            raise InspectionError("manifest-protobuf")
        result.setdefault(field, []).append((wire, value))
    return result


def one(fields, number, wire=2, default=None):
    values = fields.get(number, [])
    require(len(values) <= 1, "manifest-protobuf")
    if not values:
        return default
    require(values[0][0] == wire, "manifest-protobuf")
    return values[0][1]


def text_field(fields, number, default=None):
    value = one(fields, number)
    return value.decode("utf-8") if value is not None else default


def compiled_value(data):
    item = protobuf(data)
    require(len(item) == 1, "manifest-compiled-value")
    if 2 in item or 3 in item:
        string = protobuf(one(item, 2 if 2 in item else 3))
        return text_field(string, 1, "")
    require(7 in item, "manifest-compiled-value")
    primitive = protobuf(one(item, 7))
    require(len(primitive) == 1 and (6 in primitive or 7 in primitive), "manifest-compiled-value")
    return str(one(primitive, 6 if 6 in primitive else 7, 0))


def android_identity(data):
    root = protobuf(data)
    require(2 not in root, "manifest-root")
    element = protobuf(one(root, 1))
    require(text_field(element, 3) == "manifest" and text_field(element, 2, "") == "", "manifest-root")
    attributes = {}
    identity_keys = {("", "package"), (ANDROID_NS, "versionName"), (ANDROID_NS, "versionCode")}
    for wire, encoded in element.get(4, []):
        require(wire == 2 and len(attributes) < 512, "manifest-attributes")
        attribute = protobuf(encoded)
        key = (text_field(attribute, 1, ""), text_field(attribute, 2))
        require(key not in attributes and key[1], "manifest-attributes")
        if key not in identity_keys:
            # versionCodeMajor would widen the store identity beyond the
            # positive 32-bit versionCode the tag encodes: fail closed.
            require(key != (ANDROID_NS, "versionCodeMajor"), "manifest-version-code-major")
            attributes[key] = None
            continue
        raw = text_field(attribute, 3)
        compiled = one(attribute, 6)
        resolved = compiled_value(compiled) if compiled is not None else raw
        require(raw in (None, "") or compiled is None or raw == resolved, "manifest-ambiguous-value")
        attributes[key] = resolved
    return {
        "applicationId": attributes.get(("", "package")),
        "versionName": attributes.get((ANDROID_NS, "versionName")),
        "versionCode": attributes.get((ANDROID_NS, "versionCode")),
    }


# Canonical SPKI PEM as Node's createPublicKey(...).export({type: "spki",
# format: "pem"}).toString().trim() prints it: LF only, 64-column base64.
CANONICAL_SPKI_PEM = re.compile(
    r"-----BEGIN PUBLIC KEY-----\n(?:[A-Za-z0-9+/=]{64}\n)*[A-Za-z0-9+/=]{1,64}\n-----END PUBLIC KEY-----"
)


def normalized_pem_sha256(value):
    trimmed = value.strip().replace("\\n", "\n")
    # The trust key fingerprint (scripts/release/android/trust-key.mjs) is the
    # sha256 of the canonical export; any other byte form of the same key would
    # attest a digest the OTA authority never compares against.
    require(CANONICAL_SPKI_PEM.fullmatch(trimmed) is not None, "live-update-public-key")
    return hashlib.sha256(trimmed.encode("utf-8")).hexdigest()


def inspect(archive_path, trust_key_sha256, version_name, version_code, source_sha):
    require(re.fullmatch(r"[0-9a-f]{64}", trust_key_sha256) is not None, "arguments")
    require(re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z._-]{0,63}", version_name) is not None, "arguments")
    require(re.fullmatch(r"[1-9][0-9]{0,9}", version_code) is not None, "arguments")
    require(re.fullmatch(r"[0-9a-f]{40}", source_sha) is not None, "arguments")
    path = pathlib.Path(archive_path)
    require(not path.is_symlink(), "archive-file")
    with path.open("rb") as raw:
        initial = os.fstat(raw.fileno())
        require(stat.S_ISREG(initial.st_mode) and 0 < initial.st_size <= MAX_ARCHIVE, "archive-file")
        hasher = hashlib.sha256()
        for chunk in iter(lambda: raw.read(1024 * 1024), b""):
            hasher.update(chunk)
        digest = hasher.hexdigest()
        raw.seek(0)
        with zipfile.ZipFile(raw) as archive:
            entries = archive.infolist()
            require(0 < len(entries) <= MAX_FILES, "zip-entries")
            names = set()
            files = {}
            total = 0
            for entry in entries:
                name = entry.filename
                parts = name.rstrip("/").split("/")
                require(
                    name == entry.orig_filename and 0 < len(name) <= 1024 and
                    not name.startswith("/") and "\\" not in name and ":" not in name and
                    all(part not in ("", ".", "..") for part in parts) and
                    all(32 <= ord(char) != 127 for char in name),
                    "zip-entry-name",
                )
                canonical = name.rstrip("/").casefold()
                require(canonical not in names, "zip-entry-duplicate")
                names.add(canonical)
                kind = stat.S_IFMT(entry.external_attr >> 16)
                require(kind in (0, stat.S_IFREG, stat.S_IFDIR) and not entry.flag_bits & 1, "zip-entry-type")
                require(entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "zip-entry-compression")
                total += entry.file_size
                require(total <= MAX_EXPANDED, "zip-expanded-size")
                if entry.is_dir():
                    require(kind in (0, stat.S_IFDIR) and entry.file_size == 0, "zip-entry-type")
                else:
                    require(kind != stat.S_IFDIR, "zip-entry-type")
                    files[name] = entry

            def read(name, limit=MAX_TEXT):
                require(name in files and files[name].file_size <= limit, "missing-entry")
                with archive.open(files[name]) as contents:
                    data = contents.read(limit + 1)
                    require(len(data) <= limit and len(data) == files[name].file_size, "entry-size")
                    return data

            require(any(SIGNATURE_BLOCK.fullmatch(name) for name in files), "unsigned-bundle")
            require(any(name.startswith("base/") for name in files), "missing-base-module")
            for name in files:
                leaf = name.rsplit("/", 1)[-1].lower()
                require(leaf != "auth.json" and leaf != ".env" and not leaf.startswith(".env."), "credential-file")
                # Only entries this repository produces: merged third-party
                # resources legitimately contain paths such as
                # base/root/kotlin/internal/internal.kotlin_builtins.
                if not (name.startswith("base/assets/") or name == "base/root/capacitor.config.json"):
                    continue
                require(
                    "/internal/" not in "/" + name and not PRIVATE_PRODUCT.search(leaf) and
                    ".private-deps" not in name and "composition-lock" not in leaf,
                    "private-marker",
                )

            identity = android_identity(read("base/manifest/AndroidManifest.xml", 4 * 1024**2))
            require(identity["applicationId"] == APPLICATION_ID, "manifest-package")
            require(identity["versionName"] == version_name, "manifest-version-name")
            require(identity["versionCode"] == version_code, "manifest-version-code")

            config_path = "base/assets/capacitor.config.json"
            require([name for name in files if name.endswith("/capacitor.config.json")] == [config_path],
                    "capacitor-config-ambiguous")
            config = json.loads(read(config_path, 1024**2).decode("utf-8"), object_pairs_hook=unique_json)
            require(isinstance(config, dict) and config.get("appId") == APPLICATION_ID, "capacitor-app-id")
            plugins = config.get("plugins")
            live_update = plugins.get("LiveUpdate") if isinstance(plugins, dict) else None
            require(isinstance(live_update, dict), "live-update-config")
            require(live_update.get("defaultChannel") == CHANNEL, "live-update-channel")
            require(live_update.get("autoUpdateStrategy") == "none", "live-update-strategy")
            public_key = live_update.get("publicKey")
            require(isinstance(public_key, str), "live-update-public-key")
            require(normalized_pem_sha256(public_key) == trust_key_sha256, "live-update-trust-key")

            web_root = "base/assets/public/"
            require(web_root + "index.html" in files, "web-index")
            markers = set()
            source_proven = False
            scripts = [name for name in files if name.startswith(web_root) and name.endswith((".js", ".mjs"))]
            require(0 < len(scripts) <= 5000, "web-scripts")
            for name in scripts:
                text = read(name).decode("utf-8", errors="replace")
                markers.update(OTA_MARKER.findall(text))
                source_proven = source_proven or source_sha in text
            require(markers == {CHANNEL}, "web-ota-channel-marker")
            require(source_proven, "web-source-commit")
        final = os.fstat(raw.fileno())
        require((initial.st_size, initial.st_mtime_ns, initial.st_ino) ==
                (final.st_size, final.st_mtime_ns, final.st_ino), "archive-changed")
    return {
        "schemaVersion": 1,
        "applicationId": APPLICATION_ID,
        "versionName": version_name,
        "versionCode": version_code,
        "channel": CHANNEL,
        "trustKeySha256": trust_key_sha256,
        "nativeArtifactSha256": digest,
        "sourceSha": source_sha,
    }


def main(argv):
    try:
        require(len(argv) == 6, "arguments")
        result = inspect(*argv[1:])
    except InspectionError as error:
        sys.stderr.write("::error::Android bundle inspection failed: %s\n" % error.args[0])
        return 1
    except Exception:
        # Archive names, config and parser errors are untrusted; say nothing.
        sys.stderr.write("::error::Android bundle inspection failed: unreadable-archive\n")
        return 1
    sys.stdout.write(json.dumps(result, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
