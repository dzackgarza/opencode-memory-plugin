import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileMemoryTesting } from "../../src/shared.ts";

function requireEnv(name: string, message: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(message);
  return value;
}

const MAX_BUFFER = 8 * 1024 * 1024;
const RUNTIME_TIMEOUT_MS = 20_000;
const SESSION_TIMEOUT_MS = 240_000;
const AGENT_NAME = "plugin-proof";
const MANAGER_PACKAGE = "git+https://github.com/dzackgarza/opencode-manager.git";
const PROJECT_DIR = process.cwd();
let ocmBinaryPath: string | undefined;

// OpenCode must already be running before this file executes.
// `just test` runs the suite, but it does not start or stop the server.
const BASE_URL = requireEnv(
  "OPENCODE_BASE_URL",
  "OPENCODE_BASE_URL must be set (run against a repo-local or CI OpenCode server)",
);
const SHARED_MEM_ROOT = requireEnv(
  "OPENCODE_MEMORY_ROOT",
  "OPENCODE_MEMORY_ROOT must be set (from plugin .envrc or CI env)",
);

type CliResult = Awaited<ReturnType<typeof fileMemoryTesting.runCliCommand>>;
type RawSessionMessage = {
  info?: {
    role?: string;
  };
  parts?: Array<{
    type?: string;
    text?: string;
  } | null>;
};

const tempPaths = new Set<string>();

function registerTempPath(path: string): string {
  tempPaths.add(path);
  return path;
}

