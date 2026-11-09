# Install

## Requirements

- Node.js 20 or newer. Check with `node --version`.
- A Chrome-family browser for the one-time sign-in: Google Chrome, Chromium, Brave, or Microsoft
  Edge.
- An Overleaf account with access to the projects you want to work on.

## 1. Sign in once

```bash
npx overleaf-web-mcp login
```

A dedicated browser window opens with its own profile, separate from your everyday browser.
Complete the normal Overleaf sign-in, including SSO or two-factor authentication if your account
uses them. The window closes by itself once the session is detected.

Only cookies for the Overleaf origin are saved. On macOS and Linux the file is readable by your
user alone. The command prints a short JSON summary ending in `"authenticated": true` when it
worked. See [configuration](configuration.md#where-the-session-is-stored) for the exact paths.

## 2. Connect your MCP client

Using only the command line or the TypeScript library? Skip to
[without an MCP client](#without-an-mcp-client).

=== "Claude Code"

    One command registers the server for every project on this machine:

    ```bash
    claude mcp add overleaf --scope user -- npx -y overleaf-web-mcp serve
    ```

    `claude mcp remove overleaf` undoes it.

=== "Codex"

    One command adds the server to `~/.codex/config.toml` for every project:

    ```bash
    codex mcp add overleaf -- npx -y overleaf-web-mcp serve
    ```

    `codex mcp remove overleaf` undoes it. The command writes this entry, which you can also add
    to `config.toml` by hand:

    ```toml
    [mcp_servers.overleaf]
    command = "npx"
    args = ["-y", "overleaf-web-mcp", "serve"]
    ```

=== "Claude Desktop"

    Add the server to `claude_desktop_config.json`. On macOS it is at
    `~/Library/Application Support/Claude/claude_desktop_config.json`; on Windows at
    `%APPDATA%\Claude\claude_desktop_config.json`.

    ```json
    {
      "mcpServers": {
        "overleaf": {
          "command": "npx",
          "args": ["-y", "overleaf-web-mcp", "serve"]
        }
      }
    }
    ```

=== "Cursor"

    Add the same block to `~/.cursor/mcp.json` for all projects, or to `.cursor/mcp.json` inside
    one project.

    ```json
    {
      "mcpServers": {
        "overleaf": {
          "command": "npx",
          "args": ["-y", "overleaf-web-mcp", "serve"]
        }
      }
    }
    ```

=== "VS Code"

    Create `.vscode/mcp.json` in your workspace. VS Code uses a `servers` key and an explicit
    transport type.

    ```json
    {
      "servers": {
        "overleaf": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "overleaf-web-mcp", "serve"]
        }
      }
    }
    ```

=== "Any other client"

    The server speaks MCP over stdio. Start it with `npx -y overleaf-web-mcp serve`; `serve` is
    the default and can be omitted. It accepts clients on the 2025-era protocol versions
    (2024-10-07 through 2025-11-25) and on 2026-07-28. It sends usage instructions when a client
    connects, in the `initialize` result or, on 2026-07-28, the `server/discover` result, and
    every tool description is self-contained.

## 3. Restart and check

Restart the client so it starts the server, then ask it to check your Overleaf connection. That
runs `auth_status`, which reports the account's project count without exposing anything else.
From a shell, `npx overleaf-web-mcp call auth_status` runs the same check and exits 0.

If something does not work, `npx overleaf-web-mcp doctor <projectId>` checks, read-only, each
step from the saved session to joining a project's root document, and names the first one that
fails; see [checking an install](cli.md#checking-an-install).

## Compatibility

The server answers the 2025-era MCP protocol versions, 2024-10-07 through 2025-11-25, with an
`initialize` handshake, and 2026-07-28 with `server/discover`. The test suite drives both eras
through the real stdio server over piped streams, a 2025-11-25 client and a 2026-07-28 client,
and checks that each receives the usage instructions, lists every tool, and sees nothing on stdout
but JSON-RPC.

MCP clients checked by hand against a real Overleaf account:

| Client | Version | Negotiated protocol | Checked on |
| --- | --- | --- | --- |

## Without an MCP client

Skip steps 2 and 3. Once you have signed in, every tool is also a command:

```bash
npx overleaf-web-mcp call auth_status
npx overleaf-web-mcp projects list
```

For regular use, install the package once so commands start without `npx`:

```bash
npm install -g overleaf-web-mcp
overleaf-web-mcp --help
```

The [command line guide](cli.md) covers every command, its output, and its exit codes, and the
[TypeScript SDK](sdk.md) page covers the library. The three Agent Skills ship inside the package,
in `$(npm root -g)/overleaf-web-mcp/skills` after a global install;
[the guide](cli.md#agent-skills) says how to install them for an agent.

## Troubleshooting

**"Failed to connect" right after adding the server.** Almost always one of two things.

- *No saved session.* The server refuses to start until you have run `npx overleaf-web-mcp login`.
  Run it and try again. A command fails the same way, with `AUTH_EXPIRED` on stderr and exit 3.
- *Node is older than 20.* If your default `node` is an older version, `npx` starts the server
  with it and it exits immediately. Check `node --version`. If you keep several versions with a
  manager such as nvm, register the server with an absolute path to a new enough binary instead
  of relying on `PATH`:

    ```bash
    npm install -g overleaf-web-mcp   # with Node 20+ active
    claude mcp add overleaf --scope user -- \
      "$(dirname "$(nvm which 22)")/node" \
      "$(npm root -g)/overleaf-web-mcp/dist/cli.js" serve
    ```

**Not sure which part is failing.** Run `npx overleaf-web-mcp doctor`, and with a project id
`npx overleaf-web-mcp doctor <projectId>`. It reports each check as `ok`, `failed` with its error
code, `unsupported`, or `skipped`, and never changes anything.

**"Connection closed" or "server exited" at startup, and nothing else.** The server checks the
saved session before it answers the client, and an expired session makes it exit with
`AUTH_EXPIRED` on stderr, which most clients never show. Overleaf sessions last five days from
their last use. Run `npx overleaf-web-mcp keepalive`: it prints the new expiry if the session is
alive, or the `AUTH_EXPIRED` error if it is not, in which case run `npx overleaf-web-mcp login`.
To stop it recurring, schedule the keepalive daily; see
[keeping the session alive](configuration.md#keeping-the-session-alive).

**Requests fail or time out on a network that requires a proxy.** Set `HTTPS_PROXY`, and
`NO_PROXY` if some hosts must be reached directly, in the server's `env` block; see
[behind a proxy](configuration.md#behind-a-proxy). Releases before 0.3.1 did not send the
collaboration WebSocket through a proxy, so project tools failed with `ENOTFOUND` even where
`list_projects` worked.

**`AUTH_EXPIRED` in a tool result, or on a command's stderr with exit 3.** The saved session has
expired or been revoked. Run `npx overleaf-web-mcp login` again. Nothing else needs to change.

**You appear online to collaborators.** While the server holds a project connection open, up to
90 seconds after the last call by default, the account can show as present in the editor. See
[configuration](configuration.md) to shorten that. A command holds one only while it runs, but
each command is its own session, so a shell loop over many files opens one after another; see
[request volume](cli.md#sessions-presence-and-request-volume).

## Self-hosted Overleaf

Use the same origin for the login command, the server, and every other command:

```bash
OVERLEAF_BASE_URL=https://overleaf.example.org npx overleaf-web-mcp login
OVERLEAF_BASE_URL=https://overleaf.example.org npx overleaf-web-mcp projects list
```

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "overleaf-web-mcp", "serve"],
      "env": {
        "OVERLEAF_BASE_URL": "https://overleaf.example.org"
      }
    }
  }
}
```

Private API and feature availability vary by deployment and edition. Review comments and tracked
changes, for example, are Server Pro features and are absent from Community Edition.

## Run from a source checkout

```bash
git clone https://github.com/mhmdaskari/overleaf-web-mcp.git
cd overleaf-web-mcp
npm install
npm run build
npm run login
npm start
```

Point your client's `command` at `node` and `args` at `dist/cli.js` in the checkout. From the
checkout, `node dist/cli.js <command>` runs any other command, such as
`node dist/cli.js projects list`.
