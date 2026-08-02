export const MOUSE_TRACKING_OFF = [
  "\u001b[?9l",
  "\u001b[?1000l",
  "\u001b[?1002l",
  "\u001b[?1003l",
  "\u001b[?1006l",
  "\u001b[?1015l",
  "\u001b[?1016l",
].join("")

const SGR_MOUSE_REPORT = /^\u001b\[<\d+;\d+;\d+[mM]$/
const URXVT_MOUSE_REPORT = /^\u001b\[\d+;\d+;\d+M$/

export function isMouseReportSequence(sequence: string): boolean {
  if (SGR_MOUSE_REPORT.test(sequence) || URXVT_MOUSE_REPORT.test(sequence)) return true
  return sequence.startsWith("\u001b[M") && sequence.length === 6
}
