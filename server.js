#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client } from "ssh2";
import { readFileSync, statSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

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
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      readyTimeout: 15000,
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
  // Strip leading slashes, normalize double slashes
  let clean = relativePath.replace(/^\/+/, "").replace(/\/+/g, "/");
  // Resolve .. and . segments to prevent traversal
  const parts = clean.split("/");
  const resolved = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") { resolved.pop(); continue; }
    resolved.push(part);
  }
  if (resolved.length === 0) return BASE_PATH;
  const full = `${BASE_PATH}/${resolved.join("/")}`;
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
  },
  {
    name: "ps_push_files",
    description: "Write multiple files in a single operation. Automatically creates any missing parent directories. Use this instead of calling ps_write_file repeatedly when creating project scaffolds or writing multiple files at once.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          description: "Array of files to write. Each item has a relative path and text content.",
          items: {
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
        }
      },
      required: ["files"]
    }
  },
  {
    name: "ps_tree",
    description: "Recursively list the entire directory tree within a path. Returns a flat list of all files and folders with their relative paths, types, and sizes. Useful for understanding project structure at a glance.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to list recursively. Use '/' or omit for root."
        },
        max_depth: {
          type: "number",
          description: "Maximum depth to recurse. Default: 10. Use -1 for unlimited."
        }
      }
    }
  },
  {
    name: "ps_file_exists",
    description: "Check if a file or folder exists at the given path. Returns exists (boolean), type (file/directory), and size.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to check."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "ps_delete_recursive",
    description: "Recursively delete a directory and all its contents (files and subdirectories). Use with caution.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path of the directory to delete recursively."
        },
        confirm: {
          type: "boolean",
          description: "Must be set to true to confirm destructive operation."
        }
      },
      required: ["path", "confirm"]
    }
  },
  {
    name: "ps_copy",
    description: "Copy a file within your personal storage to a new path. Automatically creates parent directories for the destination.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Relative path of the source file."
        },
        destination: {
          type: "string",
          description: "Relative path for the copy destination."
        }
      },
      required: ["source", "destination"]
    }
  },
  {
    name: "ps_stat",
    description: "Get metadata (size, modification date, type) for a file or folder without reading its content.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path of the file or folder."
        }
      },
      required: ["path"]
    }
  },
  {
    name: "ps_append",
    description: "Append text content to an existing file. Creates the file if it doesn't exist. Use this to write large files in chunks when ps_write_file hits size limits. Call ps_write_file first with the initial content, then ps_append for subsequent chunks.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file within your personal storage."
        },
        content: {
          type: "string",
          description: "Text content to append to the end of the file."
        }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "ps_upload_from_sandbox",
    description: "Upload a file from your local sandbox/workspace filesystem directly to personal storage. This bypasses content size limits since the server reads the file directly from disk. Use this for large files (>10KB) that cannot be passed as tool parameters. The sandbox_path should be an absolute path in your workspace (e.g., '/projects/sandbox/myfile.py').",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_path: {
          type: "string",
          description: "Absolute path to the file in your local sandbox/workspace filesystem."
        },
        dest_path: {
          type: "string",
          description: "Relative destination path within your personal storage."
        }
      },
      required: ["sandbox_path", "dest_path"]
    }
  },
  {
    name: "ps_upload_dir_from_sandbox",
    description: "Recursively upload an entire directory from your local sandbox/workspace filesystem to personal storage. Use this instead of copying files one by one. All files and subdirectories are preserved. Existing files at the destination are overwritten.",
    inputSchema: {
      type: "object",
      properties: {
        sandbox_path: {
          type: "string",
          description: "Absolute path to the directory in your local sandbox/workspace filesystem."
        },
        dest_path: {
          type: "string",
          description: "Relative destination path within your personal storage."
        }
      },
      required: ["sandbox_path", "dest_path"]
    }
  },
  {
    name: "ps_download_to_sandbox",
    description: "Download a file from personal storage directly to your local sandbox/workspace filesystem. This bypasses MCP text parameter limits and preserves binary content (docx, xlsx, pdf, images, etc.). Use this for any file that needs to be processed locally by scripts or tools.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file within your personal storage."
        },
        sandbox_path: {
          type: "string",
          description: "Absolute destination path in your local sandbox/workspace filesystem (e.g., '/home/user/project/Temp/myfile.docx')."
        }
      },
      required: ["path", "sandbox_path"]
    }
  },
  {
    name: "ps_download_dir_to_sandbox",
    description: "Recursively download an entire directory from personal storage to your local sandbox/workspace filesystem. Preserves all files and subdirectories with their binary content intact. Use this to bring a full folder of inputs to the sandbox for local processing.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the directory within your personal storage."
        },
        sandbox_path: {
          type: "string",
          description: "Absolute destination path in your local sandbox/workspace filesystem (e.g., '/home/user/project/Temp/inputs/')."
        }
      },
      required: ["path", "sandbox_path"]
    }
  }
];

