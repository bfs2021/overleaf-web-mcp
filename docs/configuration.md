# Configuration

Everything is configured through environment variables: for the server, set where the MCP client
starts it, for example in the `env` block of the client's MCP configuration; for the
[command line](cli.md), in the shell that runs each command; for the [SDK](sdk.md), in the
process, which `readConfig()` reads from `process.env`. Defaults suit `www.overleaf.com`.

A variable that is empty or only whitespace counts as unset everywhere, so a client that passes
every variable it declares can leave the optional ones blank.

## Reference

| Variable | Default | Purpose | Since |
| --- | ---: | --- | --- |
| `OVERLEAF_BASE_URL` | `https://www.overleaf.com` | Target Overleaf origin. Use the same value for `login`, `serve`, and every other command. | <!-- md:version 0.1.0 --> |
| `OVERLEAF_COOKIE_JAR_FILE` | Platform configuration directory | Saved-session path override | <!-- md:version 0.1.0 --> |
| `OVERLEAF_BROWSER_PATH` | Auto-detected | Chrome-family executable used by `login` | <!-- md:version 0.1.0 --> |
| `OVERLEAF_BROWSER_PROFILE_DIR` | Platform configuration directory | Dedicated login profile | <!-- md:version 0.1.0 --> |
| `OVERLEAF_LOGIN_TIMEOUT_MS` | `300000` | Browser sign-in deadline, capped at 15 minutes | <!-- md:version 0.1.0 --> |
| `OVERLEAF_PROTOCOL_VERSIONS` | `2` | Comma-separated accepted collaboration protocol versions | <!-- md:version 0.1.0 --> |
| `OVERLEAF_MAX_DOC_LENGTH` | `2097152` | Fallback maximum UTF-16 document length | <!-- md:version 0.1.0 --> |
| `OVERLEAF_MAX_UPDATE_CHARS` | `7340032` | Conservative serialized OT update limit | <!-- md:version 0.1.0 --> |
| `OVERLEAF_SOCKET_CACHE_SIZE` | `2` | Maximum cached project sockets | <!-- md:version 0.1.0 --> |
| `OVERLEAF_SOCKET_IDLE_TTL_MS` | `90000` | Idle project-socket lifetime | <!-- md:version 0.1.0 --> |
| `OVERLEAF_REQUEST_TIMEOUT_MS` | `30000` | REST and collaboration-call timeout | <!-- md:version 0.1.0 --> |
| `OVERLEAF_APPLY_TIMEOUT_MS` | `30000` | OT acknowledgement and application timeout | <!-- md:version 0.1.0 --> |
| `OVERLEAF_RECOVERY_TIMEOUT_MS` | `30000` | Ambiguous-mutation observation window | <!-- md:version 0.1.0 --> |
| `OVERLEAF_COMPILE_TIMEOUT_MS` | `120000` | Default compile wait, capped at 15 minutes | <!-- md:version 0.1.0 --> |
| `OVERLEAF_READ_ATTEMPTS` | `3` | Attempts of a read after a transient failure, 1 (no retry) to 3; see [retries and pacing](#retries-and-pacing) | <!-- md:version 1.0.0 --> |
| `OVERLEAF_MIN_REQUEST_INTERVAL_MS` | `0` | Least time between the starts of two REST requests, at most 60000 | <!-- md:version 1.0.0 --> |
| `HTTPS_PROXY`, `https_proxy` | Unset | Proxy for an `https://` base URL; see [behind a proxy](#behind-a-proxy) | <!-- md:version 0.3.1 --> |
| `HTTP_PROXY`, `http_proxy` | Unset | Proxy for an `http://` base URL | <!-- md:version 0.3.1 --> |
| `NO_PROXY`, `no_proxy` | Unset | Hosts reached directly, bypassing the proxy | <!-- md:version 0.3.1 --> |
| `OVERLEAF_ALLOWED_PROJECTS` | Unset, every project | Comma-separated project ids the server may touch; see [access policy](#access-policy) | <!-- md:version 0.5.0 --> |
| `OVERLEAF_LOCAL_READ_ROOTS` | Unset, anywhere | Absolute folders local reads must stay inside, separated by `:` (`;` on Windows) | <!-- md:version 0.5.0 --> |
| `OVERLEAF_LOCAL_WRITE_ROOTS` | Unset, anywhere but the session | Absolute folders local writes must stay inside, separated the same way | <!-- md:version 0.5.0 --> |
| `OVERLEAF_ALLOWED_EFFECTS` | Unset, every effect | Comma-separated effects operations may have | <!-- md:version 0.5.0 --> |

An `ol-maxDocLength` value advertised by the Overleaf deployment takes precedence over the
fallback. Content at or above the limit returns `DOC_TOO_LARGE`; an oversized serialized update
returns `UPDATE_TOO_LARGE` and must be split into smaller, independently revisioned writes.

`compile_project.timeoutMs` accepts 1 second through 15 minutes. It changes only how long the call
waits, not the account's server-side compile allowance.

`download_project_zip.timeoutMs` (1 second to 15 minutes, default 5 minutes) bounds a whole-project
download, the whole transfer included, in place of `OVERLEAF_REQUEST_TIMEOUT_MS`.

## Retries and pacing

<!-- md:version 1.0.0 -->

Only reads are ever sent again. A read, a `GET` or the project list's `POST /api/project`, that
failed on the network, was cut off, or answered HTTP 5xx, and a project join that failed for a
reason that passes (Overleaf asked the client to come back, as while restarting, the socket closed
or failed before Overleaf answered, or the handshake failed on the network or with HTTP 5xx), are
tried again after a short randomized backoff, up to `OVERLEAF_READ_ATTEMPTS` attempts in all, so
at most two retries. When every attempt failed that way, the call fails with `TRANSIENT_FAILURE`,
`details.attempts`, and `details.lastCode`; the command line exits 7 for a read-only operation. A
tool that writes can also read, before its change or after it to read the result back, so from
one it exits 5: read before running it again. Nothing else is retried: no request that changes
something, no OT update, upload, or delete, and no read that timed out, was rate-limited, or was
refused. A timed-out write is observed, never resubmitted, as before. A whole-project download,
read as a stream, is not retried once its answer has started.

`OVERLEAF_MIN_REQUEST_INTERVAL_MS` spaces the starts of REST requests from one process, for a
deployment that rate-limits closely. It does not pace the collaboration socket, and two processes
are not paced against each other.

## Where the session is stored

The login command uses a separate browser profile and never reads your normal browser profile.
Session files live under `overleaf-web-mcp` in the platform configuration directory:

| Platform | Path |
| --- | --- |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/overleaf-web-mcp` |
| macOS | `~/Library/Application Support/overleaf-web-mcp` |
| Windows | `%APPDATA%\overleaf-web-mcp` |

Only cookies applicable to `OVERLEAF_BASE_URL` are saved. On POSIX systems the directory is
created with mode `0700` and the cookie jar with mode `0600`; a group- or world-readable jar is
rejected. Filesystems without meaningful POSIX modes continue with a `permissionsUnchecked`
warning in `auth_status`.

Cookie refreshes received during normal use are merged under an advisory lock and written through
a protected temporary file followed by an atomic replace. If the session expires, run
`npx overleaf-web-mcp login` again; to stop that happening, see the next section.

## Keeping the session alive

<!-- md:version 0.3.0 -->

Overleaf issues its session cookie with a five-day lifetime and re-issues it, with a fresh five
days, on every response. The server merges each refreshed cookie into the jar, so a session used
at least once every five days never expires, and one left untouched for five days is gone for
good. Nothing on your machine can extend that: editing the expiry in `cookies.txt` only keeps
sending a cookie Overleaf has already forgotten. What closes the gap is a request every few days.

```bash
npx overleaf-web-mcp keepalive
```

The command runs the same startup bootstrap as `serve`, merges the refreshed cookie into the jar,
prints when the session will now expire, and exits:

```json
{
  "refreshed": true,
  "baseUrl": "https://www.overleaf.com",
  "sessionExpiresAt": "2026-09-19T22:25:37.520Z",
  "userId": "..."
}
```

Against a session that has already lapsed it exits with status 1, prints the usual error JSON
(`AUTH_EXPIRED`) to stderr and nothing to stdout, so a scheduler can alert on it. A keepalive
cannot revive a dead session; a machine that stays off for more than five days still needs
`login`. `auth_status` reports the same `sessionExpiresAt`, so an assistant can tell you how long
is left.

Schedule it once a day. Any interval under five days works; daily leaves four days of slack for a
laptop that was asleep. Schedulers do not source your login shell, so give them the absolute path
of a Node 20 or newer binary and of the installed package rather than `npx`. With the right Node
active, `command -v node` and `npm root -g` print the two paths used below; adjust them to yours.

**macOS, `launchd`.** Save as `~/Library/LaunchAgents/com.overleaf-web-mcp.keepalive.plist`, then
`launchctl load ~/Library/LaunchAgents/com.overleaf-web-mcp.keepalive.plist`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.overleaf-web-mcp.keepalive</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/opt/homebrew/lib/node_modules/overleaf-web-mcp/dist/cli.js</string>
    <string>keepalive</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardErrorPath</key><string>/tmp/overleaf-web-mcp-keepalive.log</string>
</dict>
</plist>
```

**Linux, `cron`.** Run `crontab -e` and add one line:

```
0 9 * * * /usr/local/bin/node /usr/local/lib/node_modules/overleaf-web-mcp/dist/cli.js keepalive >/dev/null 2>>"$HOME/.overleaf-web-mcp-keepalive.log"
```

**Windows, Task Scheduler.** From a Command Prompt:

```
schtasks /Create /SC DAILY /ST 09:00 /TN "overleaf-web-mcp keepalive" /TR "\"C:\Program Files\nodejs\node.exe\" \"%APPDATA%\npm\node_modules\overleaf-web-mcp\dist\cli.js\" keepalive"
```

Running a keepalive while an MCP client has the server open is safe, and so is running several
commands at once. Cookie refreshes are merged under the jar's advisory lock, and the jar is
re-read under that lock before it is written, so no process can overwrite another's refresh.

## Behind a proxy

<!-- md:version 0.3.1 -->

When outbound traffic must go through an HTTP proxy, set the conventional proxy variables in the
same `env` block as the others:

```json
"env": {
  "HTTPS_PROXY": "http://proxy.example.org:3128",
  "NO_PROXY": "localhost,.internal.example.org"
}
```

The server makes one routing decision for `OVERLEAF_BASE_URL` at startup and applies it to every
connection: REST requests, the Socket.IO handshake, and the collaboration WebSocket always take
the same route, as the handshake's load-balancer cookie requires. It does not rely on Node's own
proxy support, so it works on Node 20 and needs no `NODE_USE_ENV_PROXY`.

- The variable follows the scheme of `OVERLEAF_BASE_URL`: `HTTPS_PROXY` for an `https://` origin,
  `HTTP_PROXY` for an `http://` one, with no fallback from one to the other. A lowercase name
  takes precedence over the uppercase one, and an empty value counts as unset.
- The value is an `http://` or `https://` proxy URL, and a bare `host:port` means `http://`.
  Credentials go in the URL, percent-encoded where needed, as in
  `http://user:p%40ss@proxy.example.org:3128`. They are sent only to the proxy and never printed.
  SOCKS proxies are not supported.
- `NO_PROXY` is a comma-separated list. An entry matches that host and its subdomains, with or
  without a leading `.` or `*.`; `*` matches every host; `host:port` matches only that port; an IP
  address matches only itself. CIDR ranges are not supported.
- If the variable that applies is invalid, the server exits at startup with `INVALID_ARGUMENT`,
  naming the variable but not its value. A variable that does not apply, because of the scheme or
  `NO_PROXY`, is not checked.

`login` signs in through Chrome, which applies its own proxy settings. The check that follows
sign-in uses the proxy above, as `serve`, `keepalive`, and every operation command do.

## Access policy

<!-- md:version 0.5.0 -->

Four variables limit what the server may touch. Each one is unset by default, which allows
everything of its kind, and the server checks every operation against all four before it sends
anything, so a refused call costs no request. A misconfigured value, such as a relative root or a
root that does not exist, stops the server at startup with `INVALID_ARGUMENT` naming the
variable, and fails an operation command with exit 2.

| Variable | Limits | Refusal |
| --- | --- | --- |
| `OVERLEAF_ALLOWED_PROJECTS` | Which projects any tool may read or change, by id. `list_projects` and `auth_status` show and count only these. A project created by this process (`create_project`, `clone_project`, `import_project_zip`) is allowed for the rest of the process; each command line call is a process of its own, so the next command refuses it until its id is added here. | `POLICY_DENIED` |
| `OVERLEAF_LOCAL_READ_ROOTS` | Which local files and folders may be read: `write_file` and `upload_file` with `localPath`, `batch_upload`, `import_project_zip`, `plan_sync`, and `sync_directory`. | `PATH_OUTSIDE_ROOT`, `details.kind: "outside_read_roots"` |
| `OVERLEAF_LOCAL_WRITE_ROOTS` | Where `download_file` and `download_project_zip` may write. | `PATH_OUTSIDE_ROOT`, `details.kind: "outside_write_roots"` |
| `OVERLEAF_ALLOWED_EFFECTS` | Which kinds of change any operation may make. | `POLICY_DENIED`, `details.effect` |

Roots are resolved with `realpath` when the server starts, and a path is judged by where it
leads, the way the file system resolves it: a symbolic link inside a root that points outside it
is refused, a link is followed before the `..` after it, and a link to a file that does not exist
yet is judged by where it would create one. Whatever the policy, no tool reads or writes the
cookie jar, its lock and temporary files, or the browser profile `login` uses, and a folder that
holds them cannot be synced (`PATH_OUTSIDE_ROOT`, `details.kind: "session_files"`).

The effects are:

| Effect | What it covers |
| --- | --- |
| `overleaf-read` | Reading project data |
| `overleaf-write` | Changing content, comments, or the tree without removing anything |
| `overleaf-delete` | Removing an entity or a tag, or permanently deleting a project |
| `project-lifecycle` | Creating, cloning, importing, renaming, trashing, archiving, tagging, or configuring a project |
| `compile` | Starting or stopping a compile |
| `local-read` | Reading a file or folder on the server's disk |
| `local-write` | Creating or replacing a file on the server's disk |
| `unchecked-replace` | Replacing a text document with no revision check, by `upload_file` or `batch_upload` |

Nearly every operation reads project data, writes included, so `overleaf-read` belongs in any
useful list. An operation that reads after it changes something, such as `create_project`
reading the new project's tree or `import_project_zip` reading back the stored name, needs every
effect it will use before it starts, so a refusal never lands after the change.

For example, an assistant that may only read one project and save copies of its files into one folder:

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "overleaf-web-mcp", "serve"],
      "env": {
        "OVERLEAF_ALLOWED_PROJECTS": "64b7f1c2e4b0a1b2c3d4e5f6",
        "OVERLEAF_ALLOWED_EFFECTS": "overleaf-read,local-write",
        "OVERLEAF_LOCAL_WRITE_ROOTS": "/home/me/overleaf-drafts"
      }
    }
  }
}
```

The same variables limit a command run from a shell:

```bash
export OVERLEAF_ALLOWED_PROJECTS=64b7f1c2e4b0a1b2c3d4e5f6
export OVERLEAF_ALLOWED_EFFECTS=overleaf-read,local-write
export OVERLEAF_LOCAL_WRITE_ROOTS=/home/me/overleaf-drafts
overleaf-web-mcp files download 64b7f1c2e4b0a1b2c3d4e5f6 main.tex /home/me/overleaf-drafts/main.tex
```

`overleaf-web-mcp capabilities` reports which variables are set and, for each tool, the effects
they refuse, without opening a session.

The policy keeps an assistant inside what it was given; it is not a sandbox against a malicious
process on the same machine. The [safety model](safety.md#the-access-policy-is-not-a-sandbox)
says exactly where it stops.

## Presence

While a project socket is open, the account may appear online to collaborators in the Overleaf
editor. By default at most two project sockets are cached, active sockets are never evicted, and
idle sockets disconnect after 90 seconds. Lower `OVERLEAF_SOCKET_IDLE_TTL_MS` to shorten that
window at the cost of reconnecting more often.

A command holds its sockets only while it runs and closes them before it exits. Each command is
a session of its own, though, so a shell loop that runs one command per file connects again and
again; use one `sync apply`, `call batch_upload`, or `call delete_entities` instead.
