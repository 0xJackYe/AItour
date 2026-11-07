const DEFAULT_WORKERS_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

let workersAiBinding = null;

export function configureWorkersAI(binding) {
  workersAiBinding = binding && typeof binding.run === 'function' ? binding : null;
}

export function hasWorkersAI() {
  return Boolean(workersAiBinding);
}

export async function requestWorkersAiJson(systemPrompt, userContent, {
  maxTokens = 8192,
  temperature = 0.25,
} = {}) {
  if (!workersAiBinding) throw new Error('Cloudflare Workers AI binding is unavailable');

  const result = await workersAiBinding.run(
    process.env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL,
    {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    },
  );

  if (result && typeof result.response === 'object') return result.response;
  if (typeof result?.response === 'string') return result.response;
  if (typeof result === 'string') return result;
  const openAiContent = result?.choices?.[0]?.message?.content;
  if (typeof openAiContent === 'string') return openAiContent;
  throw new Error('Cloudflare Workers AI did not return JSON content');
}