// --- Shared Helpers ---

const _createdDirsCache = new Set();

async function mkdirRecursive(sftp, dirPath) {
  if (_createdDirsCache.has(dirPath) || dirPath === BASE_PATH || !dirPath) return;
  const exists = await new Promise((resolve) => {
    sftp.stat(dirPath, (err, stats) => {
      if (!err && stats) resolve(true); else resolve(false);
    });
  });
  if (exists) { _createdDirsCache.add(dirPath); return; }
  const parent = dirPath.substring(0, dirPath.lastIndexOf("/"));
  if (parent && parent !== dirPath) await mkdirRecursive(sftp, parent);
  await new Promise((resolve, reject) => {
    sftp.mkdir(dirPath, (err) => {
      if (err && err.code !== 4) reject(new Error(`mkdir ${dirPath}: ${err.message}`));
      else resolve();
    });
  });
  _createdDirsCache.add(dirPath);
}

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

  // Size guard: reject files over 5MB to prevent memory issues
  const stats = await new Promise((resolve, reject) => {
    sftp.stat(filePath, (err, s) => {
      if (err) reject(new Error(`File not found: ${err.message}`));
      else resolve(s);
    });
  });
  const MAX_READ_SIZE = 5 * 1024 * 1024; // 5MB
  if (stats.size > MAX_READ_SIZE) {
    throw new Error(`File too large to read (${(stats.size / 1024 / 1024).toFixed(1)}MB). Maximum is 5MB. Use ps_stat to check size first.`);
  }

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

  // Auto-create parent directories if they don't exist
  const dirPath = filePath.substring(0, filePath.lastIndexOf("/"));
  await mkdirRecursive(sftp, dirPath);

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

  // Use recursive mkdir to handle nested paths like "a/b/c"
  await mkdirRecursive(sftp, dirPath);
  return `Directory created: ${args.path}`;
}

async function handlePsRename(args) {
  const sftp = await connectSftp();
  const oldPath = resolvePath(args.old_path);
  const newPath = resolvePath(args.new_path);

  // Auto-create destination parent directory
  const destDir = newPath.substring(0, newPath.lastIndexOf("/"));
  await mkdirRecursive(sftp, destDir);

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

  if (isDir) {
    // Recursive delete for directories (handles non-empty)
    async function deleteDir(dirPath) {
      const items = await new Promise((resolve, reject) => {
        sftp.readdir(dirPath, (err, list) => {
          if (err) reject(new Error(err.message));
          else resolve(list || []);
        });
      });
      for (const item of items) {
        const fullPath = `${dirPath}/${item.filename}`;
        if (item.longname.startsWith("d")) {
          await deleteDir(fullPath);
        } else {
          await new Promise((resolve, reject) => {
            sftp.unlink(fullPath, (err) => {
              if (err) reject(new Error(err.message));
              else resolve();
            });
          });
        }
      }
      await new Promise((resolve, reject) => {
        sftp.rmdir(dirPath, (err) => {
          if (err) reject(new Error(err.message));
          else resolve();
        });
      });
    }
    await deleteDir(targetPath);
    // Clear cached dirs
    for (const cached of _createdDirsCache) {
      if (cached.startsWith(targetPath)) _createdDirsCache.delete(cached);
    }
    return `Directory deleted: ${args.path}`;
  } else {
    return new Promise((resolve, reject) => {
      sftp.unlink(targetPath, (err) => {
        if (err) reject(new Error(`Failed to delete file: ${err.message}`));
        else resolve(`File deleted: ${args.path}`);
      });
    });
  }
}

