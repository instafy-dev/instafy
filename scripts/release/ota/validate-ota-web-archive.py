#!/usr/bin/env python3
"""Read-only structural gate for a signed, first-party web-layer ZIP.

This does not establish store-policy eligibility or native compatibility; those
are independent release-authority gates. Never extract untrusted archive paths.
"""
import argparse
import pathlib
import stat
import zipfile

WEB_SUFFIXES = {
    ".html", ".js", ".mjs", ".css", ".json", ".svg", ".png", ".jpg",
    ".jpeg", ".gif", ".webp", ".avif", ".ico", ".woff", ".woff2",
    ".ttf", ".otf", ".mp3", ".wav", ".ogg", ".mp4", ".webm",
    ".wasm", ".txt", ".xml", ".webmanifest",
}
MAX_BYTES = 512 * 1024 * 1024
MAX_FILES = 20000
NATIVE_DIRECTORIES = {".app", ".framework", ".appex", ".bundle", ".xcarchive"}
NATIVE_PREFIXES = (
    b"\x7fELF", b"MZ", b"dex\n", b"dey\n", b"PK\x03\x04",
    b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe",
    b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",
    b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca", b"!<arch>\n",
)


def validate(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise ValueError("invalid OTA archive file")
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if not entries or len(entries) > MAX_FILES:
            raise ValueError("invalid OTA archive entry count")
        names = set()
        total = 0
        index = False
        for entry in entries:
            name = entry.filename
            parts = name.rstrip("/").split("/")
            if (name != entry.orig_filename or not name or len(name) > 512 or name.startswith("/") or
                    any(ord(char) < 32 or ord(char) == 127 for char in name) or
                    "\\" in name or ":" in name or
                    any(part in ("", ".", "..") for part in parts)):
                raise ValueError("unsafe OTA archive path")
            canonical = name.rstrip("/").casefold()
            if canonical in names:
                raise ValueError("duplicate OTA archive path")
            names.add(canonical)
            if any(part.startswith(".") or
                   pathlib.PurePosixPath(part).suffix.lower() in NATIVE_DIRECTORIES
                   for part in parts):
                raise ValueError("hidden or native OTA archive path")
            mode = entry.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError("non-regular OTA archive entry")
            if entry.flag_bits & 1:
                raise ValueError("encrypted OTA archive entry")
            if entry.is_dir():
                if kind not in (0, stat.S_IFDIR) or entry.file_size:
                    raise ValueError("malformed OTA archive directory")
                continue
            if kind == stat.S_IFDIR or mode & 0o111:
                raise ValueError("executable OTA archive entry")
            suffix = pathlib.PurePosixPath(name).suffix.lower()
            # The public Vite output includes this exact root static-host metadata
            # file. Do not allow arbitrary extensionless or nested lookalikes.
            if suffix not in WEB_SUFFIXES and name != "_headers":
                raise ValueError("non-web OTA archive entry")
            total += entry.file_size
            if total > MAX_BYTES:
                raise ValueError("OTA expanded archive is too large")
            with archive.open(entry) as contents:
                prefix = contents.read(8)
                if any(prefix.startswith(magic) for magic in NATIVE_PREFIXES):
                    raise ValueError("native or nested archive bytes in OTA payload")
                # Read through EOF to check CRC, without retaining full files.
                while contents.read(1024 * 1024):
                    pass
            index |= name == "index.html" and entry.file_size > 0
        if not index:
            raise ValueError("OTA archive must contain root index.html")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=pathlib.Path)
    args = parser.parse_args()
    try:
        validate(args.archive)
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError, NotImplementedError):
        # Do not echo archive-controlled names or payload bytes into CI logs.
        parser.exit(1, "OTA web archive validation failed\n")
    print("OTA web archive structure verified")
