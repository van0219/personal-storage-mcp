#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "ssh2";

// --- Configuration from environment ---
const SFTP_HOST = process.env.PS_SFTP_HOST;
const SFTP_PORT = parseInt(process.env.PS_SFTP_PORT || "22");
const SFTP_USERNAME = process.env.PS_SFTP_USERNAME;
const SFTP_PASSWORD = process.env.PS_SFTP_PASSWORD;
const USER_ID = process.env.PS_USER_ID;

if (!SFTP_HOST || !SFTP_USERNAME || !SFTP_PASSWORD || !USER_ID) {
  console.error("Missing required environment variables:");
  console.error("  PS_SFTP_HOST, PS_SFTP_USERNAME, PS_SFTP_PASSWORD, PS_USER_ID");
  process.exit(1);
}

const BASE_PATH = `/FSM_Innovation_Hub/${USER_ID}`;

// --- SFTP Connection Management ---
let sftpClient = null;
let sshConnection = null;

function connectSftp() {
  return new Promise((resolve, reject) => {
    if (sftpClient) { resolve(sftpClient); return; }

    const conn = new Client();
    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) { reject(err); return; }
        sftpClient = sftp;
        sshConnection = conn;
        resolve(sftp);
      });
    });
    conn.on("error", (err) => reject(err));
    conn.on("close", () => { sftpClient = null; sshConnection = null; });
    conn.on("keyboard-interactive", (name, instructions, lang, prompts, finish) => {
      finish([SFTP_PASSWORD]);
    });

    conn.connect({
      host: SFTP_HOST,
      port: SFTP_PORT,
      username: SFTP_USERNAME,
      password: SFTP_PASSWORD,
      tryKeyboard: true,
    });
  });
}

function ensureSandbox(targetPath) {
  // Normalize path and ensure it stays within BASE_PATH
  const normalized = targetPath.replace(/\/+/g, "/").replace(/\/$/, "");
  if (!normalized.startsWith(BASE_PATH)) {
    throw new Error(`Access denied: path must be within ${BASE_PATH}`);
  }
  return normalized;
}

function resolvePath(relativePath) {
  // Convert a relative path (or /) to an absolute sandboxed path
  if (!relativePath || relativePath === "/" || relativePath === ".") {
    return BASE_PATH;
  }
  const clean = relativePath.replace(/^\/+/, "");
  const full = `${BASE_PATH}/${clean}`;
  return ensureSandbox(full);
}

// --- Tool Definitions ---
const TOOLS = [
  {
    name: "ps_list",
    description: "List files and folders in a directory within your personal storage. Returns name, type (file/directory), size, and modification date for each item.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path within your personal storage. Use '/' or omit for root."
        }
      }
    }
  },
  {
    name: "ps_read_file",
    description: "Read the text content of a file from your personal storage.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file within your personal storage."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "ps_write_file",
    description: "Create or overwrite a file in your personal storage with the provided text content.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path for the file within your personal storage."
        },
        content: {
          type: "string",
          description: "Text content to write to the file."
        }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "ps_mkdir",
    description: "Create a new folder in your personal storage.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path for the new folder within your personal storage."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "ps_rename",
    description: "Rename or move a file/folder within your personal storage.",
    inputSchema: {
      type: "object",
      properties: {
        old_path: {
          type: "string",
          description: "Current relative path of the file/folder."
        },
        new_path: {
          type: "string",
          description: "New relative path for the file/folder."
        }
      },
      required: ["old_path", "new_path"]
    }
  },
  {
    name: "ps_delete",
    description: "Delete a file or empty folder from your personal storage.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path of the file/folder to delete."
        },
        is_directory: {
          type: "boolean",
          description: "Set to true if deleting a directory. Default: false."
        }
      },
      required: ["path"]
    }
  }
];

// --- Tool Implementations ---