async function handlePsPushFiles(args) {
  const sftp = await connectSftp();
  const files = args.files || [];
  if (files.length === 0) return "No files to write.";

  // Write each file
  const results = [];
  for (const file of files) {
    const filePath = resolvePath(file.path);
    const dirPath = filePath.substring(0, filePath.lastIndexOf("/"));
    // Ensure directory exists
    await mkdirRecursive(sftp, dirPath);
    // Write the file
    await new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(filePath);
      stream.on("close", () => resolve());
      stream.on("error", (err) => reject(new Error(`write ${file.path}: ${err.message}`)));
      stream.end(file.content || "");
    });
    results.push(file.path);
  }

  return `Successfully wrote ${results.length} file(s):\n${results.map(f => `  ✓ ${f}`).join("\n")}`;
}

async function handlePsTree(args) {
  const sftp = await connectSftp();
  const dirPath = resolvePath(args.path);
  const maxDepth = args.max_depth === undefined ? 10 : (args.max_depth === -1 ? Infinity : args.max_depth);

  const tree = [];

  async function walk(currentPath, relativeTo, depth) {
    if (depth > maxDepth) return;
    const items = await new Promise((resolve, reject) => {
      sftp.readdir(currentPath, (err, list) => {
        if (err) { reject(new Error(err.message)); return; }
        resolve(list || []);
      });
    });

    for (const item of items) {
      if (item.filename.startsWith(".")) continue;
      const fullPath = `${currentPath}/${item.filename}`;
      const relPath = fullPath.substring(relativeTo.length + 1);
      const isDir = item.longname.startsWith("d");
      tree.push({
        path: relPath,
        type: isDir ? "directory" : "file",
        size: isDir ? null : item.attrs.size
      });
      if (isDir) {
        await walk(fullPath, relativeTo, depth + 1);
      }
    }
  }

  await walk(dirPath, dirPath, 1);
  return tree;
}

async function handlePsFileExists(args) {
  const sftp = await connectSftp();
  const targetPath = resolvePath(args.path);

  return new Promise((resolve) => {
    sftp.stat(targetPath, (err, stats) => {
      if (err) {
        resolve({ exists: false });
      } else {
        resolve({
          exists: true,
          type: stats.isDirectory() ? "directory" : "file",
          size: stats.size,
          modified: new Date(stats.mtime * 1000).toISOString()
        });
      }
    });
  });
}

async function handlePsDeleteRecursive(args) {
  if (!args.confirm) {
    throw new Error("You must set confirm: true to perform recursive deletion.");
  }

  const sftp = await connectSftp();
  const targetPath = resolvePath(args.path);

  // Ensure we're not deleting the base path itself
  if (targetPath === BASE_PATH) {
    throw new Error("Cannot delete the root storage directory.");
  }

  async function deleteDir(dirPath) {
    const items = await new Promise((resolve, reject) => {
      sftp.readdir(dirPath, (err, list) => {
        if (err) reject(new Error(err.message));
        else resolve(list || []);
      });
    });

    for (const item of items) {
      const fullPath = `${dirPath}/${item.filename}`;
      if (item.longname.startsWith("d")) {
        await deleteDir(fullPath);
      } else {
        await new Promise((resolve, reject) => {
          sftp.unlink(fullPath, (err) => {
            if (err) reject(new Error(`unlink ${fullPath}: ${err.message}`));
            else resolve();
          });
        });
      }
    }

    // Now remove the empty directory
    await new Promise((resolve, reject) => {
      sftp.rmdir(dirPath, (err) => {
        if (err) reject(new Error(`rmdir ${dirPath}: ${err.message}`));
        else resolve();
      });
    });
  }

  await deleteDir(targetPath);
  // Clear cached dirs that were inside the deleted path
  for (const cached of _createdDirsCache) {
    if (cached.startsWith(targetPath)) _createdDirsCache.delete(cached);
  }
  return `Recursively deleted: ${args.path}`;
}

