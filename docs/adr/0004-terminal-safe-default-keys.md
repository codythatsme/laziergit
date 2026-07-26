# ADR-0004 — No core or bundled default is spelled `mod+` alone

**Status**: accepted (M5)

## Context

`mod+p` was the default binding for the command palette. In Warp on macOS it does nothing.

The resolution path is sound and was not the bug. `packages/core/src/ui/keybindings.ts`
resolves `mod` to `super` only when the keymap reports `primaryModifier === "super"` *and*
`modifiers.super === "supported"`; `@opentui/keymap` sets that from
`renderer.capabilities.kitty_keyboard`, which OpenTUI derives from a terminal-name match or a
`CSI ? <n> u` reply. Warp implements the kitty keyboard protocol, so the probe passes and
`mod+p` correctly resolves to `super+p`. `super+p` is also perfectly encodable under the flags
OpenTUI enables.

The stroke never arrives anyway, because Warp binds `cmd-p` to its own command palette **above
the pty**. The application is not competing with an encoding limitation; it is competing with
the terminal's own keymap, and the terminal wins. Warp is not unusual here — a cmd chord is
where macOS terminals put their own commands, and every one of them keeps some.

Three properties follow, and together they close the question:

- Capability detection cannot help. "Can report super" and "will deliver super" are different
  facts, and nothing in the protocol exposes the second.
- No flag can help. The sequence is intercepted before the pty, so there is nothing for
  progressive enhancement to enable.
- The failure is silent and total. The one binding that opens the palette is the binding the
  terminal ate, so the feature is simply missing, with no diagnostic to read.

## Decision

`mod+` stays in the {@link KeySpec} grammar. It is genuinely the right thing for a user's own
config and for a third-party extension whose author knows their terminal.

**No default shipped by core or by a Bundled Extension may depend on it.** A default is either
a plain stroke, or `mod+` paired with a plain stroke that is listed first — first because the
hint bar prints only the first key, and the one always-available stroke is the one a user
should be reading there. (The cheat sheet lists every key a Command has, so order costs it
nothing.)

Applied:

- `app.palette` — `["ctrl+p", ":"]`. `ctrl+p` is what opencode ships for its command list and
  encodes as a plain byte in every terminal; `:` needs no modifier at all.
- `commit-flow.submit` — `["ctrl+s", "mod+s"]`. This was the only way to finish a commit, so it
  carried the same total-failure risk. Raw mode clears `IXON`, so `ctrl+s` is not flow control
  inside the app.

## Consequences

- Two defaults collide with lazygit's (`ctrl+p` is its custom-patch menu, `:` its shell
  prompt). Both of those are post-v1 here, so the collision is theoretical; if either lands,
  it moves, not the palette.
- `mod+` remains reachable and documented, so nothing is lost for a user who wants cmd.
- A test asserts that no core default resolves through `mod+`, so this decision is enforced
  rather than remembered.

## Alternatives rejected

- **Detect Warp and fall back.** Solves one terminal. The next one that keeps a cmd chord —
  and they all keep some — fails identically, and the allowlist is unmaintainable.
- **Make `mod` always resolve to ctrl.** Would take cmd away from the users whose terminals do
  deliver it, to fix a problem in the terminals that do not.
- **Bind both `super+p` and `ctrl+p` to the palette by default.** Two live bindings for one
  command, one of which is invisible in most terminals; the pairing rule above gets the same
  reach with one advertised key.
