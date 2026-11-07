// Server-Sent Events 输出。规划可能持续 1–3 分钟：流式进度让用户看到每一步，
// 心跳注释防止 Nginx / 负载均衡在空闲 60 秒时切断连接。

export function acceptsEventStream(req) {
  return String(req.get('accept') || '').includes('text/event-stream');
}

export function openEventStream(res, { heartbeatMs = 15000 } = {}) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(': stream-open\n\n');

  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded && !res.destroyed) res.write(': ping\n\n');
  }, heartbeatMs);
  heartbeat.unref?.();
  const stop = () => {
    closed = true;
    clearInterval(heartbeat);
  };
  res.on('close', stop);

  return {
    send(event, data) {
      if (closed || res.writableEnded || res.destroyed) return false;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    },
    end() {
      if (res.writableEnded || res.destroyed) {
        stop();
        return;
      }
      stop();
      res.end();
    },
    get closed() {
      return closed || res.writableEnded || res.destroyed;
    },
  };
}