async function handlePsCopy(args) {
  const sftp = await connectSftp();
  const srcPath = resolvePath(args.source);
  const destPath = resolvePath(args.destination);

  // Check if source is a file or directory
  const srcStats = await new Promise((resolve, reject) => {
    sftp.stat(srcPath, (err, stats) => {
      if (err) reject(new Error(`Source not found: ${err.message}`));
      else resolve(stats);
    });
  });

  if (srcStats.isDirectory()) {
    // Recursive directory copy
    async function copyDir(src, dest) {
      await mkdirRecursive(sftp, dest);
      const items = await new Promise((resolve, reject) => {
        sftp.readdir(src, (err, list) => {
          if (err) reject(new Error(err.message));
          else resolve(list || []);
        });
      });
      for (const item of items) {
        const srcItem = `${src}/${item.filename}`;
        const destItem = `${dest}/${item.filename}`;
        if (item.longname.startsWith("d")) {
          await copyDir(srcItem, destItem);
        } else {
          const content = await new Promise((resolve, reject) => {
            const chunks = [];
            const stream = sftp.createReadStream(srcItem);
            stream.on("data", (chunk) => chunks.push(chunk));
            stream.on("end", () => resolve(Buffer.concat(chunks)));
            stream.on("error", (err) => reject(new Error(err.message)));
          });
          await new Promise((resolve, reject) => {
            const stream = sftp.createWriteStream(destItem);
            stream.on("close", () => resolve());
            stream.on("error", (err) => reject(new Error(err.message)));
            stream.end(content);
          });
        }
      }
    }
    await copyDir(srcPath, destPath);
    return `Copied directory: ${args.source} → ${args.destination}`;
  } else {
    // Single file copy
    const destDir = destPath.substring(0, destPath.lastIndexOf("/"));
    await mkdirRecursive(sftp, destDir);

    const content = await new Promise((resolve, reject) => {
      const chunks = [];
      const stream = sftp.createReadStream(srcPath);
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", (err) => reject(new Error(`Read failed: ${err.message}`)));
    });

    await new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(destPath);
      stream.on("close", () => resolve());
      stream.on("error", (err) => reject(new Error(`Write failed: ${err.message}`)));
      stream.end(content);
    });

    return `Copied: ${args.source} → ${args.destination}`;
  }
}

async function handlePsStat(args) {
  const sftp = await connectSftp();
  const targetPath = resolvePath(args.path);

  return new Promise((resolve, reject) => {
    sftp.stat(targetPath, (err, stats) => {
      if (err) reject(new Error(`Failed to stat: ${err.message}`));
      else resolve({
        path: args.path,
        type: stats.isDirectory() ? "directory" : "file",
        size: stats.size,
        modified: new Date(stats.mtime * 1000).toISOString(),
        accessed: new Date(stats.atime * 1000).toISOString()
      });
    });
  });
}

