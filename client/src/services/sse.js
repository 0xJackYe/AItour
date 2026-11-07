// 极简 SSE 解析器：EventSource 只支持 GET，这里配合 fetch(POST) 的流式 body 使用。

export function parseEventBlock(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  const raw = data.join('\n');
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event, data: raw };
  }
}

export function createSseParser(onEvent) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop();
      for (const block of blocks) {
        const event = parseEventBlock(block);
        if (event) onEvent(event);
      }
    },
    flush() {
      const rest = buffer;
      buffer = '';
      if (rest.trim()) {
        const event = parseEventBlock(rest);
        if (event) onEvent(event);
      }
    },
  };
}
