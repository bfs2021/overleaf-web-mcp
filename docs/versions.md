# Version history

What each release added to the MCP server, the command line, and the TypeScript SDK. The
[changelog](changelog.md) has every change, including fixes and changed behaviour; this page lists
only additions, newest first.

## Version tags

Throughout this site, a tag such as <!-- md:version 0.9.0 --> next to a tool, parameter, command,
flag, export, environment variable, or error code names the first release that has it. Your
installed version must be at least that one; the `version` key of `overleaf-web-mcp capabilities`,
which opens no session, and `SERVER_VERSION` in the SDK say which you have. The number links to that release in the changelog.

- A parameter, flag, or value without its own tag shipped with the tool or command it belongs to.
- A tag gives the release where the current name and shape arrived. Behaviour can have changed
  since, for example an error that a later release reports under a more specific code; the
  changelog records each such change.
- A tool's tag is its release on the MCP server. The command line (`call <tool>`) and the SDK
  client reach every tool from 0.7.0, so a tool tagged earlier is available there from 0.7.0, and
  one tagged later from its own release.
- The [SDK](sdk.md#stable-surface) surface has existed since 0.5.0 and follows Semantic
  Versioning from 1.0.0. Before 1.0.0 a minor release could change it.

## 1.0.0

[Changelog](changelog.md#100-2026-11-09)

- **Command line:** [`doctor [projectId]`](cli.md#checking-an-install); the `backend` block in
  [`capabilities`](cli.md#describing-the-operations).
- **Configuration:** [`OVERLEAF_READ_ATTEMPTS`](configuration.md#reference) and [`OVERLEAF_MIN_REQUEST_INTERVAL_MS`](configuration.md#reference),
  with [read retries and request pacing](configuration.md#retries-and-pacing).
- **SDK:** `AppConfig` gains the optional `readAttempts` and `minRequestIntervalMs`. The
  [stable surface](sdk.md#stable-surface) follows Semantic Versioning from here.
- **Errors:** [`TRANSIENT_FAILURE`](safety.md#error-codes), exit 7 from a read-only operation and 5 from a write.

## 0.9.0

[Changelog](changelog.md#090-2026-11-07)

- **MCP tools:** [`get_full_document`](tools.md#get_full_document-read-only); `followIncludes` on [`get_sections`](tools.md#get_sections-read-only),
  [`get_section_content`](tools.md#get_section_content-read-only), and [`write_section`](tools.md#write_section-destructive).
- **Errors:** [`INCLUDE_CYCLE`](safety.md#error-codes) and [`INCLUDE_DEPTH_EXCEEDED`](safety.md#error-codes).

## 0.8.0

[Changelog](changelog.md#080-2026-10-31)

- **MCP tools:** [`list_tracked_changes`](tools.md#list_tracked_changes-read-only) and [`manage_tracked_changes`](tools.md#manage_tracked_changes-destructive).
- **Command line:** `tracked-changes list`, `tracked-changes accept`, and `tracked-changes reject`
  ([commands](cli.md#commands)).
- **Errors:** [`REVIEW_UNSUPPORTED`](safety.md#error-codes).

## 0.7.0

[Changelog](changelog.md#070-2026-10-25)

- **Command line:** an operation command for every tool: `call`, `schema`, and `capabilities`,
  and the shorthands `projects list`, `tree`, `files read`, `files write`, `files download`,
  `sync plan`, `sync apply`, `compile run`, `compile log`, `compile download`, and
  `comments list` ([commands](cli.md#commands)); `--progress`; one JSON result per command and
  the [exit codes](cli.md#exit-codes) 0 to 7; three [Agent Skills](cli.md#agent-skills).
- **SDK:** `createOverleafClient`, `OverleafClient`, `OverleafClientOptions`, `OperationMethod`,
  and `CamelCase` ([methods](sdk.md#methods)).

## 0.6.0

[Changelog](changelog.md#060-2026-10-19)

- **MCP tools:** [`get_compile_log`](tools.md#get_compile_log-read-only) and [`download_compile_output`](tools.md#download_compile_output-destructive); `draft` and
  `stopOnFirstError` on [`compile_project`](tools.md#compile_project); `onConflict: "fail"` on [`batch_upload`](tools.md#batch_upload-destructive), now
  its default; read-only [compile output resources](tools.md#compile-output-resources).
- **Errors:** [`COMPILE_RATE_LIMITED`](safety.md#error-codes), [`COMPILE_UNAVAILABLE`](safety.md#error-codes), [`COMPILE_TIMEOUT`](safety.md#error-codes),
  [`NO_BUILD`](safety.md#error-codes), and [`BUILD_NOT_FOUND`](safety.md#error-codes).

## 0.5.0

[Changelog](changelog.md#050-2026-10-10)

- **MCP tools:** `overwrite`, `expectedHash`, and `uncheckedDocumentReplace` on
  [`upload_file`](tools.md#upload_file-destructive); `uncheckedDocumentReplace` on [`batch_upload`](tools.md#batch_upload-destructive); `unplanned` on
  [`sync_directory`](tools.md#sync_directory-destructive).
- **SDK:** the `overleaf-web-mcp/core` entry, with `createOverleafService`, `OverleafRuntime`,
  `readConfig`, `OPERATIONS`, `ERROR_CODES`, `McpError`, and the types the
  [stable surface](sdk.md#stable-surface) lists.
- **Configuration:** the [access policy](configuration.md#access-policy):
  [`OVERLEAF_ALLOWED_PROJECTS`](configuration.md#reference), [`OVERLEAF_LOCAL_READ_ROOTS`](configuration.md#reference),
  [`OVERLEAF_LOCAL_WRITE_ROOTS`](configuration.md#reference), and [`OVERLEAF_ALLOWED_EFFECTS`](configuration.md#reference).
- **Errors:** [`POLICY_DENIED`](safety.md#error-codes).

## 0.4.1

[Changelog](changelog.md#041-2026-10-06)

- **MCP tools:** [`batch_upload`](tools.md#batch_upload-destructive) and [`download_project_zip`](tools.md#download_project_zip-destructive).

## 0.4.0

[Changelog](changelog.md#040-2026-09-27)

- **MCP tools:** [`plan_sync`](tools.md#plan_sync-read-only), [`sync_directory`](tools.md#sync_directory-destructive), and [`delete_entities`](tools.md#delete_entities-destructive).
- **Errors:** [`REMOTE_DRIFT`](safety.md#error-codes) and [`PATH_OUTSIDE_ROOT`](safety.md#error-codes).

## 0.3.1

[Changelog](changelog.md#031-2026-09-22)

- **Configuration:** `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY`
  ([behind a proxy](configuration.md#behind-a-proxy)).

## 0.3.0

[Changelog](changelog.md#030-2026-09-14)

- **Command line:** `keepalive` ([keeping the session alive](configuration.md#keeping-the-session-alive)).

## 0.2.0

[Changelog](changelog.md#020-2026-09-10)

- **MCP tools:** [`create_project`](tools.md#create_project), [`clone_project`](tools.md#clone_project), [`import_project_zip`](tools.md#import_project_zip),
  [`manage_project`](tools.md#manage_project-destructive), and [`update_project_settings`](tools.md#update_project_settings); `query`, `includeArchived`,
  `includeTrashed`, `limit`, and `sort` on [`list_projects`](tools.md#list_projects-read-only).
- **Errors:** [`CONFIRMATION_MISMATCH`](safety.md#error-codes) and [`RATE_LIMITED`](safety.md#error-codes).

## 0.1.3

[Changelog](changelog.md#013-2026-09-01)

- **MCP tools:** `localPath` on [`write_file`](tools.md#write_file-destructive); `destinationName` on [`upload_file`](tools.md#upload_file-destructive);
  `overwrite` on [`download_file`](tools.md#download_file-destructive).

## 0.1.2

[Changelog](changelog.md#012-2026-07-20)

- **MCP tools:** [`monitor_project_history`](tools.md#monitor_project_history-read-only); tracked writes through `writeMode` on
  [`write_file`](tools.md#write_file-destructive), [`create_file`](tools.md#create_file), and [`write_section`](tools.md#write_section-destructive).

## 0.1.0

[Changelog](changelog.md#010-2026-07-15)

- **MCP tools:** [`auth_status`](tools.md#auth_status-read-only), [`list_projects`](tools.md#list_projects-read-only), [`get_project_tree`](tools.md#get_project_tree-read-only),
  [`read_file`](tools.md#read_file-read-only), [`write_file`](tools.md#write_file-destructive), [`create_file`](tools.md#create_file), [`manage_entity`](tools.md#manage_entity-destructive),
  [`upload_file`](tools.md#upload_file-destructive), [`download_file`](tools.md#download_file-destructive), [`get_sections`](tools.md#get_sections-read-only), [`get_section_content`](tools.md#get_section_content-read-only),
  [`write_section`](tools.md#write_section-destructive), [`compile_project`](tools.md#compile_project), [`stop_compile`](tools.md#stop_compile-destructive), [`list_comments`](tools.md#list_comments-read-only),
  [`reply_to_comment`](tools.md#reply_to_comment), [`add_comment`](tools.md#add_comment), and [`set_comment_status`](tools.md#set_comment_status-destructive).
- **Command line:** `serve`, `login`, and `--help`.
- **Configuration:** the variables in the [reference](configuration.md#reference) not tagged
  with a later release.
- **Errors:** the codes in the [error table](safety.md#error-codes) not tagged with a later
  release.
