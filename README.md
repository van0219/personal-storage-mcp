# Personal Storage MCP Server

MCP server that provides file operations on your personal SFTP storage space (`/FSM_Innovation_Hub/<user_id>`). Designed for use with Kiro Web's sandbox environment.

## Tools

| Tool | Description |
|------|-------------|
| `ps_list` | List files and folders in a directory |
| `ps_read_file` | Read text content of a file |
| `ps_write_file` | Create or overwrite a file with text content |
| `ps_mkdir` | Create a new folder |
| `ps_rename` | Rename or move a file/folder |
| `ps_delete` | Delete a file or empty folder |

All paths are relative to your personal storage root. Use `/` or omit path for root directory.

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

## Publishing to GitHub

```bash
cd personal-storage-mcp
git init
git add .
git commit -m "Initial commit: Personal Storage MCP server"
git remote add origin https://github.com/van0219/personal-storage-mcp.git
git push -u origin main
```

After pushing, the server is accessible via `npx -y github:van0219/personal-storage-mcp`.
