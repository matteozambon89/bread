// SQL NULL and JSON null both come back as JS null through postgres.js, and
// JSON has no undefined. A wrapper keeps "not written" distinct from a hook
// that replaced the output with null or undefined.
export function encodeLastOutput(value: unknown): { value: unknown; missing?: true } {
  if (value === undefined) return { value: null, missing: true }
  return { value }
}

export function decodeLastOutput(raw: unknown): { present: true; value: unknown } | { present: false } {
  if (raw == null) return { present: false }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { present: true, value: raw }
  const keys = Object.keys(raw)
  if (!keys.every((key) => key === 'value' || key === 'missing') || !keys.includes('value')) {
    return { present: true, value: raw }
  }
  const envelope = raw as { value?: unknown; missing?: unknown }
  if (envelope.missing === true) return { present: true, value: undefined }
  return { present: true, value: envelope.value }
}
