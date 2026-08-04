import { Effect, Queue, Stream } from "effect"
import type {
  CommandRegistry,
  ConfigValue,
  Disposable,
  EffectEscape,
  EventBus,
  EventMap,
  ExecOptions,
  ExecOutput,
  ExtensionContext,
  Git,
  PaneHandle,
  PaneRegistry,
  PopupToolkit,
  Statusline,
} from "laziergit"

import type { GitService } from "../git/service"
import type { LayoutHost } from "../ui/layout"
import type { PopupActionGroup, PopupHandle, PopupHost } from "../ui/popup-host"
import type { StatuslineHost } from "../ui/statusline-host"
import type { ActivationScope } from "./activation-scope"
import type { CommandHost } from "./command-host"
import { normalizeError, type Diagnostics } from "./diagnostics"
import type { EventHost } from "./event-host"
import { assertScopedId } from "./id"
import type { PaneHost } from "./pane-host"
import { bindNotifier, type Notifier } from "./notifier"

export type ExtensionApiLookup = { readonly state: "live"; readonly api: unknown } | { readonly state: "missing" }
export type ClipboardWriterSpec = readonly [command: string, args: readonly string[]]
export type ExternalOpener = (url: string) => Promise<void>

export interface ContextHosts {
  readonly diagnostics: Diagnostics
  readonly events: EventHost
  readonly commands: CommandHost
  readonly panes: PaneHost
  readonly layout: LayoutHost
  readonly popups: PopupHost
  readonly statusline: StatuslineHost
  readonly git: GitService
  readonly notifier: Notifier
  readonly clipboardWriters?: readonly ClipboardWriterSpec[]
  readonly openExternal?: ExternalOpener
  getExtensionApi(name: string): ExtensionApiLookup
}

function popupMenuGroups(
  extension: string,
  title: string,
  groups: Parameters<PopupToolkit["menu"]>[0]["groups"],
  hosts: ContextHosts,
): readonly PopupActionGroup[] {
  const visible = groups.map((group, groupIndex) => ({
    group,
    items: group.items.flatMap((item, itemIndex) => {
      try {
        return item.when?.() === false ? [] : [{ item, groupIndex, itemIndex }]
      } catch (error) {
        const normalized = normalizeError(error)
        hosts.diagnostics.report({
          extension,
          phase: "menu",
          message: `${title} item "${item.label}" when(): ${normalized.message}`,
          error: normalized,
        })
        return []
      }
    }),
  }))
  const winnerByKey = new Map<string, (typeof visible)[number]["items"][number]>()
  for (const { items } of visible) {
    for (const owned of items) {
      const previous = winnerByKey.get(owned.item.key)
      if (previous !== undefined) {
        hosts.diagnostics.report({
          extension,
          phase: "menu",
          message: `${title} key "${owned.item.key}" moved from "${previous.item.label}" to "${owned.item.label}"`,
        })
      }
      winnerByKey.set(owned.item.key, owned)
    }
  }

  return visible.flatMap(({ group, items }) => {
    const rendered = items.flatMap((owned) => {
      const item = owned.item
      if (winnerByKey.get(item.key) !== owned) return []
      return [
        {
          key: item.key,
          label: item.label,
          run: async () => {
            try {
              await item.run()
            } catch (error) {
              const normalized = normalizeError(error)
              hosts.diagnostics.report({
                extension,
                phase: "menu",
                message: `${title} item "${item.label}": ${normalized.message}`,
                error: normalized,
              })
              hosts.notifier({ extension, message: `${item.label}: ${normalized.message}`, level: "error" })
            }
          },
        },
      ]
    })
    return rendered.length === 0 ? [] : [{ title: group.title, items: rendered }]
  })
}

function attachDisposable<T extends Disposable>(scope: ActivationScope, disposable: T, staleNoops = ["dispose"]): T {
  const tracked = scope.track(() => disposable.dispose())
  const handle = new Proxy(disposable, {
    get(target, property, receiver) {
      if (property === "dispose") return () => tracked.dispose()
      const member = Reflect.get(target, property, receiver) as unknown
      return typeof member === "function" ? member.bind(target) : member
    },
  })
  return scope.guard(handle, staleNoops)
}

/**
 * Modal flows belong to their caller. The popup is dismissed when the scope closes, and the
 * scope clears the pending settlement first, so the awaited call never settles rather than
 * resuming on a stale ctx.
 */
