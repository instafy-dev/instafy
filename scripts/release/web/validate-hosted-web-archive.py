#!/usr/bin/env python3
"""Refuse a sealed hosted web archive unless every member is a plain file or
directory under dist/ with a safe relative path. Run before extraction."""

import sys
import tarfile
from pathlib import PurePosixPath


def validate(archive_path):
    files = 0
    with tarfile.open(archive_path, "r:gz") as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            if (
                path.is_absolute()
                or not path.parts
                or path.parts[0] != "dist"
                or ".." in path.parts
                or not (member.isfile() or member.isdir())
            ):
                raise SystemExit("The hosted web archive contains an unsafe member.")
            if member.isfile():
                files += 1
            if len(path.parts) == 2 and path.parts[1] in ("_worker.js", "functions"):
                raise SystemExit("The hosted web archive must not deploy Pages Functions or a worker.")
    if files < 2:
        raise SystemExit("The hosted web archive is unexpectedly empty.")
    return files


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: validate-hosted-web-archive.py <hosted-frontend.tar.gz>")
    print(f"[web-release] Archive members are safe ({validate(sys.argv[1])} files).")
