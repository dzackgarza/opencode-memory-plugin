#!/usr/bin/env python3
"""opencode-file-memory: YAML-headered markdown memory store for OpenCode agents.

Commands:
  remember  Save a memory to the file store
  recall    Search memories semantically (via semtools)
  list      List/filter memories by scope, session, or tag
  forget    Delete a memory by ID
"""
from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Optional

import typer
import yaml

app = typer.Typer(no_args_is_help=True, add_completion=False)

BUG_REPORTING_URL = "https://github.com/dzackgarza/opencode-postgres-memory-plugin/issues/new?labels=bug"

# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------


def default_memory_root(project: str) -> Path:
    xdg_data = os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share"))
    return Path(xdg_data) / "opencode-memory" / project


def resolve_memory_root(project: str, memory_root_override: Optional[str] = None) -> Path:
    if memory_root_override:
        return Path(memory_root_override)
    env_root = os.environ.get("OPENCODE_MEMORY_ROOT")
    if env_root:
        return Path(env_root)
    return default_memory_root(project)


def scope_dir(root: Path, scope: str, session_id: Optional[str]) -> Path:
    if scope == "global":
        return root / "global"
    if scope == "session":
        if not session_id:
            raise ValueError("session_id is required when scope='session'")
        return root / "sessions" / session_id
    raise ValueError(f"Unknown scope: {scope!r}. Must be 'global' or 'session'.")


# ---------------------------------------------------------------------------
# File helpers
# ---------------------------------------------------------------------------


def gen_id() -> str:
    return "mem_" + secrets.token_urlsafe(8)


def make_filename(memory_id: str) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{memory_id}-{ts}.md"


