/** @jsxImportSource @opentui/react */
import {
  createRowSource,
  defineExtension,
  describeGitFailure,
  toneColor,
  useCommand,
  useGit,
  useListCursor,
  useTheme,
  type PaneHandle,
  type PaneProps,
  type Remote,
  type RemoteBranch,
  type RemoteBranchesApi,
} from "laziergit"
import { useEffect, useState } from "react"

function remoteRef(branch: RemoteBranch): string {
  return `${branch.remote}/${branch.name}`
}

function validateRef(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return "Name the local branch"
  if (trimmed.startsWith("-")) return "Branch names cannot begin with a dash"
  if (/\s/.test(trimmed)) return "Branch names cannot contain spaces"
  return null
}

export default defineExtension({
  name: "remote-branches",
  description: "Browse remote branches and create local tracking branches",
  needs: ["branches", "diff"],

  activate(ctx): RemoteBranchesApi {
    const rows = createRowSource<RemoteBranch>({ key: remoteRef })
    const diff = ctx.extensions.get("diff")
    const signal = ctx.signal

    const fail = (error: unknown): void => ctx.popups.notify(describeGitFailure(error), "error")

    function currentBranch(): string | null {
      const head = ctx.git.state.head
      return head.kind === "onBranch" ? head.branch : null
    }

    async function checkoutRemoteBranch(branch: RemoteBranch): Promise<void> {
      const existing = ctx.git.state.branches.find((candidate) => candidate.name === branch.name)
      try {
        if (existing !== undefined) {
          await ctx.git.checkout(existing.name)
          return
        }
        await ctx.git.raw(["checkout", "--track", "-b", branch.name, remoteRef(branch)])
      } catch (error) {
        fail(error)
      }
    }

    async function createTrackingBranch(branch: RemoteBranch): Promise<void> {
      const name = await ctx.popups.prompt({
        title: `New local branch from ${remoteRef(branch)}`,
        placeholder: "feature/…",
        initial: branch.name,
        validate: (value) => {
          const invalid = validateRef(value)
          if (invalid !== null) return invalid
          return ctx.git.state.branches.some((candidate) => candidate.name === value.trim())
            ? "A local branch with that name already exists"
            : null
        },
      })
      if (name === undefined) return
      try {
        await ctx.git.raw(["checkout", "--track", "-b", name.trim(), remoteRef(branch)])
      } catch (error) {
        fail(error)
      }
    }

    async function checkoutRemoteDetached(branch: RemoteBranch): Promise<void> {
      try {
        await ctx.git.checkout(remoteRef(branch))
      } catch (error) {
        fail(error)
      }
    }

    async function deleteRemoteBranch(branch: RemoteBranch): Promise<void> {
      const ref = remoteRef(branch)
      const accepted = await ctx.popups.confirm({
        title: `Delete ${ref}?`,
        message: `Deletes ${branch.name} from ${branch.remote}. Any local branch is kept.`,
        confirmLabel: "Delete remote branch",
        danger: true,
      })
      if (!accepted) return
      try {
        await ctx.git.deleteRemoteBranch(branch.remote, branch.name)
      } catch (error) {
        fail(error)
      }
    }

    async function fetchRemote(remote: string): Promise<void> {
      try {
        await ctx.git.fetch({ remote })
        ctx.popups.notify(`Fetched ${remote}`, "success")
      } catch (error) {
        fail(error)
      }
    }

    async function setRemoteAsUpstream(branch: RemoteBranch): Promise<void> {
      const current = currentBranch()
      if (current === null) {
        ctx.popups.notify("Check out a local branch before setting its upstream", "warning")
        return
      }
      const upstream = remoteRef(branch)
      const accepted = await ctx.popups.confirm({
        title: `Set upstream for ${current}?`,
        message: `${current} will track ${upstream}.`,
        confirmLabel: "Set upstream",
      })
      if (!accepted) return
      try {
        await ctx.git.raw(["branch", "--set-upstream-to", upstream, "--", current])
      } catch (error) {
        fail(error)
      }
    }

    function RemoteBranchRow({
      branch,
      id,
      selected,
      focused,
    }: {
      readonly branch: RemoteBranch
      readonly id: string
      readonly selected: boolean
      readonly focused: boolean
    }) {
      const theme = useTheme()
      const decoration = rows.useDecoration(branch)
      const dim = decoration?.dim === true
      const badge = decoration?.badge

      return (
        <text id={id} wrapMode="none" bg={selected && focused ? theme.selection : undefined}>
          <span fg={dim ? theme.textMuted : theme.text}>{` ${branch.name}`}</span>
          {badge === undefined ? null : <span fg={toneColor(theme, decoration?.tone)}>{`  ${badge}`}</span>}
        </text>
      )
    }

    function RemotePicker({
      focused,
      remotes,
      branches,
      onSelect,
    }: {
      readonly focused: boolean
      readonly remotes: readonly Remote[]
      readonly branches: readonly RemoteBranch[]
      readonly onSelect: (remote: string) => void
    }) {
      const theme = useTheme()
      const cursor = useListCursor({
        items: remotes,
        idPrefix: "remote-branches.remotes",
        noun: "remote",
        query: { mode: "filter", fields: (remote) => [remote.name] },
      })
      const selected = cursor.selected

      useCommand({
        id: "remote-branches.open",
        title: "View branches for remote",
        hint: "open",
        keys: ["space", "return"],
        run: () => {
          if (selected !== undefined) onSelect(selected.name)
        },
      })
      useCommand({
        id: "remote-branches.fetch-selected",
        title: "Fetch selected remote",
        hint: "fetch",
        keys: "f",
        run: () => (selected === undefined ? undefined : fetchRemote(selected.name)),
      })

      if (cursor.items.length === 0) return <text fg={theme.textMuted} content="no matching remotes" />

      return (
        <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
          {cursor.items.map((remote, index) => {
            const count = branches.filter((branch) => branch.remote === remote.name).length
            return (
              <text
                key={remote.name}
                id={cursor.rowId(index)}
                wrapMode="none"
                bg={index === cursor.index && focused ? theme.selection : undefined}
              >
                <span fg={theme.text}>{` ${remote.name}`}</span>
                <span fg={theme.textMuted}>{`  ${count} ${count === 1 ? "branch" : "branches"}`}</span>
              </text>
            )
          })}
        </scrollbox>
      )
    }

    function RemoteBackCommand({ run }: { readonly run: () => void }) {
      useCommand({
        id: "remote-branches.back",
        title: "Choose another remote",
        hint: "back",
        keys: "escape",
        run,
      })
      return null
    }

    function RemoteBranchList({
      focused,
      remote,
      branches,
      onBack,
    }: {
      readonly focused: boolean
      readonly remote: string
      readonly branches: readonly RemoteBranch[]
      readonly onBack?: () => void
    }) {
      const theme = useTheme()
      const cursor = useListCursor({
        items: branches,
        idPrefix: "remote-branches.list",
        noun: "remote branch",
        query: {
          mode: "filter",
          fields: (branch) => [branch.name, remoteRef(branch)],
        },
      })
      const visibleBranches = cursor.items
      const selected = cursor.selected
      const selectedRef = selected === undefined ? undefined : remoteRef(selected)
      const canGoBack = onBack !== undefined && (cursor.query?.value.length ?? 0) === 0

      useEffect(() => {
        rows.setSelected(selected)
        return () => rows.setSelected(undefined)
      }, [selected])

      useEffect(() => {
        if (!focused || selectedRef === undefined || signal.aborted) return
        diff.show({ kind: "branch", ref: selectedRef, path: null })
      }, [focused, selectedRef])

      useCommand({
        id: "remote-branches.checkout",
        title: "Create or check out local tracking branch",
        hint: "checkout",
        keys: "space",
        run: () => (selected === undefined ? undefined : checkoutRemoteBranch(selected)),
      })
      useCommand({
        id: "remote-branches.create",
        title: "Create tracking branch with another name",
        hint: "new branch",
        keys: "n",
        run: () => (selected === undefined ? undefined : createTrackingBranch(selected)),
      })
      useCommand({
        id: "remote-branches.fetch",
        title: "Fetch selected remote",
        hint: "fetch",
        keys: "f",
        run: () => fetchRemote(remote),
      })
      useCommand({
        id: "remote-branches.set-upstream",
        title: "Set as upstream of current branch",
        keys: "u",
        run: () => (selected === undefined ? undefined : setRemoteAsUpstream(selected)),
      })
      useCommand({
        id: "remote-branches.detached",
        title: "Check out remote branch as detached HEAD",
        run: () => (selected === undefined ? undefined : checkoutRemoteDetached(selected)),
      })
      useCommand({
        id: "remote-branches.menu",
        title: "Remote branch actions",
        hint: "menu",
        keys: "x",
        run: () => {
          if (selected !== undefined) void ctx.menus.open("remote-branches.actions", selected).catch(fail)
        },
      })

      if (visibleBranches.length === 0) {
        const message =
          branches.length === 0 ? `no cached branches for ${remote} — f fetches` : "no matching remote branches"
        return (
          <>
            {canGoBack && onBack !== undefined ? <RemoteBackCommand run={onBack} /> : null}
            <text fg={theme.textMuted} content={message} />
          </>
        )
      }

      return (
        <>
          {canGoBack && onBack !== undefined ? <RemoteBackCommand run={onBack} /> : null}
          <box flexGrow={1} flexBasis={0} flexDirection="column">
            <text fg={theme.textMuted} content={` ${remote}`} />
            <scrollbox ref={cursor.scrollRef} focusable={false} flexGrow={1} flexBasis={0}>
              {visibleBranches.map((branch, index) => (
                <RemoteBranchRow
                  key={remoteRef(branch)}
                  id={cursor.rowId(index)}
                  branch={branch}
                  selected={index === cursor.index}
                  focused={focused}
                />
              ))}
            </scrollbox>
          </box>
        </>
      )
    }

    function RemoteBranchesPane({ focused }: PaneProps) {
      const theme = useTheme()
      const remotes = useGit((state) => state.remotes)
      const remoteBranches = useGit((state) => state.remoteBranches)
      const [chosenRemote, setChosenRemote] = useState<string | null>(null)

      if (remotes.length === 0) return <text fg={theme.textMuted} content="no remotes configured" />

      const automatic = remotes.length === 1 ? remotes[0]?.name : undefined
      const chosenStillExists =
        chosenRemote !== null && remotes.some((candidate) => candidate.name === chosenRemote) ? chosenRemote : null
      const remote = automatic ?? chosenStillExists

      if (remote === null || remote === undefined) {
        return <RemotePicker focused={focused} remotes={remotes} branches={remoteBranches} onSelect={setChosenRemote} />
      }

      return (
        <RemoteBranchList
          focused={focused}
          remote={remote}
          branches={remoteBranches.filter((branch) => branch.remote === remote)}
          onBack={remotes.length > 1 ? () => setChosenRemote(null) : undefined}
        />
      )
    }

    let pane: PaneHandle | undefined
    const syncPane = (remotes: readonly Remote[]): void => {
      if (remotes.length > 0 && pane === undefined) {
        pane = ctx.panes.register({
          id: "remote-branches",
          title: "Remote",
          component: RemoteBranchesPane,
          placement: { column: 0, order: 31, tabWith: "branches" },
        })
      } else if (remotes.length === 0 && pane !== undefined) {
        pane.dispose()
        pane = undefined
      }
    }
    syncPane(ctx.git.state.remotes)
    ctx.events.on("git.remotes.changed", ({ current }) => syncPane(current))

    ctx.commands.register({
      id: "remote-branches.focus",
      title: "Focus remote branches",
      pane: "remote-branches",
      run: () => undefined,
    })

    ctx.menus.register({
      id: "remote-branches.actions",
      title: (branch) => `Remote branch: ${remoteRef(branch)}`,
      groups: [
        {
          id: "branch",
          title: "Branch",
          items: [
            { key: "c", label: "Create or check out tracking branch", run: checkoutRemoteBranch },
            { key: "n", label: "Create tracking branch with another name…", run: createTrackingBranch },
            { key: "d", label: "Delete from remote…", run: deleteRemoteBranch },
            { key: "h", label: "Check out as detached HEAD", run: checkoutRemoteDetached },
            { key: "u", label: "Set as upstream of current branch…", run: setRemoteAsUpstream },
            { key: "f", label: "Fetch remote", run: (branch) => fetchRemote(branch.remote) },
          ],
        },
      ],
    })

    return rows.api
  },
})
