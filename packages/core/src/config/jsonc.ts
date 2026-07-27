/**
 * A JSONC reader: JSON plus `//` and block comments, trailing commas, and precise error
 * positions. Hand-written because a user's config.jsonc must fail with a line and column they
 * can act on, and because Bun's own JSONC support exists only behind `import`, whose module
 * cache would defeat config reloading.
 */

/** Thrown for any malformed document; carries the 1-based position of the offending character. */
export class JsoncSyntaxError extends Error {
  readonly line: number
  readonly column: number

  constructor(message: string, line: number, column: number) {
    super(`${message} (line ${line}, column ${column})`)
    this.name = "JsoncSyntaxError"
    this.line = line
    this.column = column
  }
}

const singleCharacterEscapes: Readonly<Record<string, string>> = Object.freeze({
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
})

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r"
}

function isDigit(character: string): boolean {
  return character >= "0" && character <= "9"
}

class JsoncScanner {
  readonly #text: string
  #index = 0

  constructor(text: string) {
    this.#text = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  }

  parseDocument(): unknown {
    this.#skipTrivia()
    // A file that is empty, or only comments, is a document with nothing in it.
    if (this.#index >= this.#text.length) return undefined
    const value = this.#parseValue()
    this.#skipTrivia()
    if (this.#index < this.#text.length) this.#fail(`Unexpected ${this.#describeCurrent()} after the top-level value`)
    return value
  }

  #parseValue(): unknown {
    const character = this.#text[this.#index]
    switch (character) {
      case "{":
        return this.#parseObject()
      case "[":
        return this.#parseArray()
      case '"':
        return this.#parseString()
      case "t":
        return this.#parseKeyword("true", true)
      case "f":
        return this.#parseKeyword("false", false)
      case "n":
        return this.#parseKeyword("null", null)
      default:
        if (character === "-" || (character !== undefined && isDigit(character))) return this.#parseNumber()
        this.#fail(`Unexpected ${this.#describeCurrent()} where a value was expected`)
    }
  }

  #parseObject(): Record<string, unknown> {
    // A null prototype keeps a `"__proto__"` key in user config from mutating anything.
    const result: Record<string, unknown> = Object.create(null)
    this.#index += 1
    this.#skipTrivia()

    if (this.#text[this.#index] === "}") {
      this.#index += 1
      return result
    }

    for (;;) {
      this.#skipTrivia()
      if (this.#text[this.#index] !== '"') this.#fail(`Unexpected ${this.#describeCurrent()} where a key was expected`)
      const key = this.#parseString()
      this.#skipTrivia()
      if (this.#text[this.#index] !== ":") this.#fail(`Expected ":" after key "${key}"`)
      this.#index += 1
      this.#skipTrivia()
      result[key] = this.#parseValue()
      this.#skipTrivia()

      const delimiter = this.#text[this.#index]
      if (delimiter === ",") {
        this.#index += 1
        this.#skipTrivia()
        if (this.#text[this.#index] === "}") {
          this.#index += 1
          return result
        }
        continue
      }
      if (delimiter === "}") {
        this.#index += 1
        return result
      }
      this.#fail(`Expected "," or "}" but found ${this.#describeCurrent()}`)
    }
  }

  #parseArray(): unknown[] {
    const result: unknown[] = []
    this.#index += 1
    this.#skipTrivia()

    if (this.#text[this.#index] === "]") {
      this.#index += 1
      return result
    }

    for (;;) {
      this.#skipTrivia()
      result.push(this.#parseValue())
      this.#skipTrivia()

      const delimiter = this.#text[this.#index]
      if (delimiter === ",") {
        this.#index += 1
        this.#skipTrivia()
        if (this.#text[this.#index] === "]") {
          this.#index += 1
          return result
        }
        continue
      }
      if (delimiter === "]") {
        this.#index += 1
        return result
      }
      this.#fail(`Expected "," or "]" but found ${this.#describeCurrent()}`)
    }
  }

  #parseString(): string {
    this.#index += 1
    let value = ""

    for (;;) {
      const character = this.#text[this.#index]
      if (character === undefined) this.#fail("Unterminated string")
      if (character === '"') {
        this.#index += 1
        return value
      }
      if (character === "\n") this.#fail("Unterminated string")
      if (character !== "\\") {
        value += character
        this.#index += 1
        continue
      }

      this.#index += 1
      const escape = this.#text[this.#index]
      if (escape === undefined) this.#fail("Unterminated escape sequence")
      if (escape === "u") {
        const digits = this.#text.slice(this.#index + 1, this.#index + 5)
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) this.#fail("Invalid \\u escape sequence")
        value += String.fromCharCode(Number.parseInt(digits, 16))
        this.#index += 5
        continue
      }
      const replacement = singleCharacterEscapes[escape]
      if (replacement === undefined) this.#fail(`Invalid escape sequence "\\${escape}"`)
      value += replacement
      this.#index += 1
    }
  }

  #parseNumber(): number {
    const start = this.#index
    if (this.#text[this.#index] === "-") this.#index += 1

    const integerStart = this.#index
    while (isDigit(this.#text[this.#index] ?? "")) this.#index += 1
    if (this.#index === integerStart) this.#fail("Expected a digit in number")
    if (this.#text[integerStart] === "0" && this.#index - integerStart > 1) {
      this.#index = integerStart + 1
      this.#fail("Numbers cannot have a leading zero")
    }

    if (this.#text[this.#index] === ".") {
      this.#index += 1
      const fractionStart = this.#index
      while (isDigit(this.#text[this.#index] ?? "")) this.#index += 1
      if (this.#index === fractionStart) this.#fail("Expected a digit after the decimal point")
    }

    const exponent = this.#text[this.#index]
    if (exponent === "e" || exponent === "E") {
      this.#index += 1
      const sign = this.#text[this.#index]
      if (sign === "+" || sign === "-") this.#index += 1
      const exponentStart = this.#index
      while (isDigit(this.#text[this.#index] ?? "")) this.#index += 1
      if (this.#index === exponentStart) this.#fail("Expected a digit in the exponent")
    }

    return Number(this.#text.slice(start, this.#index))
  }

  #parseKeyword<T>(keyword: string, value: T): T {
    if (this.#text.startsWith(keyword, this.#index)) {
      this.#index += keyword.length
      return value
    }
    this.#fail(`Unexpected ${this.#describeCurrent()} where a value was expected`)
  }

  #skipTrivia(): void {
    for (;;) {
      while (isWhitespace(this.#text[this.#index] ?? "")) this.#index += 1
      if (this.#text[this.#index] !== "/") return

      const kind = this.#text[this.#index + 1]
      if (kind === "/") {
        const end = this.#text.indexOf("\n", this.#index)
        this.#index = end === -1 ? this.#text.length : end + 1
        continue
      }
      if (kind === "*") {
        const end = this.#text.indexOf("*/", this.#index + 2)
        if (end === -1) this.#fail("Unterminated block comment")
        this.#index = end + 2
        continue
      }
      this.#fail('Unexpected "/"')
    }
  }

  #describeCurrent(): string {
    const character = this.#text[this.#index]
    return character === undefined ? "end of input" : `"${character}"`
  }

  #fail(message: string): never {
    const consumed = this.#text.slice(0, this.#index)
    const lineStart = consumed.lastIndexOf("\n") + 1
    const line = consumed.length === 0 ? 1 : consumed.split("\n").length
    throw new JsoncSyntaxError(message, line, this.#index - lineStart + 1)
  }
}

/**
 * Parses a JSONC document, or `undefined` when the text holds no value at all (empty, or
 * only comments). Objects come back with a null prototype; throws {@link JsoncSyntaxError}.
 */
export function parseJsonc(text: string): unknown {
  return new JsoncScanner(text).parseDocument()
}