function supervisePopup<T>(scope: ActivationScope, handle: PopupHandle<T>): Promise<T> {
  return scope.supervise(handle.promise, () => handle.dismiss())
}

/**
 * The one Effect door. It hands out core's own git effects rather than re-wrapping the Promise
 * surface, but only bound services and `runPromise` cross the boundary — never a service key
 * or a runtime.
 */
function createEffectEscape(extension: string, scope: ActivationScope, hosts: ContextHosts): EffectEscape {
  return {
    git: {
      raw: (args, options) => hosts.git.rawEffect(args, options),
      state: hosts.git.stateEffect,
      changes: hosts.git.changes,
    },
    events: {
      // Checked inside the Effect, not when it is described: this door must be the same gate
      // as `ctx.events.emit`, or it would be the way around it.
      publish: (event, ...payload) =>
        Effect.sync(() => {
          assertScopedId(extension, event)
          hosts.events.emit(event, payload[0])
        }),
      stream: <K extends keyof EventMap & string>(event: K) =>
        Stream.callback<EventMap[K]>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              hosts.events.subscribe(extension, event, (payload) => {
                Queue.offerUnsafe(queue, payload)
              }),
            ),
            (subscription) => Effect.sync(() => subscription.dispose()),
          ),
        ),
    },
    runPromise: (effect) => scope.runEffect(effect),
  }
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}

function isDisposable(value: unknown): value is Disposable {
  if (!isObjectLike(value)) return false
  return typeof Reflect.get(value, "dispose") === "function"
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (!isObjectLike(value)) return false
  return typeof Reflect.get(value, "then") === "function"
}

function processExportedApiResult(result: unknown, scope: ActivationScope): unknown {
  if (isDisposable(result)) {
    return attachDisposable(scope, result, "refresh" in result ? ["dispose", "refresh"] : ["dispose"])
  }
  if (isPromiseLike(result)) {
    const processed = Promise.resolve(result).then((value) => processExportedApiResult(value, scope))
    return scope.supervise(processed)
  }
  return result
}

function guardConsumedApi(api: unknown, scope: ActivationScope): unknown {
  if (!isObjectLike(api)) return api

  return new Proxy(api, {
    get(target, property, receiver) {
      scope.assertActive()
      const member = Reflect.get(target, property, receiver) as unknown
      if (typeof member !== "function") return member

      return (...args: unknown[]) => {
        scope.assertActive()
        return processExportedApiResult(Reflect.apply(member, target, args), scope)
      }
    },
    apply(target, thisArg, args) {
      scope.assertActive()
      return processExportedApiResult(Reflect.apply(target as (...values: unknown[]) => unknown, thisArg, args), scope)
    },
  })
}

/**
 * The bound on one clipboard writer. Writing to the clipboard is IPC with a compositor, so a
 * writer that has not finished in this long is stuck — and the cascade in
 * {@link ExtensionContext.copy} is sequential, so it costs the caller's Command.
 */
const clipboardTimeoutMs = 2_000

/**
 * The clipboard writers worth trying on a platform, most likely first. Every one takes the
 * text on stdin rather than in argv, so nothing a user copies can be read as an option. A
 * Linux session has exactly one of the three installed, and which one is a property of the
 * session rather than of the distribution.
 */
function clipboardWriters(platform: NodeJS.Platform): readonly ClipboardWriterSpec[] {
  if (platform === "darwin") return [["pbcopy", []]]
  if (platform === "win32") return [["clip", []]]
  return [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ]
}

/**
 * How long a finished command's pipes are still drained. `child.exited` is the honest end of a
 * command; its pipes are not, because anything the child spawned inherits them — `wl-copy`
 * daemonises exactly this way. So the pipes get a short grace period after the exit; a
 * well-behaved child's output is already there.
 */
const pipeGraceMs = 100

/** Whatever an in-flight read has produced `graceMs` from now, and the empty string if it is still stuck. */
function settledWithin(text: Promise<string>, graceMs: number): Promise<string> {
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve(""), graceMs)
    void text.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve("")
      },
    )
  })
}

