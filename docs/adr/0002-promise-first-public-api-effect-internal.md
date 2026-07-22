---
status: accepted
---

# Promise-first public API; Effect stays core-internal

Core is built with Effect (v4 beta — matching vendored opencode's idioms, so its patterns transliterate directly), but the ordinary public Extension Context is plain async TypeScript: Promises and callbacks. A single, deliberately narrow escape hatch (`ctx.effect`) lets power Extensions use bound Effect-native Git/event services and run fully-provided Effects; raw ManagedRuntime access, service keys, and Core's service graph remain private. We rejected an Effect-native public API because Extension authors — especially coding agents, the primary authors here — write excellent plain async TS and mediocre Effect, and the crown-jewel API needs a low floor. We rejected a fully dual API (every capability in both flavors) as a permanent doc/maintenance tax.

## Consequences

- Ordinary APIs remain insulated from Effect version churn. The explicitly opted-in `ctx.effect` type surface is version-coupled to laziergit's pinned Effect v4 beta, but it cannot expose or depend on Core's service graph.
- Extension lifecycle retains one internal Effect Scope per activation, surfaced publicly as automatic disposal through a removable JavaScript finalizer/supervision registry: registrations unwind on deactivate, Disposable handles exist only for early teardown, and ctx promises are scope-supervised (extension-api.md §5.3).
- opencode's v2 plugin API ships the same Effect-core/Promise-wrapper split — production precedent for keeping the default surface plain async.
