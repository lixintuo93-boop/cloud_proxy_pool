import { ref, onUnmounted } from 'vue'

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

export function useWebSocket() {
  const ws = ref(null)
  const connected = ref(false)
  const handlers = new Map()   // channel -> callback[]
  let reconnectTimer = null

  function connect() {
    if (ws.value && ws.value.readyState <= 1) return
    ws.value = new WebSocket(WS_URL)

    ws.value.onopen = () => {
      connected.value = true
      // 重连后重新订阅
      for (const channel of handlers.keys()) {
        send({ action: 'subscribe', ...parseChannel(channel) })
      }
    }

    ws.value.onmessage = (e) => {
      try {
        const { channel, data } = JSON.parse(e.data)
        const cbs = handlers.get(channel) || []
        cbs.forEach(cb => cb(data))
      } catch {}
    }

    ws.value.onclose = () => {
      connected.value = false
      reconnectTimer = setTimeout(connect, 3000)
    }

    ws.value.onerror = () => ws.value?.close()
  }

  function send(msg) {
    if (ws.value?.readyState === WebSocket.OPEN) {
      ws.value.send(JSON.stringify(msg))
    }
  }

  function subscribe(channel, callback) {
    if (!handlers.has(channel)) handlers.set(channel, [])
    handlers.get(channel).push(callback)
    send({ action: 'subscribe', ...parseChannel(channel) })
  }

  function unsubscribe(channel, callback) {
    const cbs = handlers.get(channel) || []
    const idx = cbs.indexOf(callback)
    if (idx >= 0) cbs.splice(idx, 1)
    if (cbs.length === 0) {
      handlers.delete(channel)
      send({ action: 'unsubscribe', ...parseChannel(channel) })
    }
  }

  function parseChannel(ch) {
    const [channel, taskId] = ch.split(':')
    return taskId ? { channel, taskId: Number(taskId) } : { channel }
  }

  connect()

  onUnmounted(() => {
    clearTimeout(reconnectTimer)
    ws.value?.close()
  })

  return { connected, subscribe, unsubscribe }
}
