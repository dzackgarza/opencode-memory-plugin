[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)

# opencode-memory-plugin

OpenCode plugin that gives agents a persistent, git-backed memory store backed by YAML-headered markdown files. Semantic search is provided by [`semtools`](https://github.com/run-llama/semtools) — local, no API key required.

## Install

Add to your OpenCode config:

```json
{
  "plugin": [
    "@dzackgarza/opencode-memory-plugin@git+https://github.com/dzackgarza/opencode-memory-plugin.git"
  ],
  "permission": {
    "remember": "allow",
    "recall": "allow",
    "list_memories": "allow",
    "forget": "allow"
  }
}
```

## Tools

### `remember`

Write a memory. The memory is filed under the git root of the agent's current working directory (`projects/{slug}/`), or `global/` if the agent is not inside a git repo. Pass `scope: "global"` to force global storage regardless.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `content` | string | Yes | Memory content (markdown) |
| `scope` | string | No | `"global"` to force global scope. Omit to auto-detect from working directory. |
| `session_id` | string | No | Tag the memory with a session ID for later filtering. |
| `tags` | string[] | No | Tags for filtering, e.g. `["deploy", "ops"]` |
| `metadata` | string | No | JSON object for arbitrary key-value metadata |

### `recall`

Semantic search over memories using `semtools`. Returns the closest matches by meaning.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `query` | string | Yes | Natural language search query |
| `scope` | string | No | `"global"` to restrict to global memories. Omit to search current project. |
| `session_id` | string | No | Filter to memories from a specific session |
| `limit` | number | No | Maximum results (default: 5) |

### `list_memories`

Browse memories in reverse chronological order.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `scope` | string | No | `"global"` to list only global memories |
| `session_id` | string | No | Filter by session ID |
| `tag` | string | No | Filter by tag name |
| `limit` | number | No | Maximum results (default: 50) |

### `forget`

Delete a memory permanently by its ID. The deletion is committed to the memory git repo.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | string | Yes | Memory ID (e.g. `mem_abc123`). Obtain from `recall` or `list_memories`. |

## Configuration

| Variable | Description |
|----------|-------------|
| `OPENCODE_MEMORY_ROOT` | Override the memory store root directory (default: `~/.local/share/opencode-memory`) |

The memory root is automatically initialized as a git repository on first write. Each `remember` and `forget` call commits the change.

## File format

Each memory is a YAML-headered markdown file:

```
---
created_at: '2026-03-15T14:30:22.000000+00:00'
id: mem_8k2j9x
metadata: {topic: infra}
project: opencode-plugins-my-repo
scope: project
session_id: ses_abc123
tags: [deploy, ops]
updated_at: '2026-03-15T14:30:22.000000+00:00'
---
Production deploy requires manual approval from @ops
```

## Directory structure

```
~/.local/share/opencode-memory/   ← git repo (auto-initialized)
  global/                          ← --scope global or not in a git repo
    {id}-{timestamp}.md
  projects/
    {git-root-slug}/               ← auto-detected from agent's CWD
      {id}-{timestamp}.md
```

## CLI

`src/cli.py` is a standalone script (PEP 723 inline deps) that can be used directly:

```bash
uv run src/cli.py remember --content "nginx handles SSL" --scope global
uv run src/cli.py recall "nginx configuration"
uv run src/cli.py list --scope global
uv run src/cli.py list-files --project my-project | xargs grep "deploy"
uv run src/cli.py forget --id mem_abc123
```

## Dependencies

- [`uv`](https://docs.astral.sh/uv/) — Python runner (resolves `typer` and `pyyaml` from inline script metadata)
- [`semtools`](https://github.com/run-llama/semtools) — local semantic search (auto-downloaded via `npx` on first `recall`)
- `git` — for memory repo initialization and commit history

## Development

```bash
just install
just test
just check
```
