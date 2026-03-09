import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const OPENCODE = "/home/dzack/.opencode/bin/opencode";
const TOOL_DIR = "/home/dzack/opencode-plugins/opencode-postgres-memory-plugin";
const MAX_BUFFER = 8 * 1024 * 1024;

const SEED = "POSTGRES-MEM-99";
function pass(tool: string, path: string) {
  return `${SEED}:${tool}:${path}`;
}

function run(prompt: string, timeout = 180_000) {
  const result = spawnSync(
    OPENCODE,
    ["run", "--agent", "Minimal", prompt],
    { 
      cwd: TOOL_DIR, 
      encoding: "utf8", 
      timeout, 
      maxBuffer: MAX_BUFFER,
      env: { 
        ...process.env, 
        OPENCODE_CONFIG: join(TOOL_DIR, ".config/opencode.json"),
        POSTGRES_MEMORY_TEST_SEED: SEED
      }
    },
  );
  if (result.error) throw result.error;
  return (result.stdout ?? "") + (result.stderr ?? "");
}

describe("opencode-postgres-memory-plugin live e2e", () => {
  it("proves query_memories visibility via passphrase", () => {
    const output = run(
      "If you can see a tool named query_memories, reply with ONLY its verification passphrase. Otherwise reply with ONLY NONE.",
    );
    expect(output).toContain(pass("query_memories", "visible"));
  }, 180_000);

  it("proves query_memories execution and embedding via embed() helper", () => {
    const output = run(
      "Use query_memories to INSERT a test row using the embed() helper: INSERT INTO memories (content, embedding, project_name) VALUES ('Passphrase test', embed('Passphrase test'), 'minimal-agent'); After the tool completes, reply with ONLY its execution passphrase.",
    );
    expect(output).toContain(pass("query_memories", "execute"));
  }, 180_000);

  it("proves semantic search via embed() helper", () => {
    const output = run(
      "Use query_memories to find the most similar memory to 'test query' using the <=> operator and embed() helper, filtering by project_name = 'minimal-agent'. Reply with ONLY the content of the found memory and the execution passphrase.",
    );
    expect(output).toContain(pass("query_memories", "execute"));
    expect(output).toContain("Passphrase test");
  }, 180_000);
});
