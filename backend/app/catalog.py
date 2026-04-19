"""Skills & Agents catalog CRUD over <workspace>/{skills,agents}/*.md."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Literal

import yaml

from .config import settings

Kind = Literal["skills", "agents"]


def _dir(kind: Kind) -> Path:
    d = Path(settings.workspace_dir).expanduser() / kind
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe_name(name: str) -> str:
    """Prevent path traversal + accidental extensions."""
    if not re.fullmatch(r"[a-zA-Z0-9_\-]+", name):
        raise ValueError(f"Invalid name '{name}': use [a-zA-Z0-9_-]")
    return name


def _parse_md(text: str) -> tuple[dict, str]:
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)", text, re.DOTALL)
    if not m:
        return {}, text
    fm = yaml.safe_load(m.group(1)) or {}
    return fm, m.group(2)


def list_items(kind: Kind) -> list[dict]:
    out = []
    for md in sorted(_dir(kind).glob("*.md")):
        try:
            fm, _body = _parse_md(md.read_text(encoding="utf-8"))
        except Exception:
            fm = {}
        out.append({
            "name": md.stem,
            "title": fm.get("name", md.stem),
            "description": fm.get("description", ""),
            "size": md.stat().st_size,
            "updated_at": md.stat().st_mtime,
        })
    return out


def read_item(kind: Kind, name: str) -> dict:
    name = _safe_name(name)
    path = _dir(kind) / f"{name}.md"
    if not path.exists():
        raise FileNotFoundError(f"{kind}/{name}.md not found")
    text = path.read_text(encoding="utf-8")
    fm, body = _parse_md(text)
    return {
        "name": name,
        "frontmatter": fm,
        "body": body,
        "raw": text,
        "updated_at": path.stat().st_mtime,
    }


def write_item(kind: Kind, name: str, content: str) -> dict:
    name = _safe_name(name)
    path = _dir(kind) / f"{name}.md"
    path.write_text(content, encoding="utf-8")
    return {"name": name, "kind": kind, "bytes": len(content.encode("utf-8"))}


def delete_item(kind: Kind, name: str) -> dict:
    name = _safe_name(name)
    path = _dir(kind) / f"{name}.md"
    if not path.exists():
        raise FileNotFoundError(f"{kind}/{name}.md not found")
    path.unlink()
    return {"deleted": True, "name": name, "kind": kind}
