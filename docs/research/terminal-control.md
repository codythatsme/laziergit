# Terminal Control research (for laziergit)

Researched 2026-07-24 against Terminal Control **v0.6.0** primary sources: its tagged npm
manifests, TypeScript client and OpenTUI adapter source, protocol documentation, release
validation, and CI workflows.

## Recommendation

Use the typed `@kitlangton/terminal-control` client with Bun's existing test runner and make
settled `screen.text()` / `screen.frame()` the E2E assertion surface. Do not add Vitest just for
Terminal Control. Wire the OpenTUI adapter so CLI-based semantic inspection is available, but do
not make the typed E2E suite depend on it: v0.6.0's TypeScript client can launch with
`host: "opentui"` but does **not** expose a semantic snapshot read operation. Semantic reads
currently require a named CLI session:

```bash
termctrl start laziergit-e2e --host opentui --cols 120 --rows 40 \
  --cwd "$FIXTURE" -- bun /absolute/path/packages/core/src/main.tsx
termctrl wait laziergit-e2e "Files" --timeout 10000
termctrl show laziergit-e2e --format semantic
termctrl stop laziergit-e2e
```

This limitation follows directly from the published client's methods versus the CLI protocol:
the driver offers `launch`, waits, input, captures, logs, recording, resize, stop, and shutdown,
while `show NAME --format semantic` is a separate named-session operation. The MCP server likewise
exposes visible-screen reads rather than the application semantic snapshot. Sources:
[client source](https://github.com/anomalyco/terminal-control/blob/v0.6.0/packages/test/src/index.ts),
[driver protocol](https://github.com/anomalyco/terminal-control/blob/v0.6.0/docs/driver-protocol.md),
[semantic CLI implementation](https://github.com/anomalyco/terminal-control/blob/v0.6.0/src/main.rs#L1123-L1184),
[MCP `get_screen`](https://github.com/anomalyco/terminal-control/blob/v0.6.0/src/mcp.rs#L718-L724).

## Packages, versions, and platforms

| Package | v0.6.0 role |
|---|---|
| `@kitlangton/terminal-control` | Typed ESM test client; optional Vitest matcher entry point |
| `@kitlangton/terminal-control-opentui` | Application-side semantic snapshot provider |
| `@kitlangton/terminal-control-darwin-arm64` | Native `termctrl` binary |
| `@kitlangton/terminal-control-darwin-x64` | Native `termctrl` binary |
| `@kitlangton/terminal-control-linux-arm64-gnu` | Native glibc `termctrl` binary |
| `@kitlangton/terminal-control-linux-x64-gnu` | Native glibc `termctrl` binary |

Both public libraries and all four native packages are fixed at **0.6.0**. The client declares
the native packages as exact-version optional dependencies, so consumers install only the matching
binary and need neither Rust nor a separate global `termctrl`. The supported packaged targets are
macOS/Linux, arm64/x64; Linux is glibc-only. Windows and musl/Alpine have no packaged binary, and
`TerminalControl.make()` fails there unless given a custom `binaryPath` or `TERMCTRL_BINARY`.
Sources: [client manifest](https://github.com/anomalyco/terminal-control/blob/v0.6.0/packages/test/package.json#L31-L52),
[binary resolver](https://github.com/anomalyco/terminal-control/blob/v0.6.0/packages/test/src/index.ts#L257-L277),
[native manifests](https://github.com/anomalyco/terminal-control/tree/v0.6.0/packages),
[release matrix](https://github.com/anomalyco/terminal-control/blob/v0.6.0/.github/workflows/npm-release.yml#L14-L45).

The adapter's peer range is `@opentui/core >=0.4.1 <0.5.0`; laziergit's pinned
`@opentui/core` 0.4.4 is supported. Upstream release validation installs the adapter against both
0.4.1 and 0.4.5. Sources:
[adapter manifest](https://github.com/anomalyco/terminal-control/blob/v0.6.0/packages/opentui/package.json#L27-L45),
[adapter validation](https://github.com/anomalyco/terminal-control/blob/v0.6.0/scripts/validate-opentui-package.mjs).

Recommended dependency placement:

- `@kitlangton/terminal-control` 0.6.0 as a dev dependency for the E2E tests.
- `@kitlangton/terminal-control-opentui` 0.6.0 as a `packages/core` runtime dependency because
  `main.tsx` statically imports it. A root catalog pin is appropriate, but a root-only dev
  dependency is not; its provider is a no-op outside a Terminal Control host launch.
- No direct native-package dependency and no Vitest dependency.

## Bun-compatible test client

The launch contract is a nonempty command tuple plus optional `cwd`, `viewport`, `env`,
`inheritEnv`, `record`, `host: "opentui"`, color policy, and retained-byte limit. Both the client
and session implement `AsyncDisposable`, so `await using` reliably stops sessions and the driver.
[Launch and disposal source](https://github.com/anomalyco/terminal-control/blob/v0.6.0/packages/test/src/index.ts#L129-L169),
[client lifecycle source](https://github.com/anomalyco/terminal-control/blob/v0.6.0/packages/test/src/index.ts#L280-L398),
[session lifecycle source](https://github.com/anomalyco/terminal-control/blob/v0.6.0/packages/test/src/index.ts#L435-L559).

An appropriate laziergit launch shape is:

```ts
import { TerminalControl } from "@kitlangton/terminal-control"
import { resolve } from "node:path"

const main = resolve(import.meta.dir, "..", "..", "packages", "core", "src", "main.tsx")

await using terminal = await TerminalControl.make({
  artifacts: {
    directory: ".termctrl-artifacts",
    onFailure: true,
    includeRecording: true,
  },
})
await using session = await terminal.launch({
  command: [process.execPath, main],
  cwd: fixture.path,
  viewport: { cols: 120, rows: 40 },
  host: "opentui",
  env: gitIsolation,
  record: "on-failure",
})
```

`process.execPath` keeps the child on the same Bun binary as the test. If `inheritEnv: false` is
used, the test must explicitly pass `PATH` as well as the existing git identity/config isolation
and config-home variables.

The useful surface is:

- Wait: `screen.waitForText(string | RegExp, { timeoutMs })`,
  `screen.waitForIdle({ quietForMs, timeoutMs })`, and
  `screen.waitUntil(predicate, { timeoutMs })`.
- Input: `keyboard.type(text, { paceMs })`, `press(key)`, `sequence(keys, { paceMs })`, and
  `write(Uint8Array)` for exact unsupported bytes. Typed keys are Enter/Escape, arrows, Tab and
  Shift+Tab, editing/navigation keys, and `Control+A` through `Control+Z`.
- Snapshot: `screen.text()`, `screen.frame()`, or
  `screen.capture({ settleMs, deadlineMs, includeAnsi, includeSvg })`. Stable capture is the
  default; deadline/output-closed fallback throws `IncompleteCaptureError` unless
  `allowIncomplete: true` is explicitly requested.
- Lifecycle/evidence: `status()`, `waitForExit()`, `resize()`, `logs.text()`,
  `transcript.ansi()`, `writeArtifacts()`, `withArtifactsOnFailure()`, and recording save.

Sources: [screen and keyboard implementation](https://github.com/anomalyco/terminal-control/blob/v0.6.0/packages/test/src/index.ts#L562-L647),
[status and evidence implementation](https://github.com/anomalyco/terminal-control/blob/v0.6.0/packages/test/src/index.ts#L435-L559),
[upstream Bun E2E tests](https://github.com/anomalyco/terminal-control/blob/v0.6.0/packages/test/src/index.test.ts).

Use `waitForText` for state transitions and settled captures for assertions; fixed sleeps are not
needed. Snapshot syntax is the test runner's ordinary matcher, not a method on `Screen`:

```ts
await session.screen.waitForText("Files", { timeoutMs: 10_000 })
await session.keyboard.press("ArrowDown")
expect(await session.screen.text({ settleMs: 250, deadlineMs: 5_000 })).toMatchSnapshot()
```

## OpenTUI adapter and semantic protocol

Wire the adapter immediately after creating the live `CliRenderer`, and close it with the renderer:

```ts
import { provideTerminalControl } from "@kitlangton/terminal-control-opentui"

const terminalControl = provideTerminalControl(renderer, {
  application: { name: "laziergit" },
})
renderer.once("destroy", () => terminalControl.close())
```

When `TERMCTRL_SEMANTIC_SOCKET` is absent this returns a disabled no-op provider. `--host opentui`
is a **Terminal Control launch option**, not an argument to append to laziergit's application argv;
the equivalent typed-client option is the sibling launch property `host: "opentui"`. In that mode,
Terminal Control creates a new owner-only Unix socket, injects its path into the child environment,
and also answers OpenTUI startup capability probes. The provider waits for renderer idle before
walking the live tree. Sources:
[adapter README](https://github.com/anomalyco/terminal-control/blob/v0.6.0/packages/opentui/README.md),
[adapter wiring](https://github.com/anomalyco/terminal-control/blob/v0.6.0/packages/opentui/src/index.ts#L126-L142),
[no-op and reconnect behavior](https://github.com/anomalyco/terminal-control/blob/v0.6.0/packages/opentui/src/provider.ts#L13-L132),
[host profile](https://github.com/anomalyco/terminal-control/blob/v0.6.0/src/main.rs#L882-L886).

Protocol v1 is newline-delimited UTF-8 JSON over that socket, capped at 8 MiB per message. The
adapter sends a `hello` with application identity and `semantic.snapshot`, Terminal Control replies
`ready`, and later requests snapshots by safe-integer ID. The official result has format
`termctrl-semantic-snapshot-v1`; a semantic CLI read has a 1000 ms default absolute deadline and
forces reconnection after a timeout. Source:
[semantic protocol](https://github.com/anomalyco/terminal-control/blob/v0.6.0/docs/semantic-protocol.md).

The official adapter does **not** emit the whole rendered UI tree. It filters to visible elements
that are focusable, mouse-clickable, or the current focused editor, then emits:

```ts
{
  format: "termctrl-semantic-snapshot-v1",
  nodes: Array<{
    id: string
    role: "textbox" | "button" | "control"
    label?: string
    element: number
    focused: boolean
    disabled: false
  }>
}
```

Therefore semantic output can support focus/control assertions, but it cannot replace visible-text
checks for every pane title, row, diff, or notification. Source:
[adapter tree walk and schema](https://github.com/anomalyco/terminal-control/blob/v0.6.0/packages/opentui/src/index.ts#L4-L111).

## Bun, Vitest, and CI

The client is ESM with a `node >=20` engine declaration, but upstream explicitly validates a clean
Bun consumer that installs the packed package, resolves the native binary, launches a PTY, and
captures its screen. Its own integration suite runs under `bun:test`. The optional
`@kitlangton/terminal-control/vitest` export supports Vitest `>=3.0.0` and adds exact
`toHaveScreenText`; ordinary `toMatchSnapshot()` works without that matcher. Sources:
[client manifest](https://github.com/anomalyco/terminal-control/blob/v0.6.0/packages/test/package.json),
[clean Bun and Vitest consumer validation](https://github.com/anomalyco/terminal-control/blob/v0.6.0/scripts/validate-npm-packages.mjs#L94-L136),
[Vitest matcher](https://github.com/anomalyco/terminal-control/blob/v0.6.0/packages/test/src/vitest.ts).

For laziergit CI:

- `bun install --frozen-lockfile` is sufficient; consumer jobs need no Rust, Zig, Cargo, global
  binary, postinstall script, or system package.
- Run `test:e2e` only on `ubuntu-latest` and `macos-latest`. Keep Windows on the fast verification
  job but skip E2E there because no Windows native package exists.
- GitHub-hosted Ubuntu is glibc x64 and both current macOS runner architectures are packaged.
- Upload `.termctrl-artifacts` only on failure. Treat transcripts, recordings, and semantic JSON as
  potentially sensitive; environment values are redacted from metadata, while transcripts and
  recordings are opt-in.

Sources: [published-package validation matrix](https://github.com/anomalyco/terminal-control/blob/v0.6.0/.github/workflows/npm-release.yml#L83-L110),
[failure artifact behavior](https://github.com/anomalyco/terminal-control/blob/v0.6.0/docs/typescript-client.md#vitest-matchers-and-failure-evidence),
[semantic security contract](https://github.com/anomalyco/terminal-control/blob/v0.6.0/docs/semantic-protocol.md#security).
