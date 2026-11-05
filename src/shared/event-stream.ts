// 事件流（SSE）客户端。浏览器的 EventSource 不能带请求头，令牌只能放进 URL，
// 而 URL 会被反向代理的访问日志、浏览器历史记下来，所以用 fetch 读流，令牌放在请求头里。

export type StreamMessage = { id?: string; event: string; data: string };

/** SSE 解析器：喂入任意切分的文本，返回已经完整的消息。 */
export function sseParser() {
  let buffer = '';
  let id: string | undefined;
  let event = '';
  let data: string[] = [];
  return (chunk: string): StreamMessage[] => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    const out: StreamMessage[] = [];
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line === '') {
        if (data.length) out.push({ id, event: event || 'message', data: data.join('\n') });
        event = '';
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue; // 注释（心跳）
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'id') id = value;
      else if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    return out;
  };
}

export type EventStreamOptions = {
  url: string;
  /** 每次连接前取一次，令牌放在这里 */
  headers: () => Record<string, string>;
  onEvent: (msg: StreamMessage) => void;
  onOpen?: () => void;
  onError?: () => void;
  retryMs?: number;
};

/**
 * 连接事件流，断开后自动重连，并用 Last-Event-ID 补上断开期间的事件。
 * 令牌被拒绝（401、403）时重试也没用，触发一次 onError 后不再连接。返回关闭函数。
 */
export function openEventStream(opts: EventStreamOptions): () => void {
  const ctrl = new AbortController();
  const { signal } = ctrl;
  let lastId: string | undefined;
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  const connect = async () => {
    const res = await fetch(opts.url, {
      headers: { accept: 'text/event-stream', ...opts.headers(), ...(lastId ? { 'last-event-id': lastId } : {}) },
      cache: 'no-store',
      signal,
    });
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      return false;
    }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    opts.onOpen?.();
    const feed = sseParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return true;
      for (const msg of feed(decoder.decode(value, { stream: true }))) {
        if (msg.id) lastId = msg.id;
        opts.onEvent(msg);
      }
    }
  };
  void (async () => {
    while (!signal.aborted) {
      let retry = true;
      try {
        retry = await connect();
      } catch {
        // 断网、Hub 重启：下面统一重连
      }
      if (signal.aborted) return;
      opts.onError?.();
      if (!retry) return;
      await wait(opts.retryMs ?? 3000);
    }
  })();
  return () => ctrl.abort();
}
