import { createContext, createElement, type ReactNode } from "react"

export const RuntimeContext = createContext<unknown>(null)
export const PaneRuntimeContext = createContext<unknown>(null)

export function RuntimeProvider(props: { runtime: unknown; children?: ReactNode }) {
  return createElement(RuntimeContext.Provider, { value: props.runtime }, props.children)
}

export function PaneRuntimeProvider(props: { value: unknown; children?: ReactNode }) {
  return createElement(PaneRuntimeContext.Provider, { value: props.value }, props.children)
}

const extensionNamePattern = /^[a-z][a-z0-9-]*$/
const reservedExtensionNames = new Set(["app", "git"])
const extensionDefinitions = new WeakSet<object>()
const configKinds = new Set(["string", "number", "boolean", "enum", "string-array"])

interface ExtensionSpecShape {
  readonly name: string
  readonly description?: string
  readonly config?: Readonly<Record<string, unknown>>
  readonly needs?: readonly string[]
  readonly activate: (...args: never[]) => unknown
  readonly deactivate?: (...args: never[]) => unknown
}

export interface RuntimeExtensionDefinition {
  readonly spec: ExtensionSpecShape
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidName(name: unknown, label = "extension name"): never {
  const rendered = typeof name === "string" ? `"${name}"` : String(name)
  if (typeof name === "string" && reservedExtensionNames.has(name)) {
    throw new TypeError(`Invalid ${label} ${rendered}. "app" and "git" are reserved.`)
  }
  throw new TypeError(`Invalid ${label} ${rendered}. Use lowercase kebab-case.`)
}

function assertValidName(name: unknown, label = "extension name"): asserts name is string {
  if (typeof name !== "string" || !extensionNamePattern.test(name) || reservedExtensionNames.has(name)) {
    invalidName(name, label)
  }
}

function assertOptionalDescription(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new TypeError(`${label} must be a string`)
  }
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`)
  }
}

function assertStringArray(value: unknown, label: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${label} must be an array of strings`)
  }
}

function validateConfigOption(extension: string, key: string, value: unknown): void {
  const label = `Extension "${extension}" config option "${key}"`
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  if (typeof value.kind !== "string" || !configKinds.has(value.kind)) {
    throw new TypeError(`${label} has invalid kind "${String(value.kind)}"`)
  }
  assertOptionalDescription(value.description, `${label} description`)

  switch (value.kind) {
    case "string":
      if (typeof value.default !== "string") throw new TypeError(`${label} default must be a string`)
      break
    case "number": {
      assertFiniteNumber(value.default, `${label} default`)
      if (value.min !== undefined) assertFiniteNumber(value.min, `${label} min`)
      if (value.max !== undefined) assertFiniteNumber(value.max, `${label} max`)
      if (typeof value.min === "number" && typeof value.max === "number" && value.min > value.max) {
        throw new TypeError(`${label} min must not exceed max`)
      }
      if (typeof value.min === "number" && value.default < value.min) {
        throw new TypeError(`${label} default must be at least min`)
      }
      if (typeof value.max === "number" && value.default > value.max) {
        throw new TypeError(`${label} default must be at most max`)
      }
      break
    }
    case "boolean":
      if (typeof value.default !== "boolean") throw new TypeError(`${label} default must be a boolean`)
      break
    case "enum": {
      assertStringArray(value.values, `${label} values`)
      if (new Set(value.values).size !== value.values.length) {
        throw new TypeError(`${label} values must be unique`)
      }
      if (typeof value.default !== "string" || !value.values.includes(value.default)) {
        throw new TypeError(`${label} default must be one of its declared values`)
      }
      break
    }
    case "string-array":
      assertStringArray(value.default, `${label} default`)
      break
  }
}

export function validateExtensionSpec(value: unknown): asserts value is ExtensionSpecShape {
  if (!isRecord(value)) throw new TypeError("Extension spec must be an object")
  assertValidName(value.name)
  const name = value.name
  assertOptionalDescription(value.description, `Extension "${name}" description`)

  if (typeof value.activate !== "function") {
    throw new TypeError(`Extension "${name}" must provide activate(ctx)`)
  }
  if (value.deactivate !== undefined && typeof value.deactivate !== "function") {
    throw new TypeError(`Extension "${name}" deactivate must be a function`)
  }

  if (value.needs !== undefined) {
    if (!Array.isArray(value.needs)) throw new TypeError(`Extension "${name}" needs must be an array`)
    const seen = new Set<string>()
    for (const need of value.needs) {
      assertValidName(need, `need in Extension "${name}"`)
      if (seen.has(need)) throw new TypeError(`Extension "${name}" needs contains duplicate "${need}"`)
      seen.add(need)
    }
  }

  if (value.config !== undefined) {
    if (!isRecord(value.config)) throw new TypeError(`Extension "${name}" config must be an object`)
    for (const [key, option] of Object.entries(value.config)) validateConfigOption(name, key, option)
  }
}

/**
 * Deep-freezes the two option kinds carrying an array, so an Extension cannot keep a handle
 * on its own schema and mutate it after the host has read it.
 *
 * Re-narrowed with guards rather than asserted from {@link validateConfigOption}'s result:
 * that runs in another function, so its proof does not reach here, and an Extension arrives
 * as untypechecked source (ADR-0003) — the values really are `unknown` at this point, and
 * parsing them is honest where asserting would only be shorter.
 */
function normalizeConfigOption(option: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const normalized = { ...option }
  const { values, default: fallback } = option
  if (option.kind === "enum" && Array.isArray(values)) normalized.values = Object.freeze([...values])
  if (option.kind === "string-array" && Array.isArray(fallback)) normalized.default = Object.freeze([...fallback])
  return Object.freeze(normalized)
}

function normalizeConfig(config: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(config).map(([key, option]) => [key, isRecord(option) ? normalizeConfigOption(option) : option]),
    ),
  )
}

function normalizeExtensionSpec<TSpec extends object & ExtensionSpecShape>(spec: TSpec): TSpec {
  const normalized = {
    ...spec,
    ...(spec.config === undefined ? {} : { config: normalizeConfig(spec.config) }),
    ...(spec.needs === undefined ? {} : { needs: Object.freeze([...spec.needs]) }),
  }
  // The spread rebuilds `spec`'s own properties and overwrites two of them with values of
  // the same declared types, so this is `TSpec` — but a spread of a generic widens to its
  // constraint, which is the one thing TypeScript cannot carry through.
  return Object.freeze(normalized) as TSpec
}

export function createExtensionDefinition<const TSpec extends object>(spec: TSpec): Readonly<{ readonly spec: TSpec }> {
  validateExtensionSpec(spec)
  const definition = Object.freeze({ spec: normalizeExtensionSpec(spec) })
  extensionDefinitions.add(definition)
  return definition
}

export function assertExtensionDefinition(value: unknown): asserts value is RuntimeExtensionDefinition {
  if (!isRecord(value) || !extensionDefinitions.has(value)) {
    throw new TypeError("Default export must be defineExtension({...})")
  }
  validateExtensionSpec(value.spec)
}
