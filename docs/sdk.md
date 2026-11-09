# TypeScript SDK

`overleaf-web-mcp/core` is the engine behind the MCP server, as a library. `createOverleafClient`
returns one typed method per tool, with the same checks, safety defaults, results, and error
codes as the MCP server and the [command line](cli.md). It never loads the MCP SDK.

## Install

```bash
npm install overleaf-web-mcp
npx overleaf-web-mcp login
```

The package is ESM only and needs Node.js 20 or newer. The client uses the session `login` saves
and reads the same environment variables as the server; see [configuration](configuration.md).

## A minimal program

```ts
import { createOverleafClient, McpError } from 'overleaf-web-mcp/core'

const projectId = '0123456789abcdef01234567'

const client = await createOverleafClient()
try {
  const file = await client.readFile({ projectId, filePath: 'main.tex' })
  const content = file.content.replaceAll('teh ', 'the ')
  const written = await client.writeFile({ projectId, filePath: 'main.tex', revision: file.revision, content })
  console.log(written.revision)
} catch (error) {
  if (error instanceof McpError && error.code === 'REVISION_CONFLICT') {
    console.error('main.tex changed since it was read; read it again and reconcile.')
  } else {
    throw error
  }
} finally {
  await client.close()
}
```

`createOverleafClient()` opens the saved session, as the server does at start-up, and rejects with
`AUTH_EXPIRED` when there is none or it has expired; any failure to open it rejects with
`McpError`. Close the client in `finally`: it caches
project connections, which keep the process alive, and can show the account online to
collaborators, until it is closed.

## Methods

The client has one method per tool, named in camelCase: `read_file` is `readFile`,
`sync_directory` is `syncDirectory`, and `auth_status` is `authStatus()`. A tool whose parameters
are all optional, such as `listProjects()`, can be called with no argument.
It also has `close()`. Each method takes the tool's input, the same object an MCP client sends as
arguments and the [tool reference](tools.md) documents, and an optional `OperationContext`:

```ts
readFile(input: OperationInput<'read_file'>, context?: OperationContext): Promise<OperationOutput<'read_file'>>
```

`close()` waits for the calls still running, then closes the project connections, so a write in
flight is never cut off. From the moment it is called, every method rejects with
`INVALID_ARGUMENT`; create a new client. Calling `close()` again waits for the same close. Do not
await `close()` inside an `onProgress` callback of a call that is still running: it would wait for
that call, which waits for the callback.

### Input is strict

