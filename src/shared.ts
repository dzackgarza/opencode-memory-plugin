import { $ } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" assert { type: "json" };

export const PLUGIN_VERSION = pkg.version;
export const BUG_REPORTING_URL =
  "https://github.com/dzackgarza/opencode-memory-plugin/issues/new?labels=bug";
const MEMORY_ROOT_ENV = "OPENCODE_MEMORY_ROOT";
const MEMORY_SEED_ENV = "OPENCODE_MEMORY_TEST_SEED";
export const ISSUE_REPORTING_HINT = `If this looks like a plugin/runtime bug, file a GitHub issue tagged \`bug\`: ${BUG_REPORTING_URL}`;

export type RememberSuccess = {
  ok: true;
  kind: "remember";
  id: string;
  path: string;
  project: string;
  git_error?: string | null;
};

export type ListSuccess = {
  ok: true;
  kind: "list";
  results: Record<string, unknown>[];
  count: number;
};

export type ForgetSuccess = {
  ok: true;
  kind: "forget";
  id: string;
  message: string;
  git_error?: string | null;
};

export type CliFailure = {
  ok: false;
  stage: string;
  message: string;
  detail?: string;
};

export type CliResult = RememberSuccess | ListSuccess | ForgetSuccess | CliFailure;

export function buildPassphrase(
  toolName: string,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const seed = env[MEMORY_SEED_ENV]?.trim() ?? "";
  if (!seed) return "";
  return `${seed}:${toolName}:${path}`;
}

export function withPassphrase(
  description: string,
  toolName: string,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const pass = buildPassphrase(toolName, path, env);
  if (!pass) return description;
  return `${description}\n\nVerification passphrase: ${pass}`;
}

export function withPluginVersion(description: string): string {
  return `${description} (Plugin version: ${PLUGIN_VERSION})`;
}

export function resolveMemoryRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[MEMORY_ROOT_ENV]?.trim();
  if (explicit) return explicit;
  const xdgData =
    env.XDG_DATA_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".local", "share");
  return join(xdgData, "opencode-memory");
}

export async function runCliCommand(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliResult> {
  const cliSpec =
    env.MEMORY_MANAGER_CLI_SPEC ??
    "git+https://github.com/dzackgarza/memory-manager.git";

  const output = await $`uvx --from ${cliSpec} opencode-memory ${args}`
    .env(env)
    .quiet()
    .nothrow();
  const text = output.stdout.toString().trim();
  if (!text) {
    return {
      ok: false,
      stage: "runner_output",
      message: "CLI returned empty output.",
      detail: output.stderr.toString().trim() || undefined,
    };
  }
  try {
    return JSON.parse(text) as CliResult;
  } catch {
    return {
      ok: false,
      stage: "runner_output",
      message: "CLI returned non-JSON output.",
      detail: text.slice(0, 500),
    };
  }
}

const GIT_FAILURE_HINT = [
  "Memory was written successfully but the git commit failed.",
  "Version control is essential — without it, accumulated knowledge has no protection against overwrites or data loss.",
  `Please investigate and file an issue if this is a plugin bug: ${BUG_REPORTING_URL}`,
].join("\n");

function formatGitError(error: string): string {
  return `\n\nGIT COMMIT FAILURE\nerror: ${error}\n${GIT_FAILURE_HINT}`;
}

export function formatCliResult(result: CliResult): string {
  if (!result.ok) {
    return [
      "TOOL FAILURE",
      `stage: ${result.stage}`,
      `message: ${result.message}`,
      result.detail ? `detail: ${result.detail}` : undefined,
      `bug_report: ${BUG_REPORTING_URL}`,
      ISSUE_REPORTING_HINT,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (result.kind === "remember") {
    const base = `Saved: ${result.id} → ${result.path}`;
    return result.git_error ? base + formatGitError(result.git_error) : base;
  }

  if (result.kind === "list") {
    if (result.count === 0) return "No memories found.";
    return result.results
      .map((row, i) =>
        [`[${i + 1}]`, ...Object.entries(row).map(([k, v]) => `  ${k}: ${v}`)].join(
          "\n",
        ),
      )
      .join("\n\n");
  }

  if (result.kind === "forget") {
    return result.git_error
      ? result.message + formatGitError(result.git_error)
      : result.message;
  }

  return JSON.stringify(result, null, 2);
}

export const fileMemoryTesting = {
  BUG_REPORTING_URL,
  buildPassphrase,
  formatCliResult,
  resolveMemoryRoot,
  runCliCommand,
};
