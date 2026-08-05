import { useEffect, useState } from "react"

/** One sine period rolling through the 6x4 dot grid three braille cells make. */
const frames = ["⡴⠛⢦", "⣤⠞⠳", "⢦⡴⠛", "⠳⣤⠞", "⠛⢦⡴", "⠞⠳⣤"] as const
const periodMs = 100

/** The current fixed-width frame while active, and null otherwise. */
export function useSpinner(active: boolean): string | null {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!active) return
    setFrame(0)
    const timer = setInterval(() => setFrame((current) => (current + 1) % frames.length), periodMs)
    return () => clearInterval(timer)
  }, [active])

  return active ? (frames[frame] ?? frames[0]) : null
}
