import { useEffect, useState } from "react"

/**
 * matrix-wave: one sine period, two dots thick, rolling left to right through the 6x4 dot grid
 * that three braille cells make.
 *
 * The crest leaves the right edge exactly as it re-enters the left, so there is no loop point
 * to catch and it reads as continuous flow rather than as something restarting. Braille is
 * East-Asian-Width **Neutral** — one cell in every terminal, including one configured to draw
 * ambiguous-width characters wide — and every frame here is three code points, so the tokens to
 * the right of the loader never move a column while it runs. That is the whole reason the frame
 * table is fixed-width by construction rather than by inspection.
 */
const frames = ["⡴⠛⢦", "⣤⠞⠳", "⢦⡴⠛", "⠳⣤⠞", "⠛⢦⡴", "⠞⠳⣤"] as const

/**
 * 100ms — six frames to the cycle, so the crest crosses in 600ms.
 *
 * Floored well above the renderer's own frame time (targetFps 30, so ~33ms): a shorter period
 * would be wakeups OpenTUI coalesces away, and the wave would blur rather than travel.
 */
const periodMs = 100

/**
 * The current frame while `active`, and `null` otherwise.
 *
 * The interval lives here, in the component, rather than in `activate`. Two reasons, and both
 * are load-bearing. It runs only while there is something to animate, so an idle laziergit
 * schedules nothing at all. And React unmounts this component when the Extension deactivates,
 * which is what clears the timer — an `activate`-scope interval would need `ctx.onDispose`, and
 * a `finally` that cleared it would not run at all on a hot reload landing mid-push, because a
 * deactivating scope parks its promises rather than settling them (docs/extension-api.md §5.3).
 *
 * The tick closes over nothing but React state. That is deliberate: a timer is exactly the
 * "continuation resumed by a non-ctx promise" that §5.3 warns can reach a poisoned `ctx`, and a
 * callback with no `ctx` to reach for cannot.
 */
export function useSpinner(active: boolean): string | null {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!active) return
    // Restart at the crest on the left, so every operation begins the same way — and so a test
    // can assert the first glyph instead of whichever frame the last fetch happened to end on.
    setFrame(0)
    const timer = setInterval(() => setFrame((current) => (current + 1) % frames.length), periodMs)
    return () => clearInterval(timer)
  }, [active])

  return active ? (frames[frame] ?? frames[0]) : null
}
