---
status: accepted
---

# Promise-first public API; Effect stays core-internal

Core is built with Effect (v4 beta — matching vendored opencode's idioms, so its patterns transliterate directly), but the public Extension Context is plain async TypeScript: Promises and callbacks (Effect Streams exist only behind `ctx.effect`). A single escape hatch (`ctx.effect`, exposing the ManagedRuntime and service keys) lets power extensions opt into full Effect. We rejected an Effect-native public API because extension authors — especially coding agents, the primary authors here — write excellent plain async TS and mediocre Effect, and the crown-jewel API needs a low floor. We rejected a fully dual API (every capability in both flavors) as a permanent doc/maintenance tax.

## Consequences

- Effect version churn (v4 is beta) breaks only core internals, never extensions — this containment is what makes the beta acceptable.
- Extension lifecycle is implemented internally as Effect Scope, surfacing publicly as automatic disposal: registrations unwind on deactivate, Disposable handles exist only for early teardown, and ctx promises are scope-supervised (extension-api.md §5.3).
- opencode's v2 plugin API ships the same dual shape (Effect core, Promise wrapper) — production precedent for this exact split.
