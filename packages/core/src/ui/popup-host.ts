/** One row of a filterable picker. Values stay with the caller; the popup resolves an index. */
export interface PopupChoice {
  readonly label: string
  readonly hint?: string
}

/** A keyed action inside a menu popup, already bound to its target by the menu layer. */
export interface PopupAction {
  readonly key: string
  readonly label: string
  run(): void | Promise<void>
}

export interface PopupActionGroup {
  readonly title?: string
  readonly items: readonly PopupAction[]
}

export interface CheatSheetEntry {
  readonly keys: readonly string[]
  readonly title: string
}

export interface CheatSheetSection {
  readonly title: string
  readonly entries: readonly CheatSheetEntry[]
}

interface PopupBase {
  readonly id: number
  /**
   * Extensions whose deactivation must close this popup: the caller, plus every
   * Extension whose spliced menu items are on screen.
   */
  readonly contributors: ReadonlySet<string>
  readonly title: string
  /** Resolves the caller's promise with the dismissed outcome. Idempotent. */
  dismiss(): void
}

export interface ConfirmPopup extends PopupBase {
  readonly kind: "confirm"
  readonly message: string | undefined
  readonly confirmLabel: string
  readonly danger: boolean
  confirm(): void
}

export interface PromptPopup extends PopupBase {
  readonly kind: "prompt"
  readonly placeholder: string | undefined
  readonly initial: string
  validate(value: string): string | null
  submit(value: string): void
}

export interface ChoosePopup extends PopupBase {
  readonly kind: "choose"
  readonly choices: readonly PopupChoice[]
  readonly placeholder: string | undefined
  /** Resolves with the index into the ORIGINAL choices, whatever the filter showed. */
  choose(index: number): void
}

export interface ActionsPopup extends PopupBase {
  readonly kind: "actions"
  readonly groups: readonly PopupActionGroup[]
}

export interface CheatSheetPopup extends PopupBase {
  readonly kind: "cheatsheet"
  readonly sections: readonly CheatSheetSection[]
}

export type Popup = ConfirmPopup | PromptPopup | ChoosePopup | ActionsPopup | CheatSheetPopup

export interface ConfirmOptions {
  readonly title: string
  readonly message?: string
  readonly confirmLabel?: string
  readonly danger?: boolean
}

export interface PromptOptions {
  readonly title: string
  readonly placeholder?: string
  readonly initial?: string
  validate?(value: string): string | null
}

export interface ChooseOptions {
  readonly title: string
  readonly choices: readonly PopupChoice[]
  readonly placeholder?: string
}

export interface ActionsOptions {
  readonly title: string
  readonly groups: readonly PopupActionGroup[]
  /** Extensions besides the opener whose items appear, so their reload closes the menu. */
  readonly contributors?: Iterable<string>
}

/**
 * An open popup. The caller awaits `promise`; `dismiss` is what an activation scope
 * calls when its Extension goes down mid-flow, so the popup leaves the screen while the
 * pending promise is parked rather than resumed against a stale ctx.
 */
export interface PopupHandle<T> {
  readonly promise: Promise<T>
  dismiss(): void
}

/**
 * The modal stack. Popups are owned by whoever opened them: a hot reload that takes the
 * owner down closes the popup as if it had been dismissed. Only the top popup is
 * interactive, so a nested flow can never route a keypress into the one underneath it.
 */
export class PopupHost {
  readonly #listeners = new Set<() => void>()
  #stack: readonly Popup[] = []
  #nextId = 1
  #onModalChange: ((open: boolean) => void) | undefined

  getSnapshot = (): readonly Popup[] => this.#stack

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Notified whenever the screen becomes, or stops being, modal. */
  setModalListener(listener: (open: boolean) => void): void {
    this.#onModalChange = listener
  }

  get top(): Popup | undefined {
    return this.#stack[this.#stack.length - 1]
  }

  confirm(owner: string, options: ConfirmOptions): PopupHandle<boolean> {
    return this.#open<boolean>(owner, options.title, false, (base, settle) => ({
      ...base,
      kind: "confirm",
      message: options.message,
      confirmLabel: options.confirmLabel ?? "Confirm",
      danger: options.danger === true,
      confirm: () => settle(true),
    }))
  }

  prompt(owner: string, options: PromptOptions): PopupHandle<string | undefined> {
    return this.#open<string | undefined>(owner, options.title, undefined, (base, settle) => ({
      ...base,
      kind: "prompt",
      placeholder: options.placeholder,
      initial: options.initial ?? "",
      validate: (value) => options.validate?.(value) ?? null,
      submit: (value) => settle(value),
    }))
  }

  choose(owner: string, options: ChooseOptions): PopupHandle<number | undefined> {
    return this.#open<number | undefined>(owner, options.title, undefined, (base, settle) => ({
      ...base,
      kind: "choose",
      choices: options.choices,
      placeholder: options.placeholder,
      choose: (index) => settle(index),
    }))
  }

  actions(owner: string, options: ActionsOptions): PopupHandle<void> {
    return this.#open<void>(owner, options.title, undefined, (base) => ({
      ...base,
      kind: "actions",
      contributors: new Set([owner, ...(options.contributors ?? [])]),
      groups: options.groups,
    }))
  }

  cheatSheet(owner: string, title: string, sections: readonly CheatSheetSection[]): PopupHandle<void> {
    return this.#open<void>(owner, title, undefined, (base) => ({ ...base, kind: "cheatsheet", sections }))
  }

  /** Escape: closes the top popup as if the user cancelled it. */
  dismissTop(): void {
    this.top?.dismiss()
  }

  /** A contributing Extension went down — the popup can no longer be trusted to act. */
  closeForExtension(name: string): void {
    // `dismiss` replaces the stack rather than mutating it, so this walks a stable list.
    for (const popup of this.#stack) {
      if (popup.contributors.has(name)) popup.dismiss()
    }
  }

  closeAll(): void {
    for (const popup of this.#stack) popup.dismiss()
  }

  #open<T>(
    owner: string,
    title: string,
    cancelled: T,
    build: (base: PopupBase, settle: (value: T) => void) => Popup,
  ): PopupHandle<T> {
    const id = this.#nextId++
    let settle: (value: T) => void = () => undefined

    const promise = new Promise<T>((resolve) => {
      let settled = false
      settle = (value) => {
        if (settled) return
        settled = true
        this.#remove(id)
        resolve(value)
      }
    })

    const dismiss = (): void => settle(cancelled)
    const popup = build({ id, contributors: new Set([owner]), title, dismiss }, (value) => settle(value))
    this.#stack = [...this.#stack, popup]
    this.#publish()

    return { promise, dismiss }
  }

  #remove(id: number): void {
    const remaining = this.#stack.filter((popup) => popup.id !== id)
    if (remaining.length === this.#stack.length) return
    this.#stack = remaining
    this.#publish()
  }

  #publish(): void {
    try {
      this.#onModalChange?.(this.#stack.length > 0)
    } catch {
      // A modal observer cannot change what is on the stack.
    }
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener()
      } catch {
        // Snapshot observers cannot poison the modal stack.
      }
    }
  }
}
