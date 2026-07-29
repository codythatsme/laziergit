import { randomUUID } from "node:crypto"
import { open, readFile, rename, stat, unlink, mkdir } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { applyEdits, modify, type FormattingOptions } from "jsonc-parser"

import type { ThemeSelection } from "../theme/selection"
import { parseJsonc } from "./jsonc"

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined
}

function formattingOptions(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const indentation = /(?:^|\r?\n)([ \t]+)"/.exec(text)?.[1]
  if (indentation?.startsWith("\t")) return { eol, insertSpaces: false, tabSize: 1 }
  return { eol, insertSpaces: true, tabSize: indentation?.length ?? 2 }
}

function assertThemeName(name: string, path: string): void {
  if (name.trim().length === 0) throw new Error(`${path} must be a non-empty theme name`)
}

function validateSelection(selection: ThemeSelection): void {
  if (typeof selection === "string") {
    assertThemeName(selection, "theme.preset")
    return
  }
  assertThemeName(selection.dark, "theme.preset.dark")
  assertThemeName(selection.light, "theme.preset.light")
}

/** Returns the smallest JSONC edit that sets theme.preset while preserving surrounding trivia. */
export function setThemeSelection(text: string, selection: ThemeSelection): string {
  validateSelection(selection)
  const parsed = parseJsonc(text)
  if (parsed !== undefined && !isRecord(parsed)) throw new Error("config.jsonc must contain a JSON object")

  const source = parsed === undefined ? "{}\n" : text
  const edits = modify(source, ["theme", "preset"], selection, {
    formattingOptions: formattingOptions(source),
  })
  return applyEdits(source, edits)
}

async function readConfig(path: string): Promise<{ readonly text: string; readonly mode: number }> {
  try {
    const [text, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)])
    return { text, mode: metadata.mode & 0o777 }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { text: "", mode: 0o600 }
    throw error
  }
}

/**
 * Sets theme.preset in a config file. The replacement is written beside the target and renamed,
 * so the config watcher can only observe the complete old or complete new document.
 */
export async function writeThemeSelection(path: string, selection: ThemeSelection): Promise<void> {
  const existing = await readConfig(path)
  const updated = setThemeSelection(existing.text, selection)
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })

  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(temporary, "wx", existing.mode)
    await file.writeFile(updated, "utf8")
    await file.sync()
    await file.close()
    file = undefined
    await rename(temporary, path)
  } catch (error) {
    await file?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}
