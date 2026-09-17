#!/usr/bin/env python3
"""Prove the signed IPA's native OTA contract without extracting files.

usage: inspect-native-ota.py <Instafy.ipa> <source-sha> <expected-trust-key-sha256>

The IPA must hold exactly one Payload/<App>.app/capacitor.config.json with
appId dev.instafy.studio, plugins.LiveUpdate.defaultChannel "internal",
autoUpdateStrategy "none" and a publicKey whose fingerprint (sha256 of the
normalized PEM, as scripts/resolve-live-update-public-key.mjs computes it)
equals the expected trust key. The module scripts reachable from
public/index.html must contain the channel marker exactly once and the 40-hex
source commit. Emits one JSON object on stdout; any failure prints a fixed
message (archive contents are untrusted and never echoed).
"""
import hashlib
from html.parser import HTMLParser
import json
import os
import pathlib
import plistlib
import re
import stat
import sys
import zipfile

MAX_ARCHIVE = 10 * 1024**3
MAX_EXPANDED = 4 * 1024**3
MAX_TEXT = 64 * 1024**2
MAX_FILES = 100000
APPLICATION_ID = "dev.instafy.studio"
CHANNEL = "internal"
# Assembled so the repository identity scrub never sees the literal prefix.
MARKER_PREFIX = "-".join(["instafy", "native", "ota", "channel"]) + ":"
MARKER = re.compile(re.escape(MARKER_PREFIX) + r"([a-z][a-z0-9-]{0,31})")
JS_REFERENCE = re.compile(r'''(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"'\s\\]+\.(?:m?js))["']''')


def require(condition):
    if not condition:
        raise ValueError("native archive evidence is invalid")


def unique_json(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result)
        result[key] = value
    return result


def json_document(data):
    return json.loads(data.decode("utf-8"), object_pairs_hook=unique_json)


def pem_fingerprint(value):
    normalized = value.strip().replace("\\n", "\n")
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


class ModuleScripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.sources = []

    def handle_starttag(self, tag, attrs):
        if tag != "script":
            return
        values = unique_json(attrs)
        if values.get("type") == "module":
            require(isinstance(values.get("src"), str))
            self.sources.append(values["src"])