As on the command line, the input is checked against the tool's input schema before anything is
sent. A key the schema does not list, at any depth, rejects with `INVALID_ARGUMENT` and
`details.unknownKeys`; a value the schema refuses rejects with `INVALID_ARGUMENT` and
`details.issues`, each `{ path, message }`. Omitted fields take the documented defaults, as
through MCP. The MCP server drops unknown keys instead, so a misspelled `writeMode` there falls
back to `untracked`; see [the command line](cli.md#input-is-strict). TypeScript catches most such
mistakes at compile time; the check covers JavaScript callers and input built at run time.

### Results

A method resolves with the tool's result: the same object the MCP server returns as
`structuredContent` and the command line prints, a plain JSON value typed as
`OperationOutput<'tool_name'>` from the tool's output schema.

The results of read-only tools are also checked against that schema at run time. One that does not
match, because Overleaf answered in a shape this release does not understand, rejects with
`PROTOCOL_UNSUPPORTED` and `details: { kind: "response_shape", paths }`. The result of a tool
that changes something is typed but not checked, because an error reported after a write applied
would invite resubmitting it.

### Errors

Every method rejects with an `McpError`. It has `code`, one of `ERROR_CODES`; `message`;
`retryable`; and optional `details`. `toJSON()` returns `{ code, message, retryable, details? }`,
exactly what the command line reports, and what the MCP server reports for any failure of the
operation itself. Input the schema refuses is the exception: the MCP SDK checks it before the
server runs the tool and answers with its own plain-text error, with no code or details, where the
client and the command line report `INVALID_ARGUMENT` with `details.issues`, or
`details.unknownKeys` for a key the schema does not list. The
[safety model](safety.md#error-codes) lists the codes, and the command line's
[exit codes](cli.md#exit-codes) are a good rule for deciding what to do next.

The client never retries a write or a call. Below it, a read is sent again at most twice after a
network failure or HTTP 5xx, and a project join after a passing refusal, before failing with
`TRANSIENT_FAILURE` (see [retries and pacing](configuration.md#retries-and-pacing)).
`retryable: true` is advisory, and a `TIMEOUT` from a write carries it
too: when `details.outcome` is `unknown`, or the code is `OUTCOME_UNKNOWN`, read the document or
the tree before doing anything else, and never call the write again blindly.

### Progress, cancellation, and diagnostics

`OperationContext` is what an interface hands an operation besides its input:

| Field | Meaning |
| --- | --- |
| `onProgress(progress, total, message)` | Called as `plan_sync`, `sync_directory`, `batch_upload`, and `delete_entities` advance. Messages hold counts only. Its failures are ignored. |
| `signal` | An `AbortSignal`. Cancelling it stops waiting; it never aborts a write already submitted. No operation in this release observes it yet. |
| `onDiagnostic({ tool, code })` | Called when an operation fails, with its error code, or relied on a deprecated default, with `DEPRECATED`. It never carries a message, path, or content. |

## Stable surface

These exports follow the project's versioning: until 1.0.0 a change can come in a minor release,
and every change is listed in the [changelog](changelog.md).

| Export | What it is |
| --- | --- |
| `createOverleafClient` | `createOverleafClient(options?)` opens the session and returns an `OverleafClient`. `options.config` defaults to `readConfig()`. |
| `OverleafClient` | The client type: one method per tool, plus `close()`. |
| `OverleafClientOptions` | `createOverleafClient`'s options. Only `config` is public. |
| `OperationMethod` | The type of one client method. |
| `CamelCase` | The method name for a tool name, as a type: `CamelCase<'read_file'>` is `'readFile'`. |
| `createOverleafService` | `createOverleafService(runtime)` returns one function per tool under its snake_case name, taking already-parsed input. The client is built on it. |
| `OverleafService` | The type `createOverleafService` returns. |
| `OverleafRuntime` | The session and engine. Only `OverleafRuntime.create(config)`, which opens the session, and `runtime.close()` are stable. |
| `readConfig` | `readConfig(env?)` reads the configuration from `process.env`, or the object given. |
| `AppConfig` | The configuration `readConfig` returns. |
| `McpError` | The error every method rejects with. |
| `McpErrorCode`, `ErrorCode` | One of `ERROR_CODES`. |
| `ERROR_CODES` | Every error code, through every interface. |
| `OPERATIONS` | The contract of every tool: description, input and output schemas, annotations, and effects. |
| `OPERATION_NAMES` | The tool names, in registration order. |
| `operationContract` | `operationContract(name)` returns one entry of `OPERATIONS`. |
| `OperationName` | One of `OPERATION_NAMES`. |
| `OperationInput` | `OperationInput<'tool_name'>`, what a tool accepts; defaulted fields may be left out. |
| `OperationOutput` | `OperationOutput<'tool_name'>`, what a tool resolves with. |
| `OperationContext` | The optional second argument of every method. |
| `ProgressReporter` | The type of `onProgress`. |
| `OperationDiagnostic` | What `onDiagnostic` receives. |
| `OperationContract`, `OperationAnnotations` | The shape of one `OPERATIONS` entry and its MCP annotations. |
| `EFFECTS`, `READ_EFFECTS`, `Effect` | The effects an operation can have, as the [access policy](configuration.md#access-policy) names them. |
| `WriteMode` | `"untracked"` or `"tracked"`. |
| `SERVER_VERSION` | The package version. |

Everything else the module exports is internal and can change in any release: the other fields
and methods of `OverleafRuntime` (`http`, `documents`, `connections`, `policy`, and the domain
APIs), `RuntimeDependencies` with its `fetcher` and `connectionFactory`, the `dependencies` option
of `createOverleafClient`, and the `OverleafServiceRuntime` and `OperationHandler` types.

## Using the service directly

`createOverleafService` is the layer the MCP server, the command line, and the client share. It
expects input already parsed against the tool's schema, as the MCP SDK delivers it: it neither
refuses unknown keys nor applies the schema's defaults itself. Prefer the client unless you parse
input yourself.

```ts
import { createOverleafService, OverleafRuntime, readConfig } from 'overleaf-web-mcp/core'

const runtime = await OverleafRuntime.create(readConfig())
try {
  const service = createOverleafService(runtime)
  const tree = await service.get_project_tree({ projectId: '0123456789abcdef01234567' })
  console.log(tree.rootDocPath)
} finally {
  await runtime.close()
}
```

Every domain method checks the [access policy](configuration.md#access-policy) before any
request, so code that reaches past the service is held to the same rules.
