import { type Plugin, tool } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pkg from "../package.json" assert { type: "json" };

const execFileAsync = promisify(execFile);

const PLUGIN_VERSION = pkg.version;
const BUG_REPORTING_URL =
  "https://github.com/dzackgarza/opencode-postgres-memory-plugin/issues/new?labels=bug";
const DATABASE_URL_ENV = "POSTGRES_MEMORY_DATABASE_URL";
const MEMORY_SEED_ENV = "POSTGRES_MEMORY_TEST_SEED";
const REQUEST_ENV = "POSTGRES_MEMORY_REQUEST_JSON";
const PYTHON_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const ISSUE_REPORTING_HINT =
  `If this looks like a plugin/runtime bug, file a GitHub issue tagged \`bug\`: ${BUG_REPORTING_URL}. Include the SQL, redacted database URL, and exact error below.`;

type QueryRowsSuccess = {
  ok: true;
  kind: "rows";
  rowCount: number;
  rows: Array<Record<string, unknown>>;
};

type QueryCommandSuccess = {
  ok: true;
  kind: "command";
  commandTag: string;
};

type QueryFailure = {
  ok: false;
  failureKind: "query_failure";
  code?: string | null;
  detail?: string | null;
  hint?: string | null;
  message: string;
  position?: number | string | null;
  sql: string;
  where?: string | null;
};

type ToolFailure = {
  ok: false;
  databaseUrl: string;
  detail?: string | null;
  failureKind: "tool_failure";
  message: string;
  sql: string;
  stage: string;
  traceback?: string | null;
};

type QueryExecutionResult =
  | QueryRowsSuccess
  | QueryCommandSuccess
  | QueryFailure
  | ToolFailure;