function exec(
  scope: ActivationScope,
  repoRoot: string,
  command: string,
  args: readonly string[],
  options: ExecOptions,
) {
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined

  const pending = (async (): Promise<ExecOutput> => {
    child = Bun.spawn([command, ...args], {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...options.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

    if (options.stdin) child.stdin.write(options.stdin)
    void child.stdin.end()

    // Started before the exit is awaited: a child that fills the pipe buffer blocks until
    // someone reads it, so a read beginning after `child.exited` would deadlock on any output
    // larger than a pipe.
    const stdoutText = new Response(child.stdout).text()
    const stderrText = new Response(child.stderr).text()
    // The timeout path abandons both reads; neither may become an unhandled rejection.
    void stdoutText.catch(() => undefined)
    void stderrText.catch(() => undefined)

    const expiry = Promise.withResolvers<never>()
    if (options.timeoutMs !== undefined) {
      const limit = options.timeoutMs
      timeout = setTimeout(() => {
        // Rejecting rather than only killing: a child whose pipes a survivor holds does not
        // die with `kill` alone.
        child?.kill()
        expiry.reject(new Error(`${command} exceeded ${limit}ms`))
      }, limit)
    }
    // The loser of the race must not become an unhandled rejection.
    void expiry.promise.catch(() => undefined)

    try {
      const exitCode = await Promise.race([child.exited, expiry.promise])
      const [stdout, stderr] = await Promise.all([
        settledWithin(stdoutText, pipeGraceMs),
        settledWithin(stderrText, pipeGraceMs),
      ])
      return { stdout, stderr, exitCode }
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  })()

  return scope.supervise(pending, () => {
    if (timeout) clearTimeout(timeout)
    child?.kill()
  })
}

export function createExtensionContext(
  extension: string,
  config: Readonly<Record<string, ConfigValue>>,
  scope: ActivationScope,
  hosts: ContextHosts,
): ExtensionContext {
  const events = scope.guard<EventBus>({
    on(event, handler) {
      return attachDisposable(scope, hosts.events.subscribe(extension, event, handler))
    },
    emit(event, ...payload) {
      assertScopedId(extension, event)
      hosts.events.emit(event, payload[0])
    },
  })

  function registerCommand<Row>(
    spec: import("laziergit").RowCommandSpec<string, Row>,
  ): import("laziergit").CommandHandle
  function registerCommand(spec: import("laziergit").CommandSpec): import("laziergit").CommandHandle
  function registerCommand<Row>(
    spec: import("laziergit").CommandSpec | import("laziergit").RowCommandSpec<string, Row>,
  ): import("laziergit").CommandHandle {
    return attachDisposable(
      scope,
      hosts.commands.register(extension, spec, () => scope.active),
      ["dispose", "refresh"],
    )
  }

  const commands = scope.guard<CommandRegistry>({
    register: registerCommand,
    execute(id) {
      return scope.supervise(hosts.commands.execute(id))
    },
  })

  const panes = scope.guard<PaneRegistry>({
    register(spec) {
      const registration = hosts.panes.register(extension, spec)
      const tracked = scope.track(() => registration.dispose())
      const handle: PaneHandle = {
        dispose: () => tracked.dispose(),
        focus: () => hosts.layout.focus(spec.id),
        reveal: () => hosts.layout.reveal(spec.id),
      }
      return scope.guard(handle, ["dispose"])
    },
  })

  const popups = scope.guard<PopupToolkit>({
    confirm(options) {
      return supervisePopup(scope, hosts.popups.confirm(extension, options))
    },
    prompt(options) {
      return supervisePopup(scope, hosts.popups.prompt(extension, options))
    },
    compose(options) {
      return supervisePopup(scope, hosts.popups.compose(extension, options))
    },
    select(options) {
      const handle = hosts.popups.choose(extension, {
        title: options.title,
        placeholder: options.placeholder,
        choices: options.items.map((item) => ({ label: item.label, hint: item.hint })),
      })
      return scope.supervise(
        handle.promise.then((index) => (index === undefined ? undefined : options.items[index]?.value)),
        () => handle.dismiss(),
      )
    },
    menu(options) {
      return supervisePopup(
        scope,
        hosts.popups.actions(extension, {
          title: options.title,
          groups: popupMenuGroups(extension, options.title, options.groups, hosts),
        }),
      )
    },
    notify: bindNotifier(hosts.notifier, extension),
  })

  const statusline = scope.guard<Statusline>({
    register(spec) {
      return attachDisposable(scope, hosts.statusline.register(extension, spec))
    },
  })

  /**
   * Git work is supervised but never cancelled: a write started while the Extension was live
   * always runs to completion, and a hot reload landing mid-`git commit` parks the promise
   * rather than leaving a half-written repository. This is why `ctx.exec` passes a
   * cancel callback and `ctx.git` does not.
   */
  const supervised = <T>(pending: Promise<T>): Promise<T> => scope.supervise(pending)

  const stash = scope.guard({
    save: (options?: Parameters<Git["stash"]["save"]>[0]) => supervised(hosts.git.stash.save(options)),
    apply: (index?: number) => supervised(hosts.git.stash.apply(index)),
    pop: (index?: number) => supervised(hosts.git.stash.pop(index)),
    drop: (index: number) => supervised(hosts.git.stash.drop(index)),
  })
  const gitRaw: Git = {
    root: hosts.git.root,
    get state() {
      return hosts.git.getSnapshot()
    },
    subscribe(selector, onChange) {
      return attachDisposable(scope, hosts.git.subscribeSelector(selector, onChange))
    },
    refresh: () => supervised(hosts.git.refresh()),
    raw: (args, options) => supervised(hosts.git.raw(args, options)),
    checkout: (ref) => supervised(hosts.git.checkout(ref)),
    createBranch: (name, options) => supervised(hosts.git.createBranch(name, options)),
    deleteBranch: (name, options) => supervised(hosts.git.deleteBranch(name, options)),
    deleteRemoteBranch: (remote, name) => supervised(hosts.git.deleteRemoteBranch(remote, name)),
    stage: (paths) => supervised(hosts.git.stage(paths)),
    unstage: (paths) => supervised(hosts.git.unstage(paths)),
    discard: (paths) => supervised(hosts.git.discard(paths)),
    commit: (message, options) => supervised(hosts.git.commit(message, options)),
    push: (options) => supervised(hosts.git.push(options)),
    pull: (options) => supervised(hosts.git.pull(options)),
    fetch: (options) => supervised(hosts.git.fetch(options)),
    stash,
  }
  const git = scope.guard(gitRaw)

  const raw: ExtensionContext = {
    config,
    git,
    events,
    commands,
    panes,
    popups,
    statusline,
    extensions: scope.guard({
      /**
       * `ExtensionHub.get` returns a type conditional on the caller's own `needs` tuple, which
       * this untyped host can neither compute nor satisfy structurally; `never` is what every
       * instantiation of that conditional accepts.
       */
      get(name: string): never {
        const lookup = hosts.getExtensionApi(name)
        if (lookup.state === "missing") throw new Error(`Required extension "${name}" has no live API`)
        return guardConsumedApi(lookup.api, scope) as never
      },
    }),
    effect: scope.guard(createEffectEscape(extension, scope, hosts)),
    signal: scope.signal,
    exec(command, args = [], options = {}) {
      return exec(scope, hosts.git.root, command, args, options)
    },
    open(url) {
      if (hosts.openExternal !== undefined) return hosts.openExternal(url)
      const [command, args] =
        process.platform === "darwin"
          ? ["open", [url]]
          : process.platform === "win32"
            ? ["cmd", ["/c", "start", "", url]]
            : ["xdg-open", [url]]
      return exec(scope, hosts.git.root, command, args, {}).then((output) => {
        if (output.exitCode !== 0) throw new Error(output.stderr.trim() || `Unable to open ${url}`)
      })
    },
    async copy(text) {
      const writers = hosts.clipboardWriters ?? clipboardWriters(process.platform)
      let failure: Error | undefined
      for (const [command, args] of writers) {
        try {
          const output = await exec(scope, hosts.git.root, command, args, {
            stdin: text,
            timeoutMs: clipboardTimeoutMs,
          })
          if (output.exitCode === 0) return
          failure = new Error(output.stderr.trim() || `${command} exited with ${output.exitCode}`)
        } catch (error) {
          // A writer that is not installed is the ordinary case on a machine with a different
          // session type, so it is a reason to try the next one. The last reason is kept.
          failure = error instanceof Error ? error : new Error(String(error))
        }
      }
      throw failure ?? new Error(`No clipboard tool on this system (tried ${writers.map(([name]) => name).join(", ")})`)
    },
    onDispose(finalizer) {
      scope.track(finalizer)
    },
  }

  return new Proxy(raw, {
    get(target, property, receiver) {
      if (property === "signal") return scope.signal
      scope.assertActive()
      const member = Reflect.get(target, property, receiver) as unknown
      if (typeof member !== "function") return member
      return (...args: unknown[]) => {
        scope.assertActive()
        return Reflect.apply(member, target, args) as unknown
      }
    },
  })
}
