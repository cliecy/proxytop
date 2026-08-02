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
const CONTROL_C = "\u0003"
const SEARCH_CONTROL_SEQUENCES = new Set(["\u001b", "\r", "\n", "\b", "\u007f"])
const DASHBOARD_KEY_SEQUENCES = new Set([
  CONTROL_C,
  "q",
  "1",
  "2",
  "3",
  "4",
  "5",
  "l",
  "/",
  "p",
  " ",
  "s",
  "j",
  "k",
  "\u001b[A",
  "\u001b[B",
  "\u001bOA",
  "\u001bOB",
])

export function isMouseReportSequence(sequence: string): boolean {
  if (SGR_MOUSE_REPORT.test(sequence) || URXVT_MOUSE_REPORT.test(sequence)) return true
  return sequence.startsWith("\u001b[M") && sequence.length === 6
}

function isPrintableCharacter(sequence: string): boolean {
  return Array.from(sequence).length === 1 && !/\p{C}/u.test(sequence)
}

export function isAllowedDashboardInputSequence(sequence: string, searching: boolean): boolean {
  if (isMouseReportSequence(sequence)) return false
  if (sequence === CONTROL_C) return true
  if (searching) return SEARCH_CONTROL_SEQUENCES.has(sequence) || isPrintableCharacter(sequence)
  return DASHBOARD_KEY_SEQUENCES.has(sequence)
}
