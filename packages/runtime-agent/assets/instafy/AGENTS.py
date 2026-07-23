#!/usr/bin/env python3

from __future__ import annotations

import os
import sys
from pathlib import Path


def _read_text(path: Path, max_bytes: int) -> tuple[str, bool]:
    data = path.read_bytes()
    truncated = False
    if len(data) > max_bytes:
        data = data[:max_bytes]
        truncated = True
    return data.decode("utf-8", errors="replace"), truncated


def _print_section_header(title: str) -> None:
    sys.stdout.write("\n")
    sys.stdout.write(title)
    sys.stdout.write("\n")
    sys.stdout.write("-" * len(title))
    sys.stdout.write("\n")


def main() -> int:
    root = Path(os.environ.get("INSTAFY_CONTEXT_ROOT", os.getcwd())).resolve()
    max_total = int(os.environ.get("INSTAFY_CONTEXT_MAX_BYTES", "50000"))
    max_file = int(os.environ.get("INSTAFY_CONTEXT_MAX_FILE_BYTES", "12000"))

    remaining = max_total

    sys.stdout.write(f"Instafy workspace context (root={root})\n")
    sys.stdout.write(f"Budget: total={max_total} bytes, per-file={max_file} bytes\n")

    instafy_path = root / "INSTAFY.md"
    skills_dir = root / ".agents" / "skills"
    learnings_dir = root / "learnings"

    _print_section_header("INSTAFY.md")
    if instafy_path.exists():
        limit = min(max_file, remaining)
        text, truncated = _read_text(instafy_path, limit)
        remaining -= min(len(text.encode("utf-8")), remaining)
        sys.stdout.write(text.rstrip())
        if truncated:
            sys.stdout.write("\n\n[truncated]\n")
    else:
        sys.stdout.write("(missing)\n")

    _print_section_header("Skills (.agents/skills/*/SKILL.md)")
    if skills_dir.exists() and skills_dir.is_dir():
        skill_files: list[Path] = []
        for entry in skills_dir.iterdir():
            if not entry.is_dir():
                continue
            skill_md = entry / "SKILL.md"
            if skill_md.is_file():
                skill_files.append(skill_md)
        skill_files.sort(key=lambda p: p.parent.name)

        if not skill_files:
            sys.stdout.write("(none)\n")
        for file_path in skill_files:
            if remaining <= 0:
                sys.stdout.write("\n[budget exhausted]\n")
                break
            sys.stdout.write(f"\n## {file_path.relative_to(root)}\n")
            limit = min(max_file, remaining)
            text, truncated = _read_text(file_path, limit)
            remaining -= min(len(text.encode("utf-8")), remaining)
            sys.stdout.write(text.rstrip())
            if truncated:
                sys.stdout.write("\n\n[truncated]\n")
    else:
        sys.stdout.write("(missing)\n")

    _print_section_header("Legacy learnings index (learnings/*)")
    if learnings_dir.exists() and learnings_dir.is_dir():
        learning_files: list[Path] = []
        for entry in learnings_dir.iterdir():
            if entry.name == "_pinned":
                continue
            if entry.is_file():
                learning_files.append(entry)
        learning_files.sort(key=lambda p: p.name)
        if not learning_files:
            sys.stdout.write("(none)\n")
        else:
            for file_path in learning_files:
                size = file_path.stat().st_size
                sys.stdout.write(f"- {file_path.relative_to(root)} ({size} bytes)\n")
    else:
        sys.stdout.write("(missing)\n")

    sys.stdout.write(f"\nRemaining budget: {max(0, remaining)} bytes\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