const PYTHON_QUERY_RUNNER = String.raw`
import asyncio
import json
import os
import traceback
import urllib.parse

import asyncpg

REQUEST_ENV = "POSTGRES_MEMORY_REQUEST_JSON"


def redact_url(database_url):
    if not database_url:
        return ""
    try:
        parsed = urllib.parse.urlsplit(database_url)
    except Exception:
        return database_url

    netloc = parsed.hostname or ""
    if parsed.username:
        username = urllib.parse.quote(parsed.username, safe="")
        if parsed.password is not None:
            netloc = f"{username}:***@{netloc}"
        else:
            netloc = f"{username}@{netloc}"
    if parsed.port is not None:
        netloc = f"{netloc}:{parsed.port}"
    return urllib.parse.urlunsplit(
        (
            parsed.scheme,
            netloc,
            parsed.path,
            parsed.query,
            parsed.fragment,
        )
    )


def emit(payload):
    print(json.dumps(payload, default=str))


def emit_tool_failure(stage, message, database_url, sql, detail=None):
    payload = {
        "ok": False,
        "failureKind": "tool_failure",
        "stage": stage,
        "message": message,
        "databaseUrl": redact_url(database_url),
        "sql": sql,
    }
    if detail:
        payload["detail"] = detail
        payload["traceback"] = traceback.format_exc()
    emit(payload)
    raise SystemExit(0)


def query_returns_rows(sql_input):
    stripped = sql_input.lstrip()
    upper = stripped.upper()
    if " RETURNING " in upper:
        return True
    return upper.startswith(("SELECT", "WITH", "SHOW", "EXPLAIN", "VALUES"))


async def ensure_schema(conn, database_url, sql):
    try:
        await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
    except asyncpg.PostgresError as error:
        detail = "\\n".join(
            [
                str(error),
                f"SQLSTATE: {getattr(error, 'sqlstate', None)}",
            ]
        )
        emit_tool_failure(
            "extension_bootstrap",
            "The PostgreSQL server does not have a working pgvector extension. Admin action may be required to install or enable pgvector.",
            database_url,
            sql,
            detail=detail,
        )

    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS memories (
            id BIGSERIAL PRIMARY KEY,
            scope TEXT NOT NULL DEFAULT 'session',
            session_id TEXT,
            content TEXT NOT NULL,
            embedding VECTOR(1536),
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            project_name TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

    await conn.execute(
        "ALTER TABLE memories ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'session'"
    )
    await conn.execute(
        "ALTER TABLE memories ADD COLUMN IF NOT EXISTS session_id TEXT"
    )
    await conn.execute(
        "ALTER TABLE memories ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb"
    )
    await conn.execute(
        "ALTER TABLE memories ADD COLUMN IF NOT EXISTS project_name TEXT"
    )
    await conn.execute(
        "ALTER TABLE memories ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP"
    )
    await conn.execute(
        "ALTER TABLE memories ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP"
    )

    embedding_info = await conn.fetchrow(
        """
        SELECT
            data_type,
            udt_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'memories'
          AND column_name = 'embedding'
        """
    )
    if embedding_info is None:
        await conn.execute("ALTER TABLE memories ADD COLUMN embedding VECTOR(1536)")
    elif embedding_info["udt_name"] != "vector":
        emit_tool_failure(
            "schema_bootstrap",
            f"Existing memories.embedding column has type {embedding_info['udt_name']!r}; expected pgvector. Manual migration is required before this plugin can run.",
            database_url,
            sql,
        )

    await conn.execute("UPDATE memories SET scope = 'session' WHERE scope IS NULL")
    await conn.execute("ALTER TABLE memories ALTER COLUMN scope SET DEFAULT 'session'")
    await conn.execute("ALTER TABLE memories ALTER COLUMN scope SET NOT NULL")

    await conn.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'memories_scope_check'
            ) THEN
                ALTER TABLE memories
                ADD CONSTRAINT memories_scope_check
                CHECK (scope IN ('session', 'global'));
            END IF;
        END
        $$;
        """
    )
    await conn.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'memories_scope_session_check'
            ) THEN
                ALTER TABLE memories
                ADD CONSTRAINT memories_scope_session_check
                CHECK (
                    (scope = 'global' AND session_id IS NULL)
                    OR (scope = 'session' AND session_id IS NOT NULL)
                );
            END IF;
        END
        $$;
        """
    )

    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memories_project_scope_session ON memories (project_name, scope, session_id)"
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories (created_at DESC)"
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memories_embedding_hnsw ON memories USING hnsw (embedding vector_l2_ops)"
    )


async def main():
    request_text = os.environ.get(REQUEST_ENV, "").strip()
    if not request_text:
        emit_tool_failure("request_parse", f"{REQUEST_ENV} was empty.", "", "")

    try:
        request = json.loads(request_text)
    except Exception as error:
        emit_tool_failure(
            "request_parse",
            "Could not parse the query runner request.",
            "",
            "",
            detail=str(error),
        )

    sql = request.get("sql")
    database_url = request.get("databaseUrl")
    if not isinstance(sql, str) or not sql.strip():
        emit_tool_failure(
            "request_parse",
            "SQL must be a non-empty string.",
            database_url if isinstance(database_url, str) else "",
            sql if isinstance(sql, str) else "",
        )
    if not isinstance(database_url, str) or not database_url.strip():
        emit_tool_failure(
            "request_parse",
            "Database URL must be a non-empty string.",
            database_url if isinstance(database_url, str) else "",
            sql,
        )

    conn = None
    try:
        conn = await asyncpg.connect(database_url)
        await ensure_schema(conn, database_url, sql)

        try:
            if query_returns_rows(sql):
                rows = await conn.fetch(sql)
                emit(
                    {
                        "ok": True,
                        "kind": "rows",
                        "rowCount": len(rows),
                        "rows": [dict(row) for row in rows],
                    }
                )
            else:
                emit(
                    {
                        "ok": True,
                        "kind": "command",
                        "commandTag": await conn.execute(sql),
                    }
                )
        except asyncpg.PostgresError as error:
            emit(
                {
                    "ok": False,
                    "failureKind": "query_failure",
                    "message": str(error),
                    "code": getattr(error, "sqlstate", None),
                    "detail": getattr(error, "detail", None),
                    "hint": getattr(error, "hint", None),
                    "position": getattr(error, "position", None),
                    "where": getattr(error, "where", None),
                    "sql": sql,
                }
            )
    except Exception as error:
        detail = str(error)
        lowered = detail.lower()
        stage = "database_runtime"
        if "password authentication failed" in lowered or "peer authentication failed" in lowered:
            stage = "database_authentication"
        elif "does not exist" in lowered or "connection refused" in lowered or "connect call failed" in lowered:
            stage = "database_connection"
        elif "memories.embedding column has type" in lowered:
            stage = "schema_bootstrap"
        emit_tool_failure(stage, detail, database_url, sql, detail=detail)
    finally:
        if conn is not None:
            await conn.close()


asyncio.run(main())
`;

