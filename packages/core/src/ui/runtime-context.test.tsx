import { afterEach, beforeAll, expect, it, spyOn } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { PaneRuntimeProvider, RuntimeProvider } from "@laziergit/runtime-bridge"
import { createRoot, type Root } from "@opentui/react"
import { act, Component, type ReactNode } from "react"
import { useCommand, useGit } from "laziergit"

/**
 * The two React contexts the `"laziergit"` hooks read carry `unknown`, so the hooks are the
 * boundary where that becomes a typed runtime. These tests make "parse, don't assert"
 * observable: a value that is present but not laziergit's is refused by name, not discovered
 * three frames later as `undefined is not an object`.
 */
const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true
})

let renderer: Awaited<ReturnType<typeof createTestRenderer>> | undefined
let root: Root | undefined

afterEach(async () => {
  const mounted = root
  await act(async () => {
    mounted?.unmount()
  })
  root = undefined
  renderer?.renderer.destroy()
  renderer = undefined
})

function Probe() {
  useGit((state) => state.head)
  return <text content="probe" />
}

/**
 * Enough of a runtime to satisfy the guard, so the *pane* runtime is the only thing under
 * test, plus a record of what it was asked to register.
 */
function fakeRuntime(registrations: unknown[][]) {
  const store = { getSnapshot: () => undefined, subscribe: () => () => undefined }
  return {
    git: store,
    activity: store,
    theme: store,
    events: { subscribe: () => ({ dispose: () => undefined }) },
    keys: { capture: () => ({ dispose: () => undefined }) },
    listQuery: {
      register: () => ({ update: () => undefined, dispose: () => undefined }),
    },
    commands: {
      registerComponent: (...args: unknown[]) => {
        registrations.push(args)
        return { dispose: () => undefined }
      },
    },
  }
}

function CommandProbe() {
  useCommand({ id: "probe.run", title: "Run", run: () => undefined })
  return <text content="command probe" />
}

/**
 * The same containment a Pane gets in the real app, in miniature: a render error is
 * reported, not rethrown past the renderer.
 */
interface BoundaryProps {
  readonly onError: (error: unknown) => void
  readonly children: ReactNode
}

class Boundary extends Component<BoundaryProps, { readonly failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    // A fallback, not the same children again: re-rendering what just threw escalates the
    // error past this boundary to the renderer's own, which is what swallows it.
    return { failed: true }
  }

  override componentDidCatch(error: unknown) {
    this.props.onError(error)
  }

  override render() {
    return this.state.failed ? null : this.props.children
  }
}

/** Renders `children` and returns whatever the render threw, or null. */
async function renderThrowing(children: ReactNode): Promise<unknown> {
  await act(async () => {
    renderer = await createTestRenderer({ width: 20, height: 4 })
  })
  const setup = renderer
  if (!setup) throw new Error("renderer was not created")
  root = createRoot(setup.renderer)
  const created = root
  let thrown: unknown = null
  // React re-reports a caught render error on `console.error`, complete with a component
  // stack. That is the error this test is asking for, so it is noise, not a result.
  const quiet = spyOn(console, "error").mockImplementation(() => undefined)
  // One `act`, covering the draw as well as the render: the reconciler commits on a scheduled
  // task, so the boundary's own state update lands during the frame.
  await act(async () => {
    created.render(
      <Boundary
        onError={(error) => {
          thrown = error
        }}
      >
        {children}
      </Boundary>,
    )
    await setup.renderOnce()
  })
  quiet.mockRestore()
  return thrown
}

it("refuses a runtime that is present but is not laziergit's", async () => {
  // Truthy, so a cast would have waved it through and the failure would have surfaced as
  // whichever property the first hook happened to reach for.
  const error = await renderThrowing(
    <RuntimeProvider runtime={{ git: { getSnapshot: "not a function" } }}>
      <Probe />
    </RuntimeProvider>,
  )

  expect(error).toBeInstanceOf(Error)
  expect(error instanceof Error ? error.message : "").toContain("must be called from a component rendered by laziergit")
})

it("refuses a pane runtime whose ids are not strings, instead of registering against them", async () => {
  const registrations: unknown[][] = []
  const error = await renderThrowing(
    <RuntimeProvider runtime={fakeRuntime(registrations)}>
      <PaneRuntimeProvider value={{ extension: 7, paneId: 9 }}>
        <CommandProbe />
      </PaneRuntimeProvider>
    </RuntimeProvider>,
  )

  expect(error).toBeInstanceOf(Error)
  expect(error instanceof Error ? error.message : "").toContain("must be called inside a laziergit Pane")
  // The point of parsing here rather than casting: nothing downstream ever saw the numbers.
  expect(registrations).toEqual([])
})
