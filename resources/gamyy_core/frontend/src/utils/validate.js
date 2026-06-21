// HH:MM:SS or HH:MM:SS.mmm
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?$/

// YYYY-MM-DD or YYYY-MM-DD HH:MM or YYYY-MM-DD HH:MM:SS
export const DATE_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/

export function isTimeString(v) {
  if (!v) return true
  return TIME_RE.test(v)
}

export function isDatetime(v) {
  if (!v) return true
  return DATE_RE.test(v)
}

export function isValidMaxChannels(v) {
  if (v === '' || v === 'auto') return true
  const n = Number(v)
  return Number.isInteger(n) && n > 0
}
