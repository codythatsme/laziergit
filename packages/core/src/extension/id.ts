export function assertScopedId(extension: string, id: string): void {
  if (id !== extension && !id.startsWith(`${extension}.`)) {
    throw new Error(`Extension "${extension}" cannot register id "${id}"; expected "${extension}" or "${extension}.*"`)
  }
}
