import { type Plugin, tool } from '@opencode-ai/plugin';
import {
  formatCliResult,
  resolveMemoryRoot,
  runCliCommand,
  withPassphrase,
  withPluginVersion,
} from './shared.ts';

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

async function reportGitFailure(
  client: Parameters<Plugin>[0]['client'],
  operation: string,
  error: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const message = `git commit failed after ${operation}: ${error}`;
  await Promise.allSettled([
    client.app.log({
      body: {
        service: 'opencode-memory-plugin',
        level: 'error',
        message,
        extra: { operation, error, ...extra },
      },
    }),
    client.tui.showToast({
      body: {
        title: 'Memory git error',
        message: `${operation}: git commit failed — ${error}`,
        variant: 'error',
        duration: 10_000,
      },
    }),
  ]);
}

export const FileMemoryPlugin: Plugin = async ({ client }) => {
  return {
    tool: {
      remember: tool({
        description: withPassphrase(
          withPluginVersion(
            `Write a new memory to the git-backed file store.

## Store layout

Root: $OPENCODE_MEMORY_ROOT (default: ~/.local/share/opencode-memory)

  {root}/{project}/
    {id}-{timestamp}.md

"global" is the default project when the agent is not inside a git repo.
Each git repo gets its own project directory, named from the git root slug.

## File format

Each memory is a YAML-headered markdown file:

  ---
  id: mem_8k2j9x
  project: my-project-slug
  session_id: ses_abc123
  tags: [deploy, ops]
  ---
  Production deploy requires manual approval from @ops

## Reading memories

Memories are plain files — search them directly with:

  Semantic search (recommended):
    npx -y -p @llamaindex/semtools semtools search "deploy steps" {root}/**/*.md

  Keyword search:
    grep -rl "nginx" {root}/

  Read a file:
    cat {path}

## Project

Memories are filed under the git-root slug of the current working directory.
Pass project: "global" to force global storage regardless of git repo context.

## Session tracking

Omit session_id to use the current OpenCode session ID automatically.

Example:
  content: "Production deploy requires manual approval from @ops"
  tags: ["deploy", "ops"]`,
          ),
          'remember',
          'visible',
        ),
        args: {
          content: tool.schema
            .string()
            .describe('Memory content (markdown text, any length)'),
          project: tool.schema
            .string()
            .optional()
            .describe(
              "'global' to force global storage. Omit to auto-detect from working directory.",
            ),
          session_id: tool.schema
            .string()
            .optional()
            .describe(
              'Session ID stored as provenance metadata. Defaults to the current OpenCode session.',
            ),
          tags: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe('Tags for filtering, e.g. ["deploy", "ops"]'),
        },
        async execute(args, context) {
          const project = args.project;
          const sessionId = args.session_id ?? context.sessionID;

          await context.ask({
            permission: 'remember',
            patterns: [args.content.slice(0, 120)],
            always: ['*'],
            metadata: { project, sessionId },
          });

          const cliArgs = [
            'remember',
            '--content',
            args.content,
            '--cwd',
            process.cwd(),
          ];
          if (project) cliArgs.push('--project', project);
          if (sessionId) cliArgs.push('--session-id', sessionId);
          if (args.tags?.length) {
            for (const t of args.tags) cliArgs.push('--tag', t);
          }

          const memoryRoot = resolveMemoryRoot();
          const result = await runCliCommand(cliArgs, {
            ...process.env,
            OPENCODE_MEMORY_ROOT: memoryRoot,
          });

          if (result.ok && result.kind === 'remember') {
            if (result.git_error) {
              await reportGitFailure(client, 'remember', result.git_error, {
                id: result.id,
                path: result.path,
              });
            }
            context.metadata({
              title: 'Saved memory',
              metadata: { id: result.id, project: result.project },
            });
          }

          return withPassphrase(formatCliResult(result), 'remember', 'execute');
        },
      }),

      list_memories: tool({
        description: withPassphrase(
          withPluginVersion(
            `Query memory metadata using SQL. Accepts standard SQL SELECT queries.

All memory frontmatter is loaded into an in-memory SQLite table. Results include
the absolute file path so you can read memory content directly.

Schema:

  CREATE TABLE memories (
    id         TEXT,
    path       TEXT,    -- absolute path to the .md file
    project    TEXT,    -- "global" or a git-root slug
    session_id TEXT,
    tags       TEXT,    -- JSON array, e.g. '["deploy","ops"]'
    mtime      TEXT     -- ISO 8601 from filesystem mtime
  )`,
          ),
          'list_memories',
          'visible',
        ),
        args: {
          sql: tool.schema
            .string()
            .describe('SQL SELECT query against the memories table'),
        },
        async execute(args, context) {
          await context.ask({
            permission: 'list_memories',
            patterns: [],
            always: ['*'],
            metadata: { sql: args.sql },
          });

          const memoryRoot = resolveMemoryRoot();
          const result = await runCliCommand(['list', '--sql', args.sql], {
            ...process.env,
            OPENCODE_MEMORY_ROOT: memoryRoot,
          });

          if (result.ok && result.kind === 'list') {
            context.metadata({
              title: 'Listed memories',
              metadata: { count: result.count },
            });
          }

          return withPassphrase(formatCliResult(result), 'list_memories', 'execute');
        },
      }),

      forget: tool({
        description: withPassphrase(
          withPluginVersion(
            `Delete a memory permanently by ID. Use this instead of direct file deletion to keep the git history intact.

The deletion is committed to the memory git repo for auditability.
Obtain the ID from list_memories or by reading a memory file's frontmatter.

Example:
  id: "mem_abc123"`,
          ),
          'forget',
          'visible',
        ),
        args: {
          id: tool.schema
            .string()
            .describe(
              'Memory ID to delete (e.g. mem_abc123). Obtain from list_memories or memory file frontmatter.',
            ),
        },
        async execute(args, context) {
          await context.ask({
            permission: 'forget',
            patterns: [args.id],
            always: ['*'],
            metadata: { id: args.id },
          });

          const cliArgs = ['forget', '--id', args.id];
          const memoryRoot = resolveMemoryRoot();
          const result = await runCliCommand(cliArgs, {
            ...process.env,
            OPENCODE_MEMORY_ROOT: memoryRoot,
          });

          if (result.ok && result.kind === 'forget') {
            if (result.git_error) {
              await reportGitFailure(client, 'forget', result.git_error, {
                id: args.id,
              });
            }
            context.metadata({
              title: 'Deleted memory',
              metadata: { id: args.id },
            });
          }

          return withPassphrase(formatCliResult(result), 'forget', 'execute');
        },
      }),
    },
  };
};