def write_memory_file(path: Path, frontmatter: dict, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    yaml_text = yaml.dump(
        frontmatter, default_flow_style=False, allow_unicode=True, sort_keys=True
    )
    body = f"---\n{yaml_text}---\n{content}\n"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(body, encoding="utf-8")
    tmp.replace(path)  # atomic on same filesystem (POSIX rename)


def parse_memory_file(path: Path) -> Optional[dict]:
    try:
        text = path.read_text(encoding="utf-8")
    except (IOError, OSError):
        return None
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---\n", 4)
    if end == -1:
        return None
    frontmatter_text = text[4:end]
    content = text[end + 5:]
    try:
        fm = yaml.safe_load(frontmatter_text)
    except yaml.YAMLError:
        return None
    if not isinstance(fm, dict):
        return None
    return {**fm, "content": content.strip(), "path": str(path)}


def all_memory_files(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return [p for p in root.rglob("*.md") if not p.name.startswith(".")]


def scoped_memory_files(
    root: Path,
    scope: Optional[str],
    session_id: Optional[str],
) -> list[Path]:
    if scope == "global":
        d = root / "global"
        if not d.exists():
            return []
        return list(d.glob("*.md"))
    if scope == "session" and session_id:
        d = root / "sessions" / session_id
        if not d.exists():
            return []
        return list(d.glob("*.md"))
    if scope == "session":
        d = root / "sessions"
        if not d.exists():
            return []
        return [p for p in d.rglob("*.md") if not p.name.startswith(".")]
    return all_memory_files(root)


# ---------------------------------------------------------------------------
# Semtools integration
# ---------------------------------------------------------------------------


def run_semtools_search(query: str, files: list[str], top_k: int) -> list[dict]:
    """Run semtools search, trying direct binary first then npx fallback."""
    for cmd_prefix in (
        ["semtools"],
        ["npx", "--yes", "--package=@llamaindex/semtools", "semtools"],
    ):
        try:
            result = subprocess.run(
                [*cmd_prefix, "search", "--json", "--top-k", str(top_k), query, *files],
                capture_output=True,
                text=True,
                timeout=120,
            )
        except FileNotFoundError:
            continue
        if result.returncode != 0:
            stderr = result.stderr.strip()
            raise RuntimeError(
                f"semtools exited {result.returncode}: {stderr or '(no stderr)'}"
            )
        try:
            return json.loads(result.stdout).get("results", [])
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"semtools returned non-JSON: {result.stdout[:200]}") from exc

    raise RuntimeError(
        "semtools not found. Install with: cargo install semtools  or  npm install -g @llamaindex/semtools"
    )


# ---------------------------------------------------------------------------
# Output helper
# ---------------------------------------------------------------------------


def emit(payload: dict) -> None:
    print(json.dumps(payload, default=str))


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


@app.command()
def remember(
    content: Annotated[str, typer.Option("--content", help="Memory content (markdown)")],
    project: Annotated[str, typer.Option("--project", help="Project identifier")],
    scope: Annotated[str, typer.Option("--scope", help="'session' or 'global'")] = "session",
    session_id: Annotated[
        Optional[str],
        typer.Option("--session-id", help="Session ID (required for session scope)"),
    ] = None,
    tag: Annotated[
        Optional[list[str]],
        typer.Option("--tag", help="Tag (repeatable: --tag foo --tag bar)"),
    ] = None,
    metadata: Annotated[
        Optional[str],
        typer.Option("--metadata", help="JSON object for arbitrary key-value metadata"),
    ] = None,
    memory_root: Annotated[
        Optional[str],
        typer.Option("--memory-root", help="Override the memory root directory"),
    ] = None,
) -> None:
    """Write a new memory to the file store."""
    try:
        root = resolve_memory_root(project, memory_root)
        sdir = scope_dir(root, scope, session_id)
    except ValueError as exc:
        emit({"ok": False, "stage": "configuration", "message": str(exc)})
        raise typer.Exit(1)

    meta: dict = {}
    if metadata:
        try:
            meta = json.loads(metadata)
        except json.JSONDecodeError as exc:
            emit({"ok": False, "stage": "configuration", "message": f"Invalid --metadata JSON: {exc}"})
            raise typer.Exit(1)

    memory_id = gen_id()
    path = sdir / make_filename(memory_id)
    now = datetime.now(timezone.utc).isoformat()

    frontmatter = {
        "created_at": now,
        "id": memory_id,
        "metadata": meta,
        "project": project,
        "scope": scope,
        "session_id": session_id,
        "tags": tag or [],
        "updated_at": now,
    }

    try:
        write_memory_file(path, frontmatter, content)
    except OSError as exc:
        emit({"ok": False, "stage": "write_file", "message": str(exc), "path": str(path)})
        raise typer.Exit(1)

    emit({"ok": True, "kind": "remember", "id": memory_id, "path": str(path), "scope": scope, "project": project})


@app.command()
def recall(
    query: Annotated[str, typer.Argument(help="Search query")],
    project: Annotated[str, typer.Option("--project", help="Project identifier")],
    scope: Annotated[
        Optional[str],
        typer.Option("--scope", help="Restrict to 'session' or 'global'"),
    ] = None,
    session_id: Annotated[
        Optional[str],
        typer.Option("--session-id", help="Session ID (used when scope='session')"),
    ] = None,
    limit: Annotated[int, typer.Option("--limit", help="Maximum number of results")] = 5,
    memory_root: Annotated[
        Optional[str],
        typer.Option("--memory-root", help="Override the memory root directory"),
    ] = None,
) -> None:
    """Search memories semantically using semtools."""
    try:
        root = resolve_memory_root(project, memory_root)
    except ValueError as exc:
        emit({"ok": False, "stage": "configuration", "message": str(exc)})
        raise typer.Exit(1)

    files = scoped_memory_files(root, scope, session_id)
    if not files:
        emit({"ok": True, "kind": "recall", "results": [], "count": 0})
        return

    file_strs = [str(f) for f in files]

    try:
        hits = run_semtools_search(query, file_strs, top_k=limit * 3)
    except RuntimeError as exc:
        emit({"ok": False, "stage": "semtools", "message": str(exc)})
        raise typer.Exit(1)

    # Deduplicate hits by filename, keeping minimum distance per file
    best_distance: dict[str, float] = {}
    for hit in hits:
        fname = hit["filename"]
        dist = float(hit["distance"])
        if fname not in best_distance or dist < best_distance[fname]:
            best_distance[fname] = dist

    ranked = sorted(best_distance.items(), key=lambda kv: kv[1])[:limit]

    results = []
    for fname, distance in ranked:
        memory = parse_memory_file(Path(fname))
        if memory:
            results.append({**memory, "distance": distance})

    emit({"ok": True, "kind": "recall", "results": results, "count": len(results)})


@app.command(name="list")
def list_memories(
    project: Annotated[str, typer.Option("--project", help="Project identifier")],
    scope: Annotated[
        Optional[str],
        typer.Option("--scope", help="Filter to 'session' or 'global'"),
    ] = None,
    session_id: Annotated[
        Optional[str],
        typer.Option("--session-id", help="Session ID"),
    ] = None,
    tag: Annotated[
        Optional[str],
        typer.Option("--tag", help="Filter by tag"),
    ] = None,
    limit: Annotated[int, typer.Option("--limit", help="Maximum results")] = 50,
    memory_root: Annotated[
        Optional[str],
        typer.Option("--memory-root", help="Override the memory root directory"),
    ] = None,
) -> None:
    """List memories with optional scope and tag filters."""
    try:
        root = resolve_memory_root(project, memory_root)
    except ValueError as exc:
        emit({"ok": False, "stage": "configuration", "message": str(exc)})
        raise typer.Exit(1)

    files = scoped_memory_files(root, scope, session_id)
    results = []
    for path in sorted(files, key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True):
        memory = parse_memory_file(path)
        if memory is None:
            continue
        if tag and tag not in (memory.get("tags") or []):
            continue
        results.append(memory)
        if len(results) >= limit:
            break

    emit({"ok": True, "kind": "list", "results": results, "count": len(results)})


@app.command()
def forget(
    memory_id: Annotated[str, typer.Option("--id", help="Memory ID to delete (mem_xxx)")],
    project: Annotated[str, typer.Option("--project", help="Project identifier")],
    memory_root: Annotated[
        Optional[str],
        typer.Option("--memory-root", help="Override the memory root directory"),
    ] = None,
) -> None:
    """Delete a memory by ID."""
    try:
        root = resolve_memory_root(project, memory_root)
    except ValueError as exc:
        emit({"ok": False, "stage": "configuration", "message": str(exc)})
        raise typer.Exit(1)

    for path in all_memory_files(root):
        memory = parse_memory_file(path)
        if memory and memory.get("id") == memory_id:
            try:
                path.unlink()
            except OSError as exc:
                emit({
                    "ok": False,
                    "stage": "delete_file",
                    "message": str(exc),
                    "id": memory_id,
                })
                raise typer.Exit(1)
            emit({"ok": True, "kind": "forget", "id": memory_id, "message": f"Deleted {memory_id}"})
            return

    emit({
        "ok": False,
        "stage": "not_found",
        "message": f"No memory found with id {memory_id!r}",
        "id": memory_id,
    })
    raise typer.Exit(1)


if __name__ == "__main__":
    app()