function buildPassphrase(
  toolName: string,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const seed = env[MEMORY_SEED_ENV]?.trim() ?? "";
  if (!seed) return "";
  return `${seed}:${toolName}:${path}`;
}

function withPassphrase(
  description: string,
  toolName: string,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const pass = buildPassphrase(toolName, path, env);
  if (!pass) return description;
  return `${description}\n\nVerification passphrase: ${pass}`;
}

function withPluginVersion(description: string): string {
  return `${description} (Plugin version: ${PLUGIN_VERSION})`;
}

function buildPostgresUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const host = env.PGHOST?.trim();
  const user = env.PGUSER?.trim();
  const database = env.PGDATABASE?.trim();
  if (!host || !user || !database) return undefined;

  const protocol = env.PGSSLMODE?.trim() === "require" ? "postgresqls:" : "postgresql:";
  const url = new URL(`${protocol}//placeholder`);
  url.hostname = host;
  url.username = user;
  url.password = env.PGPASSWORD?.trim() ?? "";
  url.pathname = `/${database}`;

  const port = env.PGPORT?.trim();
  if (port) url.port = port;

  if (env.PGSSLMODE?.trim()) {
    url.searchParams.set("sslmode", env.PGSSLMODE.trim());
  }

  return url.toString();
}

function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[DATABASE_URL_ENV]?.trim() || env.DATABASE_URL?.trim();
  if (explicit) return explicit;

  const built = buildPostgresUrlFromEnv(env);
  if (built) return built;

  throw new Error(
    `No PostgreSQL connection details were configured. Set ${DATABASE_URL_ENV}, DATABASE_URL, or the standard PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE variables.`,
  );
}

function redactDatabaseUrl(databaseUrl: string): string {
  if (!databaseUrl) return "";

  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return databaseUrl;
  }
}

function buildToolFailure(
  stage: string,
  message: string,
  sql: string,
  databaseUrl: string,
  detail?: string,
): ToolFailure {
  return {
    ok: false,
    failureKind: "tool_failure",
    stage,
    message,
    detail,
    sql,
    databaseUrl: redactDatabaseUrl(databaseUrl),
  };
}

function parseRunnerResult(raw: string | undefined): QueryExecutionResult | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as QueryExecutionResult;
  } catch {
    return undefined;
  }
}

function extractExecErrorDetail(error: unknown): {
  detail: string;
  stdout?: string;
  stderr?: string;
} {
  if (typeof error !== "object" || error === null) {
    return { detail: String(error) };
  }

  const message =
    "message" in error && typeof error.message === "string"
      ? error.message
      : String(error);
  const stdout =
    "stdout" in error && typeof error.stdout === "string" ? error.stdout : undefined;
  const stderr =
    "stderr" in error && typeof error.stderr === "string" ? error.stderr : undefined;

  return { detail: message, stdout, stderr };
}