async function handlePsAppend(args) {
  const sftp = await connectSftp();
  const filePath = resolvePath(args.path);

  // Auto-create parent directories
  const dirPath = filePath.substring(0, filePath.lastIndexOf("/"));
  await mkdirRecursive(sftp, dirPath);

  // Check if file exists to determine flags
  const exists = await new Promise((resolve) => {
    sftp.stat(filePath, (err) => resolve(!err));
  });

  if (!exists) {
    // Create new file
    return new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(filePath);
      stream.on("close", () => resolve(`File created and content written: ${args.path}`));
      stream.on("error", (err) => reject(new Error(`Failed to write: ${err.message}`)));
      stream.end(args.content || "");
    });
  }

  // Read existing content, append new content
  const existing = await new Promise((resolve, reject) => {
    const chunks = [];
    const stream = sftp.createReadStream(filePath);
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (err) => reject(new Error(`Read failed: ${err.message}`)));
  });

  const combined = Buffer.concat([existing, Buffer.from(args.content || "", "utf-8")]);

  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(filePath);
    stream.on("close", () => resolve(`Content appended to: ${args.path} (now ${combined.length} bytes)`));
    stream.on("error", (err) => reject(new Error(`Write failed: ${err.message}`)));
    stream.end(combined);
  });
}

async function handlePsUploadFromSandbox(args) {
  const sftp = await connectSftp();
  const destPath = resolvePath(args.dest_path);
  const sandboxPath = args.sandbox_path;

  // Validate sandbox path exists
  let fileContent;
  try {
    fileContent = readFileSync(sandboxPath);
  } catch (err) {
    throw new Error(`Cannot read sandbox file "${sandboxPath}": ${err.message}`);
  }

  // Auto-create parent directories
  const dirPath = destPath.substring(0, destPath.lastIndexOf("/"));
  await mkdirRecursive(sftp, dirPath);

  // Write to SFTP
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(destPath);
    stream.on("close", () => resolve(`Uploaded ${sandboxPath} → ${args.dest_path} (${fileContent.length} bytes)`));
    stream.on("error", (err) => reject(new Error(`Upload failed: ${err.message}`)));
    stream.end(fileContent);
  });
}

