#!/usr/bin/env node

// MCP server that wraps the Claude Code SDK.
// Communicates via JSON-RPC 2.0 over stdin/stdout (stdio transport).
// OpenClaw spawns this as a child process and sends tool calls to it.

import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import readline from "node:readline";

const WORKSPACE_ROOT = process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace";
const MAX_TURNS = 25;
const TASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Ensure workspace exists.
try {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
} catch {
  // best-effort
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: "run_task",
    description:
      "Run a coding task using Claude Code. Provide a natural language prompt describing what to build, fix, or modify. " +
      "Claude Code operates on files in the shared workspace and can read, write, edit files, run shell commands, and use git.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The coding task to perform" },
        working_directory: {
          type: "string",
          description:
            "Subdirectory within the workspace to operate in (e.g. 'my-project'). Defaults to workspace root.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "list_projects",
    description: "List all repositories and projects in the shared workspace directory.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "clone_repo",
    description: "Clone a git repository into the shared workspace.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Git repository URL to clone (HTTPS or git@)" },
        name: { type: "string", description: "Optional directory name for the clone" },
      },
      required: ["url"],
    },
  },
];

// --- Tool handlers ---

async function handleRunTask(args) {
  const { prompt, working_directory } = args;
  if (!prompt) throw new Error("Missing required parameter: prompt");

  let cwd = WORKSPACE_ROOT;
  if (working_directory) {
    cwd = path.resolve(WORKSPACE_ROOT, working_directory);
    // Path traversal guard
    if (!cwd.startsWith(WORKSPACE_ROOT)) {
      throw new Error("working_directory must be within the workspace");
    }
  }

  fs.mkdirSync(cwd, { recursive: true });

  // Dynamically import Claude Code SDK
  let claude;
  try {
    const mod = await import("@anthropic-ai/claude-code");
    claude = mod.claude || mod.default;
  } catch (err) {
    throw new Error(`Failed to load Claude Code SDK: ${err.message}`);
  }

  // Run with timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TASK_TIMEOUT_MS);

  try {
    const messages = [];
    let finalResult = "";

    for await (const event of claude(prompt, {
      cwd,
      maxTurns: MAX_TURNS,
      abortController: controller,
      allowedTools: [
        "Read", "Write", "Edit", "MultiEdit",
        "Bash", "Glob", "Grep",
        "TodoRead", "TodoWrite",
      ],
    })) {
      // Collect assistant text from the stream
      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text") {
            finalResult += block.text + "\n";
          }
        }
      }
    }

    return finalResult.trim() || "(task completed with no text output)";
  } finally {
    clearTimeout(timeout);
  }
}

function handleListProjects() {
  let entries;
  try {
    entries = fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true });
  } catch (err) {
    throw new Error(`Cannot read workspace directory: ${err.message}`);
  }

  const projects = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => {
      const isGitRepo = fs.existsSync(path.join(WORKSPACE_ROOT, e.name, ".git"));
      return { name: e.name, isGitRepo };
    });

  return JSON.stringify({ workspace: WORKSPACE_ROOT, projects }, null, 2);
}

async function handleCloneRepo(args) {
  const { url, name } = args;
  if (!url) throw new Error("Missing required parameter: url");

  if (!/^https?:\/\//.test(url) && !url.startsWith("git@")) {
    throw new Error("URL must be an HTTP(S) or git@ URL");
  }

  const dirName = name || url.split("/").pop().replace(/\.git$/, "");
  if (!dirName || !/^[A-Za-z0-9._-]+$/.test(dirName)) {
    throw new Error("Invalid directory name derived from URL. Provide a 'name' parameter.");
  }

  const targetDir = path.join(WORKSPACE_ROOT, dirName);
  if (fs.existsSync(targetDir)) {
    throw new Error(`Directory '${dirName}' already exists in workspace`);
  }

  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn("git", ["clone", "--depth", "1", url, targetDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    proc.stdout?.on("data", (d) => (output += d));
    proc.stderr?.on("data", (d) => (output += d));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(`Cloned ${url} into ${dirName}\n${output.trim()}`);
      } else {
        reject(new Error(`git clone failed (exit ${code}): ${output.trim()}`));
      }
    });
  });
}

// --- MCP JSON-RPC protocol ---

function makeResponse(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function makeError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return makeResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: {
        name: "claude-code-mcp",
        version: "1.0.0",
      },
    });
  }

  if (method === "notifications/initialized") {
    // No response needed for notifications
    return null;
  }

  if (method === "tools/list") {
    return makeResponse(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    try {
      let result;
      switch (toolName) {
        case "run_task":
          result = await handleRunTask(toolArgs);
          break;
        case "list_projects":
          result = handleListProjects();
          break;
        case "clone_repo":
          result = await handleCloneRepo(toolArgs);
          break;
        default:
          return makeError(id, -32601, `Unknown tool: ${toolName}`);
      }
      return makeResponse(id, {
        content: [{ type: "text", text: String(result) }],
      });
    } catch (err) {
      return makeResponse(id, {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      });
    }
  }

  return makeError(id, -32601, `Method not found: ${method}`);
}

// --- Stdio transport ---

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  if (!line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(makeError(null, -32700, "Parse error") + "\n");
    return;
  }

  const response = await handleMessage(msg);
  if (response !== null) {
    process.stdout.write(response + "\n");
  }
});

rl.on("close", () => {
  process.exit(0);
});

// Log to stderr only (stdout is reserved for MCP protocol)
process.stderr.write("[claude-code-mcp] server started\n");
process.stderr.write(`[claude-code-mcp] workspace: ${WORKSPACE_ROOT}\n`);
