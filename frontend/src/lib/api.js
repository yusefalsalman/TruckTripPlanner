/**
 * Thin fetch wrapper around the Django API.
 * All functions throw an Error whose message is safe to show to the user.
 */
const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/+$/, '')

async function request(path, { method = 'GET', body, signal, timeoutMs = 90_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs)
  // Propagate caller cancellation into our controller.
  signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true })

  let response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
  } catch (err) {
    if (signal?.aborted) throw err // caller cancelled; let them ignore it
    if (err?.name === 'TimeoutError' || controller.signal.reason?.name === 'TimeoutError') {
      throw new Error('The server took too long to respond. Please try again.')
    }
    throw new Error('Cannot reach the planning server. Check your connection and try again.')
  } finally {
    clearTimeout(timer)
  }

  let data = null
  try {
    data = await response.json()
  } catch {
    /* non-JSON body (e.g. proxy error page) */
  }
  if (!response.ok) {
    throw new Error(describeError(data) || `Request failed (HTTP ${response.status}).`)
  }
  return data
}

/** Flatten DRF validation errors into one readable sentence. */
function describeError(data) {
  if (!data) return ''
  const parts = []
  if (data.error) parts.push(data.error)
  const walk = (value, path) => {
    if (Array.isArray(value)) value.forEach((v) => walk(v, path))
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, [...path, k]))
    else if (value) parts.push(`${prettyField(path)}: ${value}`)
  }
  if (data.details) walk(data.details, [])
  return parts.join(' ')
}

const FIELD_NAMES = {
  current_location: 'Current location',
  pickup_location: 'Pickup',
  dropoff_location: 'Dropoff',
  current_cycle_used: 'Cycle used',
  start_time: 'Start time',
  non_field_errors: '',
}

function prettyField(path) {
  return path.map((p) => FIELD_NAMES[p] ?? p).filter(Boolean).join(' › ') || 'Error'
}

export const api = {
  planTrip: (payload, signal) => request('/api/plan-trip/', { method: 'POST', body: payload, signal }),
  getTrip: (id, signal) => request(`/api/trips/${encodeURIComponent(id)}/`, { signal }),
  searchPlaces: (q, signal) =>
    request(`/api/geocode/search/?q=${encodeURIComponent(q)}`, { signal, timeoutMs: 20_000 }).then((d) => d.results),
  reverse: (lat, lon, signal) =>
    request(`/api/geocode/reverse/?lat=${lat}&lon=${lon}`, { signal, timeoutMs: 20_000 }),
  health: (signal) => request('/api/health/', { signal, timeoutMs: 60_000 }),
}