async function runPostgresQuery(
  sql: string,
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<QueryExecutionResult> {
  const request = JSON.stringify({ sql, databaseUrl });

  try {
    const { stdout } = await execFileAsync(
      "uv",
      [
        "run",
        "--no-project",
        "--python",
        "3.12",
        "--with",
        "asyncpg",
        "python3",
        "-c",
        PYTHON_QUERY_RUNNER,
      ],
      {
        env: {
          ...env,
          [REQUEST_ENV]: request,
        },
        maxBuffer: PYTHON_MAX_BUFFER_BYTES,
      },
    );

    const parsed = parseRunnerResult(stdout);
    if (parsed) return parsed;
    return buildToolFailure(
      "runner_output",
      "The Postgres query runner returned a non-JSON payload.",
      sql,
      databaseUrl,
      stdout.trim(),
    );
  } catch (error) {
    const { detail, stdout, stderr } = extractExecErrorDetail(error);
    const parsed = parseRunnerResult(stdout);
    if (parsed) return parsed;
    return buildToolFailure(
      "runner_process",
      "The Postgres query runner exited before it returned a result.",
      sql,
      databaseUrl,
      [detail, stderr].filter(Boolean).join("\n"),
    );
  }
}

function formatQueryResult(result: QueryExecutionResult): string {
  if (result.ok) {
    return result.kind === "rows"
      ? JSON.stringify(result.rows, null, 2)
      : result.commandTag;
  }

  if (result.failureKind === "query_failure") {
    return [
      "QUERY FAILURE",
      `message: ${result.message}`,
      result.code ? `sqlstate: ${result.code}` : undefined,
      result.detail ? `detail: ${result.detail}` : undefined,
      result.hint ? `hint: ${result.hint}` : undefined,
      result.position ? `position: ${result.position}` : undefined,
      result.where ? `where: ${result.where}` : undefined,
      `sql: ${result.sql}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "TOOL FAILURE",
    `stage: ${result.stage}`,
    `message: ${result.message}`,
    result.detail ? `detail: ${result.detail}` : undefined,
    result.traceback ? `traceback:\n${result.traceback}` : undefined,
    `database_url: ${result.databaseUrl}`,
    `sql: ${result.sql}`,
    `bug_report: ${BUG_REPORTING_URL}`,
    ISSUE_REPORTING_HINT,
  ]
    .filter(Boolean)
    .join("\n");
}

export const postgresMemoryTesting = {
  BUG_REPORTING_URL,
  buildPassphrase,
  formatQueryResult,
  redactDatabaseUrl,
  resolveDatabaseUrl,
  runPostgresQuery,
};

export const PostgresMemoryPlugin: Plugin = async ({ project }) => {
  const projectName = project.id;

  return {
    tool: {
      query_memories: tool({
        description: withPassphrase(
          withPluginVersion(`Use standard PostgreSQL syntax to read and write memories for this project.

Canonical table: memories
Columns:
  - id BIGSERIAL PRIMARY KEY
  - scope TEXT NOT NULL
  - session_id TEXT
  - content TEXT NOT NULL
  - embedding VECTOR(1536)
  - metadata JSONB NOT NULL
  - project_name TEXT
  - created_at TIMESTAMPTZ NOT NULL
  - updated_at TIMESTAMPTZ NOT NULL

Conventions:
  - session memories: scope = 'session' and session_id is set
  - global memories: scope = 'global' and session_id is NULL

Example write:
  INSERT INTO memories (scope, session_id, project_name, content, metadata)
  VALUES ('session', 'session-alpha', '${projectName}', '# Deploy notes', '{"topic":"ops"}');

Example semantic search:
  SELECT content, metadata
  FROM memories
  WHERE project_name = '${projectName}' AND scope = 'session' AND session_id = 'session-alpha' AND embedding IS NOT NULL
  ORDER BY embedding <-> '[0.1,0.2,0.3]'::vector
  LIMIT 5;`),
          "query_memories",
          "visible",
        ),
        args: {
          sql: tool.schema.string().describe(
            "The SQL query to execute against the configured PostgreSQL memory database.",
          ),
        },
        async execute(args, context) {
          await context.ask({
            permission: "query_memories",
            patterns: [args.sql],
            always: ["*"],
            metadata: { sql: args.sql },
          });

          let databaseUrl = "";
          try {
            databaseUrl = resolveDatabaseUrl(process.env);
          } catch (error) {
            return withPassphrase(
              formatQueryResult(
                buildToolFailure(
                  "configuration",
                  error instanceof Error ? error.message : String(error),
                  args.sql,
                  "",
                ),
              ),
              "query_memories",
              "execute",
            );
          }

          const result = await runPostgresQuery(args.sql, databaseUrl);
          context.metadata({
            title: "Postgres memory query",
            metadata: {
              databaseUrl: redactDatabaseUrl(databaseUrl),
              projectName,
              resultKind: result.ok ? result.kind : result.failureKind,
            },
          });

          return withPassphrase(
            formatQueryResult(result),
            "query_memories",
            "execute",
          );
        },
      }),
    },
  };
};
