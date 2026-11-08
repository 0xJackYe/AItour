const DEFAULT_WORKERS_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

let workersAiBinding = null;

export function configureWorkersAI(binding) {
  workersAiBinding = binding && typeof binding.run === 'function' ? binding : null;
}

export function hasWorkersAI() {
  return Boolean(workersAiBinding);
}

function responseContent(result) {
  if (typeof result?.response === 'string') return result.response;
  if (result?.response && typeof result.response === 'object') return JSON.stringify(result.response);
  if (typeof result === 'string') return result;
  const openAiContent = result?.choices?.[0]?.message?.content;
  if (typeof openAiContent === 'string') return openAiContent;
  throw new Error('Cloudflare Workers AI did not return content');
}

export async function requestWorkersAiCompletion(system, user, {
  maxTokens = 8192,
  temperature = 0.3,
  onDelta = null,
} = {}) {
  if (!workersAiBinding) throw new Error('Cloudflare Workers AI binding is unavailable');

  const result = await workersAiBinding.run(
    process.env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL,
    {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature,
      max_tokens: Math.min(maxTokens, 8192),
      response_format: { type: 'json_object' },
    },
  );
  const content = responseContent(result);
  onDelta?.(content.length);
  return {
    content,
    finishReason: 'stop',
    usage: result?.usage || null,
  };
}