function randomSuffix(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function makeTempMemoryRoot(): string {
  return registerTempPath(mkdtempSync(join(tmpdir(), "opencode-file-memory-")));
}

afterAll(() => {
  for (const path of tempPaths) {
    rmSync(path, { recursive: true, force: true });
  }
});

function getOcmBinaryPath(): string {
  if (ocmBinaryPath) return ocmBinaryPath;
  const toolDir = registerTempPath(mkdtempSync(join(tmpdir(), "ocm-tool-")));
  const binDir = process.platform === "win32" ? join(toolDir, "Scripts") : join(toolDir, "bin");
  const candidate = join(binDir, process.platform === "win32" ? "ocm.exe" : "ocm");
  if (!existsSync(candidate)) {
    const install = spawnSync(
      "uv",
      ["tool", "install", "--tool-dir", toolDir, "--from", MANAGER_PACKAGE, "ocm"],
      {
        env: process.env,
        cwd: PROJECT_DIR,
        encoding: "utf8",
        timeout: SESSION_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      },
    );
    if (install.error) throw install.error;
    if (install.status !== 0 || !existsSync(candidate)) {
      throw new Error(
        `Failed to install ocm\nSTDOUT:\n${install.stdout ?? ""}\nSTDERR:\n${install.stderr ?? ""}`,
      );
    }
  }
  ocmBinaryPath = candidate;
  return candidate;
}

function runOcm(args: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(
    getOcmBinaryPath(),
    args,
    {
      env: { ...process.env, OPENCODE_BASE_URL: BASE_URL, OPENCODE_MEMORY_ROOT: SHARED_MEM_ROOT },
      cwd: PROJECT_DIR,
      encoding: "utf8",
      timeout: SESSION_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    },
  );
  if (result.error) throw result.error;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    throw new Error(`ocm ${args.join(" ")} failed\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }
  return { stdout, stderr };
}

function beginSession(prompt: string): string {
  const { stdout } = runOcm(["begin-session", prompt, "--agent", AGENT_NAME, "--json"]);
  const data = JSON.parse(stdout) as { sessionID: string };
  if (!data.sessionID) throw new Error(`begin-session returned no sessionID: ${stdout}`);
  return data.sessionID;
}

async function readRawSessionMessages(sessionID: string): Promise<RawSessionMessage[]> {
  const response = await fetch(`${BASE_URL}/session/${sessionID}/message`);
  if (!response.ok) {
    throw new Error(`Failed to load session messages for ${sessionID}: ${response.status}`);
  }
  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error(`Session messages for ${sessionID} were not an array.`);
  }
  return data as RawSessionMessage[];
}

function flattenMessageText(message: RawSessionMessage): string {
  return (message.parts ?? [])
    .filter(
      (part): part is { type?: string; text?: string } =>
        part !== null && typeof part === "object",
    )
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
}

async function waitForAssistantText(
  sessionID: string,
  predicate: (text: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = (await readRawSessionMessages(sessionID))
      .filter((message) => message.info?.role === "assistant")
      .map(flattenMessageText)
      .find((text) => text.length > 0 && predicate(text));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for matching assistant text in session ${sessionID}.`);
}

async function waitForMemoryContent(content: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const globalDir = join(SHARED_MEM_ROOT, "global");
    if (existsSync(globalDir)) {
      const found = readdirSync(globalDir).some((fileName) =>
        readFileSync(join(globalDir, fileName), "utf8").includes(content),
      );
      if (found) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for memory content "${content}" under ${SHARED_MEM_ROOT}.`);
}

// ---------------------------------------------------------------------------
// Runtime integration tests (direct CLI, no OpenCode server)
// ---------------------------------------------------------------------------

describe("file-memory runtime integration", () => {
  it("remember creates a YAML-headered markdown file with correct structure", async () => {
    const memRoot = makeTempMemoryRoot();
    const content = "The production hostname is api.internal.example";

    const result = (await fileMemoryTesting.runCliCommand(
      ["remember", "--content", content, "--project", "global", "--tag", "infra"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;

    if (!result.ok) throw new Error(`Expected ok, got ${JSON.stringify(result)}`);
    expect(result.kind).toBe("remember");
    if (!result.ok || result.kind !== "remember") throw new Error(JSON.stringify(result));
    expect(result.id).toMatch(/^mem_/);

    // File must exist on disk under global/ with correct content
    const globalDir = join(memRoot, "global");
    const files = readdirSync(globalDir);
    expect(files.length).toBe(1);
    const fileContent = readFileSync(join(globalDir, files[0]!), "utf8");
    expect(fileContent).toContain("id: mem_");
    expect(fileContent).toContain("project: global");
    expect(fileContent).toContain("- infra");
    expect(fileContent).toContain(content);
  }, RUNTIME_TIMEOUT_MS);

  it("memory root is initialized as a git repo on first write", async () => {
    const memRoot = makeTempMemoryRoot();

    await fileMemoryTesting.runCliCommand(
      ["remember", "--content", "first memory", "--project", "global"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    );

    expect(existsSync(join(memRoot, ".git"))).toBe(true);
  }, RUNTIME_TIMEOUT_MS);

  it("remember + list_memories round-trip: project vs global scope isolation", async () => {
    const memRoot = makeTempMemoryRoot();
    const project = `test_${randomSuffix()}`;
    const sessionId = `ses_${randomSuffix()}`;

    // Project-scoped memory (tagged with a session_id for later filtering)
    await fileMemoryTesting.runCliCommand(
      [
        "remember",
        "--content",
        "project note",
        "--project",
        project,
        "--session-id",
        sessionId,
      ],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    );
    // Global memory
    await fileMemoryTesting.runCliCommand(
      ["remember", "--content", "global note", "--project", "global"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    );

    // List by project + session filter → only the project note
    const projectList = (await fileMemoryTesting.runCliCommand(
      ["list", "--sql", `SELECT * FROM memories WHERE project = '${project}' AND session_id = '${sessionId}'`],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;
    if (!projectList.ok || projectList.kind !== "list")
      throw new Error(JSON.stringify(projectList));
    expect(projectList.count).toBe(1);
    expect(projectList.results[0]?.["project"]).toBe(project);

    // List global only → only the global note
    const globalList = (await fileMemoryTesting.runCliCommand(
      ["list", "--sql", "SELECT * FROM memories WHERE project = 'global'"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;
    if (!globalList.ok || globalList.kind !== "list")
      throw new Error(JSON.stringify(globalList));
    expect(globalList.count).toBe(1);
    expect(globalList.results[0]?.["project"]).toBe("global");

    // List all → both
    const allList = (await fileMemoryTesting.runCliCommand(
      ["list", "--sql", "SELECT * FROM memories"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;
    if (!allList.ok || allList.kind !== "list") throw new Error(JSON.stringify(allList));
    expect(allList.count).toBe(2);
  }, RUNTIME_TIMEOUT_MS);

  it("forget deletes the target memory and leaves others intact", async () => {
    const memRoot = makeTempMemoryRoot();
    const project = `test_${randomSuffix()}`;

    const r1 = (await fileMemoryTesting.runCliCommand(
      ["remember", "--content", "to delete", "--project", project],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;
    const r2 = (await fileMemoryTesting.runCliCommand(
      ["remember", "--content", "to keep", "--project", project],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;

    if (!r1.ok || r1.kind !== "remember") throw new Error(JSON.stringify(r1));
    if (!r2.ok || r2.kind !== "remember") throw new Error(JSON.stringify(r2));

    const forgetResult = (await fileMemoryTesting.runCliCommand(
      ["forget", "--id", r1.id],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;
    if (!forgetResult.ok) throw new Error(`forget failed: ${JSON.stringify(forgetResult)}`);
    expect(forgetResult.kind).toBe("forget");

    const remaining = (await fileMemoryTesting.runCliCommand(
      ["list", "--sql", `SELECT id FROM memories WHERE project = '${project}'`],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;
    if (!remaining.ok || remaining.kind !== "list") throw new Error(JSON.stringify(remaining));
    expect(remaining.count).toBe(1);
    expect(remaining.results[0]?.["id"]).toBe(r2.id);
  }, RUNTIME_TIMEOUT_MS);

  it("forget returns a not_found failure for an unknown ID", async () => {
    const memRoot = makeTempMemoryRoot();

    const result = (await fileMemoryTesting.runCliCommand(
      ["forget", "--id", "mem_doesnotexist"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.stage).toBe("not_found");
  }, RUNTIME_TIMEOUT_MS);

  it("concurrent writes produce distinct non-colliding files", async () => {
    const memRoot = makeTempMemoryRoot();
    const project = `test_${randomSuffix()}`;

    const writes = Array.from({ length: 10 }, (_, i) =>
      fileMemoryTesting.runCliCommand(
        [
          "remember",
          "--content",
          `memory ${i}`,
          "--project",
          project,
        ],
        { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
      ),
    );
    const results = await Promise.all(writes);

    const ids = new Set<string>();
    for (const r of results) {
      if (!r.ok || r.kind !== "remember")
        throw new Error(`Write failed: ${JSON.stringify(r)}`);
      ids.add(r.id);
    }
    expect(ids.size).toBe(10);

    const listed = (await fileMemoryTesting.runCliCommand(
      ["list", "--sql", `SELECT id FROM memories WHERE project = '${project}'`],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;
    if (!listed.ok || listed.kind !== "list") throw new Error(JSON.stringify(listed));
    expect(listed.count).toBe(10);
  }, RUNTIME_TIMEOUT_MS);

  it("list --sql returns results matching SQL filter", async () => {
    const memRoot = makeTempMemoryRoot();
    const project = `test_${randomSuffix()}`;

    await fileMemoryTesting.runCliCommand(
      ["remember", "--content", "nginx SSL termination", "--project", project, "--tag", "infra"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    );
    await fileMemoryTesting.runCliCommand(
      ["remember", "--content", "database rotation policy", "--project", project, "--tag", "security"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    );
    await fileMemoryTesting.runCliCommand(
      ["remember", "--content", "global note", "--project", "global"],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    );

    // SQL filter: only memories in the test project
    const result = (await fileMemoryTesting.runCliCommand(
      ["list", "--sql", `SELECT id, path, project FROM memories WHERE project = '${project}'`],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;

    if (!result.ok || result.kind !== "list")
      throw new Error(`list failed: ${JSON.stringify(result)}`);
    expect(result.count).toBe(2);
    for (const row of result.results) {
      expect(row["project"]).toBe(project);
      expect(String(row["path"])).toMatch(/\.md$/);
    }

    // SQL filter by tag using json_each
    const tagResult = (await fileMemoryTesting.runCliCommand(
      ["list", "--sql", `SELECT id FROM memories WHERE EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'infra')`],
      { ...process.env, OPENCODE_MEMORY_ROOT: memRoot },
    )) as CliResult;

    if (!tagResult.ok || tagResult.kind !== "list")
      throw new Error(`tag list failed: ${JSON.stringify(tagResult)}`);
    expect(tagResult.count).toBe(1);
  }, RUNTIME_TIMEOUT_MS);

  it("formatCliResult produces TOOL FAILURE text for failed results", async () => {
    const failResult = (await fileMemoryTesting.runCliCommand(
      ["forget", "--id", "mem_ghost"],
      { ...process.env, OPENCODE_MEMORY_ROOT: "/tmp/definitely_does_not_exist_xyzzy" },
    )) as CliResult;

    expect(failResult.ok).toBe(false);
    if (failResult.ok) throw new Error("Expected failure");
    const formatted = fileMemoryTesting.formatCliResult(failResult);
    expect(formatted).toContain("TOOL FAILURE");
    expect(formatted).toContain(fileMemoryTesting.BUG_REPORTING_URL);
  }, RUNTIME_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Live OpenCode session tests (opencode-manager, requires running server)
// ---------------------------------------------------------------------------

describe("file-memory live opencode sessions", () => {
  it("agent can remember a fact and it appears in the memory root as a file", async () => {
    const secret = `GOLDEN-TICKET-${randomUUID()}`;
    const sessionID = beginSession(
      `Call remember exactly once with content="${secret}" and project="global". Reply with ONLY WRITTEN after the tool finishes.`,
    );
    try {
      await waitForMemoryContent(secret, SESSION_TIMEOUT_MS);
      const globalDir = join(SHARED_MEM_ROOT, "global");
      const files = readdirSync(globalDir);
      const found = files.some((f) => readFileSync(join(globalDir, f), "utf8").includes(secret));
      expect(found).toBe(true);
    } finally {
      try { runOcm(["delete", sessionID]); } catch { /* best-effort */ }
    }
  }, SESSION_TIMEOUT_MS);

  it("agent can find a memory written in a prior run using list_memories", async () => {
    const secret = `RECALL-TOKEN-${randomUUID()}`;

    // Write in first session
    const writeID = beginSession(
      `Call remember exactly once with content="${secret}" and project="global". Reply ONLY WRITTEN.`,
    );
    try {
      await waitForMemoryContent(secret, SESSION_TIMEOUT_MS);
    } finally {
      try { runOcm(["delete", writeID]); } catch { /* best-effort */ }
    }

    // Find via list_memories SQL in second independent session
    const readID = beginSession(
      'Call list_memories exactly once with sql="SELECT path FROM memories ORDER BY mtime DESC LIMIT 1". Reply with ONLY the exact path returned by the tool, nothing else.',
    );
    try {
      const text = await waitForAssistantText(
        readID,
        (candidate) => candidate.includes(SHARED_MEM_ROOT) && candidate.includes(".md"),
        SESSION_TIMEOUT_MS,
      );
      expect(text).toContain(SHARED_MEM_ROOT);
      expect(text).toContain(".md");
    } finally {
      try { runOcm(["delete", readID]); } catch { /* best-effort */ }
    }
  }, SESSION_TIMEOUT_MS);

  it("forget surfaces a TOOL FAILURE when the memory ID does not exist", async () => {
    const sessionID = beginSession(
      'Call forget exactly once with id="mem_definitelynotavalidid_xyzzy". Reply with ONLY the exact tool output, nothing else.',
    );
    try {
      const text = await waitForAssistantText(
        sessionID,
        (candidate) => candidate.includes("TOOL FAILURE"),
        SESSION_TIMEOUT_MS,
      );
      expect(text).toContain("TOOL FAILURE");
      expect(text).not.toContain("Deleted");
    } finally {
      try { runOcm(["delete", sessionID]); } catch { /* best-effort */ }
    }
  }, SESSION_TIMEOUT_MS);
});
