[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/I2I57UKJ8)

# opencode-memory-plugin

OpenCode plugin that gives agents a persistent, git-backed memory store backed by YAML-headered markdown files.

## Install

### OpenCode plugin

Add to your OpenCode config:

```json
{
  "plugin": [
    "@dzackgarza/opencode-memory-plugin@git+https://github.com/dzackgarza/opencode-memory-plugin.git"
  ],
  "permission": {
    "remember": "allow",
    "list_memories": "allow",
    "forget": "allow"
  }
}
```

### MCP server

```bash
uvx --from git+https://github.com/dzackgarza/opencode-memory-plugin opencode-memory-mcp
```

In any MCP client config:

```json
{
  "mcpServers": {
    "opencode-memory": {
      "command": "uvx",
      "args": [
        "--from", "git+https://github.com/dzackgarza/opencode-memory-plugin",
        "opencode-memory-mcp"
      ]
    }
  }
}
```

## Tools

### `remember`

Write a memory to the git-backed file store.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `content` | string | Yes | Memory content (markdown) |
| `project` | string | No | `"global"` to force global storage. Omit to auto-detect from working directory. |
| `session_id` | string | No | Provenance metadata. Defaults to current OpenCode session. |
| `tags` | string[] | No | Tags for filtering, e.g. `["deploy", "ops"]` |

### `list_memories`

Query memory metadata using SQL. Accepts any standard SQL SELECT against the memories table.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `sql` | string | Yes | SQL SELECT query |

Schema:

```sql
CREATE TABLE memories (
  id         TEXT,
  path       TEXT,    -- absolute path to the .md file
  project    TEXT,    -- "global" or a git-root slug
  session_id TEXT,
  tags       TEXT,    -- JSON array, e.g. '["deploy","ops"]'
  mtime      TEXT     -- ISO 8601 from filesystem mtime
)
```

### `forget`

Delete a memory permanently by its ID. The deletion is committed to the memory git repo.

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | string | Yes | Memory ID (e.g. `mem_abc123`). Obtain from `list_memories` or file frontmatter. |

## Searching memories

Memories are plain files. Search them directly:

```bash
# Semantic search
npx -y -p @llamaindex/semtools semtools search "deploy steps" ~/.local/share/opencode-memory/**/*.md

# Keyword search
grep -rl "nginx" ~/.local/share/opencode-memory/

# Read a file
cat /path/to/mem_abc123-20260315T143022Z.md
```

## Configuration

| Variable | Description |
|----------|-------------|
| `OPENCODE_MEMORY_ROOT` | Override the memory store root (default: `~/.local/share/opencode-memory`) |

The memory root is automatically initialized as a git repository on first write. Each `remember` and `forget` call commits the change.

## File format

Each memory is a YAML-headered markdown file:

```
---
id: mem_8k2j9x
project: opencode-plugins-my-repo
session_id: ses_abc123
tags: [deploy, ops]
---
Production deploy requires manual approval from @ops
```

## Directory structure

```
~/.local/share/opencode-memory/   ← git repo (auto-initialized)
  global/                          ← default when not in a git repo
    {id}-{timestamp}.md
  {git-root-slug}/                 ← auto-detected from agent's CWD
    {id}-{timestamp}.md
```

## CLI

`src/cli.py` is a standalone script (PEP 723 inline deps) that can be used directly:

```bash
uv run src/cli.py remember --content "nginx handles SSL" --project global
uv run src/cli.py list --sql "SELECT * FROM memories WHERE project = 'global'"
uv run src/cli.py list-files --project my-project | xargs grep "deploy"
uv run src/cli.py recall "nginx configuration"   # semantic search via semtools
uv run src/cli.py forget --id mem_abc123
```

## Dependencies

The plugin requires these tools to be installed and on `PATH`:

| Tool | Purpose | Install |
|------|---------|---------|
| [`uv`](https://docs.astral.sh/uv/) | Runs the bundled `cli.py` and resolves its Python deps | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| `git` | Memory repo initialization and commit history | OS package manager |
| [`semtools`](https://github.com/run-llama/semtools) | Local semantic search (optional — only needed for `recall` CLI command or direct semtools usage) | `npm install -g @llamaindex/semtools` or auto-downloaded via `npx` |

`uv` and `git` are required for all plugin operations. `semtools` is only needed if you use the `recall` CLI command or invoke semtools directly for semantic search.

## Development

```bash
just install
just test
just check
```