async function handlePsList(args) {
  const sftp = await connectSftp();
  const dirPath = resolvePath(args.path);

  return new Promise((resolve, reject) => {
    sftp.readdir(dirPath, (err, list) => {
      if (err) { reject(new Error(`Failed to list directory: ${err.message}`)); return; }

      const items = list
        .filter(item => !item.filename.startsWith("."))
        .map(item => ({
          name: item.filename,
          type: item.longname.startsWith("d") ? "directory" : "file",
          size: item.attrs.size,
          modified: new Date(item.attrs.mtime * 1000).toISOString()
        }))
        .sort((a, b) => {
          if (a.type === "directory" && b.type !== "directory") return -1;
          if (a.type !== "directory" && b.type === "directory") return 1;
          return a.name.localeCompare(b.name);
        });

      resolve(items);
    });
  });
}

async function handlePsReadFile(args) {
  const sftp = await connectSftp();
  const filePath = resolvePath(args.path);

  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = sftp.createReadStream(filePath, { encoding: "utf-8" });
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(chunks.join("")));
    stream.on("error", (err) => reject(new Error(`Failed to read file: ${err.message}`)));
  });
}

async function handlePsWriteFile(args) {
  const sftp = await connectSftp();
  const filePath = resolvePath(args.path);

  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(filePath);
    stream.on("close", () => resolve(`File written: ${args.path}`));
    stream.on("error", (err) => reject(new Error(`Failed to write file: ${err.message}`)));
    stream.end(args.content || "");
  });
}

async function handlePsMkdir(args) {
  const sftp = await connectSftp();
  const dirPath = resolvePath(args.path);

  return new Promise((resolve, reject) => {
    sftp.mkdir(dirPath, (err) => {
      if (err) reject(new Error(`Failed to create directory: ${err.message}`));
      else resolve(`Directory created: ${args.path}`);
    });
  });
}

async function handlePsRename(args) {
  const sftp = await connectSftp();
  const oldPath = resolvePath(args.old_path);
  const newPath = resolvePath(args.new_path);

  return new Promise((resolve, reject) => {
    sftp.rename(oldPath, newPath, (err) => {
      if (err) reject(new Error(`Failed to rename: ${err.message}`));
      else resolve(`Renamed: ${args.old_path} → ${args.new_path}`);
    });
  });
}

async function handlePsDelete(args) {
  const sftp = await connectSftp();
  const targetPath = resolvePath(args.path);
  const isDir = args.is_directory || false;

  return new Promise((resolve, reject) => {
    if (isDir) {
      sftp.rmdir(targetPath, (err) => {
        if (err) reject(new Error(`Failed to delete directory: ${err.message}`));
        else resolve(`Directory deleted: ${args.path}`);
      });
    } else {
      sftp.unlink(targetPath, (err) => {
        if (err) reject(new Error(`Failed to delete file: ${err.message}`));
        else resolve(`File deleted: ${args.path}`);
      });
    }
  });
}

// --- MCP Server Setup ---

const server = new Server(
  { name: "personal-storage-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;
    switch (name) {
      case "ps_list":
        result = await handlePsList(args || {});
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      case "ps_read_file":
        result = await handlePsReadFile(args);
        return { content: [{ type: "text", text: result }] };
      case "ps_write_file":
        result = await handlePsWriteFile(args);
        return { content: [{ type: "text", text: result }] };
      case "ps_mkdir":
        result = await handlePsMkdir(args);
        return { content: [{ type: "text", text: result }] };
      case "ps_rename":
        result = await handlePsRename(args);
        return { content: [{ type: "text", text: result }] };
      case "ps_delete":
        result = await handlePsDelete(args);
        return { content: [{ type: "text", text: result }] };
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error) {
    // Reset connection on error so next call reconnects
    if (sshConnection) { try { sshConnection.end(); } catch (e) {} }
    sftpClient = null;
    sshConnection = null;

    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true
    };
  }
});

// --- Start Server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Personal Storage MCP server running (user: ${USER_ID}, base: ${BASE_PATH})`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
