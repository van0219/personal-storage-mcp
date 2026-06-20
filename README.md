# Personal Storage MCP Server

MCP server that provides file operations on your personal SFTP storage space (`/FSM_Innovation_Hub/<user_id>`). Designed for use with Kiro Web's sandbox environment.

## Tools

| Tool | Description |
|------|-------------|
| `ps_list` | List files and folders in a directory (single level) |
| `ps_tree` | Recursively list entire directory tree (with depth control) |
| `ps_read_file` | Read text content of a file (max 5MB) |
| `ps_write_file` | Create or overwrite a file (auto-creates parent directories) |
| `ps_push_files` | Write multiple files in one call (auto-creates directories) |
| `ps_mkdir` | Create a new folder |
| `ps_rename` | Rename or move a file/folder |
| `ps_copy` | Copy a file to a new path (auto-creates destination directories) |
| `ps_delete` | Delete a file or empty folder |
| `ps_delete_recursive` | Recursively delete a directory and all contents |
| `ps_file_exists` | Check if a file/folder exists (returns type and size) |
| `ps_stat` | Get file metadata (size, modified date, type) |

All paths are relative to your personal storage root. Use `/` or omit path for root directory.

## Tool Details

### ps_push_files — Batch Write

Use instead of calling `ps_write_file` repeatedly when creating project scaffolds or writing multiple files.

```json
{
  "files": [
    {"path": "my-project/README.md", "content": "# My Project"},
    {"path": "my-project/src/main.py", "content": "print('hello')"},
    {"path": "my-project/.kiro/steering/rules.md", "content": "# Rules"}
  ]
}
```

Creates `my-project/`, `my-project/src/`, and `my-project/.kiro/steering/` automatically.

### ps_tree — Recursive Listing

Returns a flat list of all files and folders with relative paths. Useful for understanding project structure.

```json
{"path": "my-project", "max_depth": 3}
```

Returns:
```json
[
  {"path": "README.md", "type": "file", "size": 42},
  {"path": "src", "type": "directory", "size": null},
  {"path": "src/main.py", "type": "file", "size": 156}
]
```

### ps_delete_recursive — Destructive Delete

Requires `confirm: true` to proceed. Deletes all files and subdirectories within the target.

```json
{"path": "old-project", "confirm": true}
```

### ps_file_exists — Quick Check

Returns existence and metadata without reading file content.

```json
{"path": "my-project/config.json"}
```

Returns `{"exists": true, "type": "file", "size": 234, "modified": "..."}` or `{"exists": false}`.

## Behavioral Notes

- **Auto-mkdir**: Both `ps_write_file` and `ps_push_files` automatically create parent directories. No need to call `ps_mkdir` first.
- **File size guard**: `ps_read_file` rejects files over 5MB. Use `ps_stat` to check size before reading large files.
- **Connection keepalive**: SSH connection pings every 15 seconds to prevent idle timeouts.
- **Auto-reconnect**: On connection errors, the server resets and reconnects on the next tool call.
- **Sandbox enforced**: All paths are resolved within `/FSM_Innovation_Hub/<user_id>`. Escape attempts are blocked.

## Kiro Web Setup

### 1. Environment Variables

In Kiro Web → Settings → Agent → Sandbox → **Environment variables**, add:

| Variable | Value |
|----------|-------|
| `PS_USER_ID` | Your user ID (e.g., `vsilleza`) |

### 2. Secrets

In Kiro Web → Settings → Agent → Sandbox → **Secrets**, add:

| Secret | Value |
|--------|-------|
| `PS_SFTP_HOST` | `sftp.inforcloudsuite.com` |
| `PS_SFTP_USERNAME` | SFTP username |
| `PS_SFTP_PASSWORD` | SFTP password |

### 3. MCP Server

In Kiro Web → Settings → Agent → Sandbox → **MCP server settings**, click "Add server":

- **Name**: `personal-storage`
- **Command**: `npx`
- **Args**: `-y github:van0219/personal-storage-mcp`
- **Environment variables**:
  - `PS_SFTP_HOST` = `${PS_SFTP_HOST}`
  - `PS_SFTP_PORT` = `22`
  - `PS_SFTP_USERNAME` = `${PS_SFTP_USERNAME}`
  - `PS_SFTP_PASSWORD` = `${PS_SFTP_PASSWORD}`
  - `PS_USER_ID` = `${PS_USER_ID}`

> Note: The `${VAR}` syntax references the secrets/variables you configured above.

### 4. Network Configuration

Ensure "Open internet" access is enabled (or at minimum, allow `sftp.inforcloudsuite.com:22`).

## Local Testing

```bash
cd personal-storage-mcp
npm install

# Set environment variables
export PS_SFTP_HOST=sftp.inforcloudsuite.com
export PS_SFTP_PORT=22
export PS_SFTP_USERNAME=your-username
export PS_SFTP_PASSWORD=your-password
export PS_USER_ID=your-user-id

npm start
```

## Security

- All operations are sandboxed to `/FSM_Innovation_Hub/<user_id>` — no escape possible
- Hidden files (starting with `.`) are filtered from listings
- Connection auto-reconnects on errors
- Credentials are never logged or exposed through tool responses
- `ps_delete_recursive` requires explicit `confirm: true` safety flag

## Publishing to GitHub

```bash
cd personal-storage-mcp
git init
git add .
git commit -m "v1.1.0: Add ps_tree, ps_copy, ps_stat, ps_file_exists, ps_delete_recursive, batch write, keepalive"
git remote add origin https://github.com/van0219/personal-storage-mcp.git
git push -u origin main
```

After pushing, the server is accessible via `npx -y github:van0219/personal-storage-mcp`.
