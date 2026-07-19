---
status: accepted
---

# Everything is an extension

The core ships zero git *UI* features: it provides only the pane/layout framework, the git service (plumbing plus a curated set of porcelain helpers), the event bus, keybindings, and config. Every feature — including staging, commits, and branches — is an Extension built on the same public API third parties use ("Bundled Extensions", with no private privileges). We chose this over a built-in-features core because a plugin API that core features don't depend on inevitably turns shallow (lazygit's custom-commands system is the cautionary tale: it can't add views, subscribe to events, or run background tasks, and the demand is documented in lazygit issue #4681). opencode proves the pattern in production — its sidebar, diff viewer, and notifications are plugins on its own public API.

## Consequences

- The extension API must exist before the first feature does; core abstractions get designed under real load from day one.
- Bundled Extensions must expose their own extension points (row decorations, menu items) so third parties can extend *them* — see the Magit/Forge precedent.
- A zero-extension launch shows an empty shell; the default distribution is core + bundled extensions.
