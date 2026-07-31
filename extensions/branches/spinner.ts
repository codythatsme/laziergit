import { useEffect, useState } from "react"

/**
 * One sine period, two dots thick, rolling through the 6x4 dot grid three braille cells make.
 * Every frame is three code points, and braille is East-Asian-Width Neutral, so the branch
 * row never changes width while work runs.
 */
const frames = ["⡴⠛⢦", "⣤⠞⠳", "⢦⡴⠛", "⠳⣤⠞", "⠛⢦⡴", "⠞⠳⣤"] as const

/** Six frames to the cycle, and well above the renderer's own ~33ms frame time. */
const periodMs = 100

/**
 * The current frame while `active`, and `null` otherwise. The interval lives in the component
 * so unmounting clears it: an Extension reload landing mid-operation cannot strand its timer.
 * The tick closes over nothing but React state, so it cannot reach a poisoned `ctx`.
 */
export function useSpinner(active: boolean): string | null {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!active) return
    // Restart at the crest, so every operation begins the same way.
    setFrame(0)
    const timer = setInterval(() => setFrame((current) => (current + 1) % frames.length), periodMs)
    return () => clearInterval(timer)
  }, [active])

  return active ? (frames[frame] ?? frames[0]) : null
}
