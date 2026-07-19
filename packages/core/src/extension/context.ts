import type {
  CommandRegistry,
  ConfigOption,
  ConfigSchema,
  Disposable,
  EffectEscape,
  EventBus,
  ExecOptions,
  ExecOutput,
  ExtensionContext,
  Git,
  MenuRegistry,
  PaneHandle,
  PaneRegistry,
  PopupToolkit,
  Statusline,
} from "laziergit"

import type { ActivationScope } from "./activation-scope"
import type { CommandHost } from "./command-host"
import type { Diagnostics } from "./diagnostics"
import type { EventHost } from "./event-host"
import { GitPlaceholder, gitUnavailable } from "./git-placeholder"
import { assertScopedId } from "./id"
import type { PaneHost } from "./pane-host"
import type { MenuHost, StatuslineHost } from "./registry-hosts"

export interface ContextHosts {
  readonly repoRoot: string
  readonly diagnostics: Diagnostics
  readonly events: EventHost
  readonly commands: CommandHost
  readonly panes: PaneHost
  readonly menus: MenuHost
  readonly statusline: StatuslineHost
  readonly git: GitPlaceholder
  getExtensionApi(name: string): unknown
}

interface InternalConfigOption extends ConfigOption {
  readonly min?: number
  readonly max?: number
  readonly values?: readonly string[]
}

export function configDefaults(schema: ConfigSchema | undefined): Readonly<Record<string, unknown>> {
  if (!schema) return Object.freeze({})
  return Object.freeze(
    Object.fromEntries(
      Object.entries(schema).map(([key, value]) => [
        key,
        Array.isArray(value.default) ? Object.freeze([...value.default]) : value.default,
      ]),
    ),
  )
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

function unavailableEffectEscape(): EffectEscape {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("ctx.effect services arrive with the Effect service graph in M3")
      },
    },
  ) as EffectEscape
}

function guardConsumedApi(api: unknown, scope: ActivationScope): unknown {
  if ((typeof api !== "object" || api === null) && typeof api !== "function") return api

  return new Proxy(api as object, {
    get(target, property, receiver) {
      scope.assertActive()
      const member = Reflect.get(target, property, receiver) as unknown
      if (typeof member !== "function") return member

      return (...args: unknown[]) => {
        scope.assertActive()
        const result = Reflect.apply(member, target, args) as unknown
        if (result && typeof result === "object" && "dispose" in result) {
          return attachDisposable(
            scope,
            result as Disposable,
            "refresh" in result ? ["dispose", "refresh"] : ["dispose"],
          )
        }
        if (result instanceof Promise) return scope.supervise(result)
        return result
      }
    },
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
  let timedOut = false

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

    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true
        child?.kill()
      }, options.timeoutMs)
    }

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (timeout) clearTimeout(timeout)
    if (timedOut) throw new Error(`${command} exceeded ${options.timeoutMs}ms`)
    return { stdout, stderr, exitCode }
  })()

  return scope.supervise(pending, () => {
    if (timeout) clearTimeout(timeout)
    child?.kill()
  })
}

export function createExtensionContext(
  extension: string,
  schema: ConfigSchema | undefined,
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

  const commands = scope.guard<CommandRegistry>({
    register(spec) {
      return attachDisposable(scope, hosts.commands.register(extension, spec))
    },
    execute(id) {
      return scope.supervise(hosts.commands.execute(id))
    },
  })

  const panes = scope.guard<PaneRegistry>({
    register(spec) {
      const raw = hosts.panes.register(extension, spec)
      const tracked = scope.track(() => raw.dispose())
      const handle: PaneHandle = {
        dispose: () => tracked.dispose(),
        focus: () => raw.focus(),
      }
      return scope.guard(handle, ["dispose"])
    },
  })

  const menus = scope.guard<MenuRegistry>({
    register(spec) {
      return attachDisposable(scope, hosts.menus.register(extension, spec))
    },
    extend(id, splice) {
      return attachDisposable(scope, hosts.menus.extend(extension, id, splice))
    },
    open() {
      return scope.supervise(Promise.reject(new Error("Menus arrive in M2")))
    },
  })

  const popups = scope.guard<PopupToolkit>({
    confirm: () => scope.supervise(Promise.reject(new Error("Popups arrive in M2"))),
    prompt: () => scope.supervise(Promise.reject(new Error("Popups arrive in M2"))),
    select: <T>() => scope.supervise<T | undefined>(Promise.reject(new Error("Popups arrive in M2"))),
    menu: () => scope.supervise(Promise.reject(new Error("Popups arrive in M2"))),
    notify(message, level = "info") {
      console.error(`[${extension}] ${level}: ${message}`)
    },
  })

  const statusline = scope.guard<Statusline>({
    register(spec) {
      return attachDisposable(scope, hosts.statusline.register(extension, spec))
    },
  })

  const stash = scope.guard({
    save: gitUnavailable,
    apply: gitUnavailable,
    pop: gitUnavailable,
    drop: gitUnavailable,
  })
  const gitRaw: Git = {
    root: hosts.repoRoot,
    get state() {
      return hosts.git.getSnapshot()
    },
    subscribe(selector, onChange) {
      return attachDisposable(scope, hosts.git.subscribeSelector(selector, onChange))
    },
    refresh: gitUnavailable,
    raw: gitUnavailable,
    checkout: gitUnavailable,
    createBranch: gitUnavailable,
    deleteBranch: gitUnavailable,
    stage: gitUnavailable,
    unstage: gitUnavailable,
    discard: gitUnavailable,
    commit: gitUnavailable,
    push: gitUnavailable,
    pull: gitUnavailable,
    fetch: gitUnavailable,
    stash,
  }
  const git = scope.guard(gitRaw)

  const raw: ExtensionContext = {
    config: configDefaults(schema) as never,
    git,
    events,
    commands,
    panes,
    menus,
    popups,
    statusline,
    extensions: scope.guard({
      get(name: string) {
        const api = hosts.getExtensionApi(name)
        if (api === undefined) throw new Error(`Required extension "${name}" has no live API`)
        return guardConsumedApi(api, scope)
      },
    } as object) as never,
    effect: scope.guard(unavailableEffectEscape()),
    signal: scope.signal,
    exec(command, args = [], options = {}) {
      return exec(scope, hosts.repoRoot, command, args, options)
    },
    open(url) {
      const [command, args] =
        process.platform === "darwin"
          ? ["open", [url]]
          : process.platform === "win32"
            ? ["cmd", ["/c", "start", "", url]]
            : ["xdg-open", [url]]
      return exec(scope, hosts.repoRoot, command, args, {}).then((output) => {
        if (output.exitCode !== 0) throw new Error(output.stderr.trim() || `Unable to open ${url}`)
      })
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

export function readInternalConfigOption(option: ConfigOption): InternalConfigOption {
  return option as InternalConfigOption
}
