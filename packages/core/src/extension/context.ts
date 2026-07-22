import type {
  CommandRegistry,
  ConfigValue,
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

import type { LayoutHost } from "../ui/layout"
import type { MenuHost } from "../ui/menu-host"
import type { PopupHandle, PopupHost } from "../ui/popup-host"
import type { StatuslineHost } from "../ui/statusline-host"
import type { ActivationScope } from "./activation-scope"
import type { CommandHost } from "./command-host"
import type { Diagnostics } from "./diagnostics"
import type { EventHost } from "./event-host"
import { GitPlaceholder, gitUnavailable } from "./git-placeholder"
import { assertScopedId } from "./id"
import type { PaneHost } from "./pane-host"
import { bindNotifier, type Notifier } from "./notifier"

export type ExtensionApiLookup = { readonly state: "live"; readonly api: unknown } | { readonly state: "missing" }

export interface ContextHosts {
  readonly repoRoot: string
  readonly diagnostics: Diagnostics
  readonly events: EventHost
  readonly commands: CommandHost
  readonly panes: PaneHost
  readonly layout: LayoutHost
  readonly menus: MenuHost
  readonly popups: PopupHost
  readonly statusline: StatuslineHost
  readonly git: GitPlaceholder
  readonly notifier: Notifier
  getExtensionApi(name: string): ExtensionApiLookup
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
 * Modal flows belong to their caller. The popup is dismissed when the scope closes, and
 * because the scope clears the pending settlement first, the dismissal's own resolution
 * is dropped — the awaited call never settles rather than resuming on a stale ctx.
 */
function supervisePopup<T>(scope: ActivationScope, handle: PopupHandle<T>): Promise<T> {
  return scope.supervise(handle.promise, () => handle.dismiss())
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
      const registration = hosts.panes.register(extension, spec)
      const tracked = scope.track(() => registration.dispose())
      const handle: PaneHandle = {
        dispose: () => tracked.dispose(),
        focus: () => hosts.layout.focus(spec.id),
      }
      return scope.guard(handle, ["dispose"])
    },
  })

  const menus = scope.guard<MenuRegistry>({
    register(spec) {
      const title = spec.title
      return attachDisposable(
        scope,
        hosts.menus.register(extension, {
          id: spec.id,
          title: typeof title === "string" ? () => title : title,
          groups: spec.groups,
        }),
      )
    },
    extend(id, splice) {
      return attachDisposable(scope, hosts.menus.extend(extension, id, splice))
    },
    open(id, target) {
      // Documented as a rejection, so an unregistered id cannot throw synchronously past
      // an `await` the caller wrote in good faith.
      try {
        return supervisePopup(scope, hosts.menus.open(extension, id, target))
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    },
  })

  const popups = scope.guard<PopupToolkit>({
    confirm(options) {
      return supervisePopup(scope, hosts.popups.confirm(extension, options))
    },
    prompt(options) {
      return supervisePopup(scope, hosts.popups.prompt(extension, options))
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
      return supervisePopup(scope, hosts.menus.adhoc(extension, options.title, options.groups))
    },
    notify: bindNotifier(hosts.notifier, extension),
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
    config,
    git,
    events,
    commands,
    panes,
    menus,
    popups,
    statusline,
    extensions: scope.guard({
      get(name: string) {
        const lookup = hosts.getExtensionApi(name)
        if (lookup.state === "missing") throw new Error(`Required extension "${name}" has no live API`)
        return guardConsumedApi(lookup.api, scope)
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