async function handlePsUploadDirFromSandbox(args) {
  const sftp = await connectSftp();
  const destBasePath = resolvePath(args.dest_path);
  const sandboxPath = args.sandbox_path;

  // Validate sandbox path is a directory
  let stats;
  try {
    stats = statSync(sandboxPath);
  } catch (err) {
    throw new Error(`Cannot access sandbox path "${sandboxPath}": ${err.message}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`"${sandboxPath}" is not a directory. Use ps_upload_from_sandbox for single files.`);
  }

  // Recursively walk the sandbox directory and upload all files
  let uploadedCount = 0;
  let totalBytes = 0;

  async function uploadDir(localDir, remoteDir) {
    await mkdirRecursive(sftp, remoteDir);

    const entries = readdirSync(localDir, { withFileTypes: true });
    for (const entry of entries) {
      // Skip hidden files/folders
      if (entry.name.startsWith(".")) continue;

      const localPath = join(localDir, entry.name);
      const remotePath = `${remoteDir}/${entry.name}`;

      if (entry.isDirectory()) {
        await uploadDir(localPath, remotePath);
      } else if (entry.isFile()) {
        const content = readFileSync(localPath);
        await new Promise((resolve, reject) => {
          const stream = sftp.createWriteStream(remotePath);
          stream.on("close", () => resolve());
          stream.on("error", (err) => reject(new Error(`Upload ${entry.name}: ${err.message}`)));
          stream.end(content);
        });
        uploadedCount++;
        totalBytes += content.length;
      }
    }
  }

  await uploadDir(sandboxPath, destBasePath);
  return `Uploaded directory: ${args.sandbox_path} → ${args.dest_path}\n  Files: ${uploadedCount}\n  Total size: ${(totalBytes / 1024).toFixed(1)} KB`;
}

async function handlePsDownloadToSandbox(args) {
  const sftp = await connectSftp();
  const srcPath = resolvePath(args.path);
  const sandboxPath = args.sandbox_path;

  // Ensure local parent directory exists
  const parentDir = dirname(sandboxPath);
  try {
    mkdirSync(parentDir, { recursive: true });
  } catch (err) {
    throw new Error(`Cannot create local directory "${parentDir}": ${err.message}`);
  }

  // Download file from SFTP as binary buffer
  const content = await new Promise((resolve, reject) => {
    const chunks = [];
    const stream = sftp.createReadStream(srcPath);
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (err) => reject(new Error(`Failed to read from personal storage: ${err.message}`)));
  });

  // Write to local sandbox filesystem
  try {
    writeFileSync(sandboxPath, content);
  } catch (err) {
    throw new Error(`Cannot write to sandbox path "${sandboxPath}": ${err.message}`);
  }

  return `Downloaded ${args.path} → ${sandboxPath} (${content.length} bytes)`;
}

async function handlePsDownloadDirToSandbox(args) {
  const sftp = await connectSftp();
  const srcPath = resolvePath(args.path);
  const sandboxPath = args.sandbox_path;

  // Verify source is a directory on SFTP
  const srcStats = await new Promise((resolve, reject) => {
    sftp.stat(srcPath, (err, stats) => {
      if (err) reject(new Error(`Source not found on personal storage: ${err.message}`));
      else resolve(stats);
    });
  });

  if (!srcStats.isDirectory()) {
    throw new Error(`"${args.path}" is not a directory. Use ps_download_to_sandbox for single files.`);
  }

  // Ensure local base directory exists
  try {
    mkdirSync(sandboxPath, { recursive: true });
  } catch (err) {
    throw new Error(`Cannot create local directory "${sandboxPath}": ${err.message}`);
  }

  let downloadedCount = 0;
  let totalBytes = 0;

  async function downloadDir(remoteDirPath, localDirPath) {
    // Ensure local directory exists
    mkdirSync(localDirPath, { recursive: true });

    const items = await new Promise((resolve, reject) => {
      sftp.readdir(remoteDirPath, (err, list) => {
        if (err) reject(new Error(`Failed to list ${remoteDirPath}: ${err.message}`));
        else resolve(list || []);
      });
    });

    for (const item of items) {
      if (item.filename.startsWith(".")) continue;

      const remotePath = `${remoteDirPath}/${item.filename}`;
      const localPath = join(localDirPath, item.filename);

      if (item.longname.startsWith("d")) {
        await downloadDir(remotePath, localPath);
      } else {
        // Download file
        const content = await new Promise((resolve, reject) => {
          const chunks = [];
          const stream = sftp.createReadStream(remotePath);
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("end", () => resolve(Buffer.concat(chunks)));
          stream.on("error", (err) => reject(new Error(`Read ${item.filename}: ${err.message}`)));
        });

        writeFileSync(localPath, content);
        downloadedCount++;
        totalBytes += content.length;
      }
    }
  }

  await downloadDir(srcPath, sandboxPath);
  return `Downloaded directory: ${args.path} → ${sandboxPath}\n  Files: ${downloadedCount}\n  Total size: ${(totalBytes / 1024).toFixed(1)} KB`;
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
      case "ps_push_files":
        result = await handlePsPushFiles(args);
        return { content: [{ type: "text", text: result }] };
      case "ps_tree":
        result = await handlePsTree(args || {});
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      case "ps_file_exists":
        result = await handlePsFileExists(args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      case "ps_delete_recursive":
        result = await handlePsDeleteRecursive(args);
        return { content: [{ type: "text", text: result }] };
      case "ps_copy":
        result = await handlePsCopy(args);
        return { content: [{ type: "text", text: result }] };
      case "ps_stat":
        result = await handlePsStat(args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      case "ps_append":
        result = await handlePsAppend(args);
        return { content: [{ type: "text", text: result }] };
      case "ps_upload_from_sandbox":
        result = await handlePsUploadFromSandbox(args);
        return { content: [{ type: "text", text: result }] };
      case "ps_upload_dir_from_sandbox":
        result = await handlePsUploadDirFromSandbox(args);
        return { content: [{ type: "text", text: result }] };
      case "ps_download_to_sandbox":
        result = await handlePsDownloadToSandbox(args);
        return { content: [{ type: "text", text: result }] };
      case "ps_download_dir_to_sandbox":
        result = await handlePsDownloadDirToSandbox(args);
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