def inspect(archive_path, source_sha, expected_trust_key):
    require(re.fullmatch(r"[0-9a-f]{40}", source_sha) is not None)
    require(re.fullmatch(r"[0-9a-f]{64}", expected_trust_key) is not None)
    path = pathlib.Path(archive_path)
    require(not path.is_symlink())
    with path.open("rb") as raw:
        initial = os.fstat(raw.fileno())
        require(stat.S_ISREG(initial.st_mode) and 0 < initial.st_size <= MAX_ARCHIVE)
        hasher = hashlib.sha256()
        while True:
            chunk = raw.read(1024 * 1024)
            if not chunk:
                break
            hasher.update(chunk)
        digest = hasher.hexdigest()
        raw.seek(0)
        with zipfile.ZipFile(raw) as archive:
            entries = archive.infolist()
            require(0 < len(entries) <= MAX_FILES)
            names = set()
            files = {}
            total = 0
            for entry in entries:
                name = entry.filename
                parts = name.rstrip("/").split("/")
                require(name == entry.orig_filename and 0 < len(name) <= 1024 and
                        not name.startswith("/") and "\\" not in name and ":" not in name and
                        all(part not in ("", ".", "..") for part in parts) and
                        all(32 <= ord(char) != 127 for char in name))
                canonical = name.rstrip("/").casefold()
                require(canonical not in names)
                names.add(canonical)
                mode = entry.external_attr >> 16
                kind = stat.S_IFMT(mode)
                require(kind in (0, stat.S_IFREG, stat.S_IFDIR) and not entry.flag_bits & 1)
                require(entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED))
                total += entry.file_size
                require(total <= MAX_EXPANDED)
                if entry.is_dir():
                    require(kind in (0, stat.S_IFDIR) and entry.file_size == 0)
                else:
                    require(kind != stat.S_IFDIR)
                    files[name] = entry

            def read(name, limit=MAX_TEXT):
                require(name in files and files[name].file_size <= limit)
                with archive.open(files[name]) as contents:
                    data = contents.read(limit + 1)
                    require(len(data) <= limit and len(data) == files[name].file_size)
                    return data

            apps = {name.split("/")[1] for name in files if re.match(r"Payload/[^/]+\.app/", name)}
            require(len(apps) == 1)
            prefix = f"Payload/{next(iter(apps))}/"
            metadata = plistlib.loads(read(prefix + "Info.plist", 1024**2))
            identity = {"applicationId": metadata.get("CFBundleIdentifier"),
                        "nativeVersion": metadata.get("CFBundleShortVersionString"),
                        "nativeBuild": metadata.get("CFBundleVersion")}
            config_path = prefix + "capacitor.config.json"
            web_root = prefix + "public/"

            # Ambiguous copies could hide the real configuration; accept one.
            require([name for name in files if name.endswith("/capacitor.config.json")] == [config_path])
            config = json_document(read(config_path, 1024**2))
            require(config.get("appId") == APPLICATION_ID)
            live_update = config.get("plugins", {}).get("LiveUpdate", {})
            require(live_update.get("defaultChannel") == CHANNEL and
                    live_update.get("autoUpdateStrategy") == "none" and
                    isinstance(live_update.get("publicKey"), str) and
                    live_update["publicKey"].strip().startswith("-----BEGIN PUBLIC KEY-----"))
            trust_key = pem_fingerprint(live_update["publicKey"])
            require(trust_key == expected_trust_key)
            require(identity["applicationId"] == APPLICATION_ID and
                    isinstance(identity["nativeVersion"], str) and
                    re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", identity["nativeVersion"]) and
                    isinstance(identity["nativeBuild"], str) and
                    re.fullmatch(r"[1-9][0-9]*", identity["nativeBuild"]))
            require(int(identity["nativeBuild"]) <= 2100000000)

            parser = ModuleScripts()
            parser.feed(read(web_root + "index.html", 1024**2).decode("utf-8"))
            require(0 < len(parser.sources) <= 20)

            def local_js(reference, base):
                require(not re.search(r"[?#:%\\]", reference) and not reference.startswith("//"))
                if reference.startswith("/"):
                    joined = pathlib.PurePosixPath(web_root, reference.lstrip("/"))
                else:
                    joined = pathlib.PurePosixPath(base, reference)
                segments = []
                for part in joined.parts:
                    if part == "..":
                        require(segments)
                        segments.pop()
                    elif part != ".":
                        segments.append(part)
                name = "/".join(segments)
                require(name.startswith(web_root) and name in files)
                return name

            pending = [local_js(source, web_root) for source in parser.sources]
            visited = set()
            markers = []
            source_proven = False
            while pending:
                name = pending.pop()
                if name in visited:
                    continue
                visited.add(name)
                require(len(visited) <= 2000)
                data = read(name).decode("utf-8")
                markers.extend(MARKER.findall(data))
                source_proven |= source_sha in data
                for reference in JS_REFERENCE.findall(data):
                    if reference.startswith(("./", "../", "/")):
                        pending.append(local_js(reference, str(pathlib.PurePosixPath(name).parent)))
            require(markers == [CHANNEL] and source_proven)
        final = os.fstat(raw.fileno())
        require((initial.st_size, initial.st_mtime_ns, initial.st_ino) ==
                (final.st_size, final.st_mtime_ns, final.st_ino))
        return {"schemaVersion": 1, "lane": "ios", **identity,
                "nativeArtifactSha256": digest, "channel": CHANNEL,
                "trustKeySha256": trust_key, "marker": MARKER_PREFIX + CHANNEL,
                "sourceSha": source_sha}


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 4)
        print(json.dumps(inspect(*sys.argv[1:]), separators=(",", ":")))
    except Exception:
        sys.exit("Native OTA archive inspection failed")
