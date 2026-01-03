// Cloudflare Worker - 动态多模型 AI API 中转服务
// 已修复语法错误、删除重复定义并补全缺失逻辑

const AI_PROVIDERS = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    authHeader: 'Authorization',
    authFormat: (key) => `Bearer ${key}`,
    format: 'openai',
    modelsEndpoint: '/models'
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    authHeader: 'x-api-key',
    authFormat: (key) => key,
    format: 'claude',
    extraHeaders: { 'anthropic-version': '2023-06-01' }
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authHeader: 'x-goog-api-key',
    authFormat: (key) => key,
    format: 'gemini',
    usesQueryParam: true 
  },
  xai: {
    baseUrl: 'https://api.x.ai/v1',
    authHeader: 'Authorization',
    authFormat: (key) => `Bearer ${key}`,
    format: 'openai',
    modelsEndpoint: '/models'
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    authHeader: 'Authorization',
    authFormat: (key) => `Bearer ${key}`,
    format: 'openai',
    modelsEndpoint: '/models'
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    authHeader: 'Authorization',
    authFormat: (key) => `Bearer ${key}`,
    format: 'openai',
    modelsEndpoint: '/models'
  },
  together: {
    baseUrl: 'https://api.together.xyz/v1',
    authHeader: 'Authorization',
    authFormat: (key) => `Bearer ${key}`,
    format: 'openai',
    modelsEndpoint: '/models'
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    authHeader: 'Authorization',
    authFormat: (key) => `Bearer ${key}`,
    format: 'openai',
    modelsEndpoint: '/models'
  },
  cohere: {
    baseUrl: 'https://api.cohere.ai/v1',
    authHeader: 'Authorization',
    authFormat: (key) => `Bearer ${key}`,
    format: 'cohere'
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    authHeader: 'Authorization',
    authFormat: (key) => `Bearer ${key}`,
    format: 'openai',
    modelsEndpoint: '/models'
  }
};

const FINISH_REASON_MAP = {
  'end_turn': 'stop',
  'stop_sequence': 'stop',
  'max_tokens': 'length',
  'tool_use': 'tool_calls',
  'STOP': 'stop',
  'MAX_TOKENS': 'length',
  'SAFETY': 'content_filter'
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    const url = new URL(request.url);
    
    // 健康检查
    if (url.pathname === '/health') {
      return jsonResponse({ 
        status: 'ok',
        supportedProviders: Object.keys(AI_PROVIDERS),
        version: '3.0.0-fixed'
      });
    }

    // 列出支持的提供商
    if (url.pathname === '/v1/providers') {
      return listProviders();
    }

    // 动态获取某个提供商的模型列表
    if (url.pathname.match(/^\/v1\/providers\/[\w-]+\/models$/)) {
      const provider = url.pathname.split('/')[3];
      return getProviderModels(request, provider);
    }

    // 主要端点
    if (url.pathname === '/v1/chat/completions') {
      return handleChatCompletion(request, env);
    }

    return jsonResponse({ 
      error: 'Not Found',
      availableEndpoints: [
        '/health',
        '/v1/providers',
        '/v1/providers/{provider}/models',
        '/v1/chat/completions'
      ]
    }, 404);
  }
};

async function handleChatCompletion(request, env) {
  try {
    const body = await request.json();
    const { model, messages, stream = false, provider: explicitProvider } = body;

    if (!model || !messages) {
      return jsonResponse({ 
        error: 'Missing required fields: model, messages'
      }, 400);
    }

    let providerName = explicitProvider;
    let providerConfig;

    if (explicitProvider) {
      providerConfig = AI_PROVIDERS[explicitProvider.toLowerCase()];
      if (!providerConfig) {
        return jsonResponse({ 
          error: `Unknown provider: ${explicitProvider}`,
          availableProviders: Object.keys(AI_PROVIDERS)
        }, 400);
      }
    } else {
      const detected = autoDetectProvider(model);
      if (detected) {
        providerName = detected.name;
        providerConfig = detected.config;
      } else {
        return jsonResponse({ 
          error: `Cannot auto-detect provider for model: ${model}`,
          hint: 'Please specify "provider" field explicitly'
        }, 400);
      }
    }

    const apiKey = extractApiKey(request);
    if (!apiKey) {
      return jsonResponse({ error: 'Missing API key' }, 401);
    }

    switch (providerConfig.format) {
      case 'openai':
        return proxyToOpenAIFormat(body, apiKey, providerName, providerConfig);
      case 'claude':
        return proxyToClaude(body, apiKey, providerConfig);
      case 'gemini':
        return proxyToGemini(body, apiKey, providerConfig);
      case 'cohere':
        return proxyToCohere(body, apiKey, providerConfig);
      default:
        return jsonResponse({ error: 'Unsupported format' }, 500);
    }

  } catch (error) {
    console.error('Error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

function autoDetectProvider(model) {
  const patterns = {
    openai: /^(gpt-|o1-|text-|davinci)/i,
    anthropic: /^claude-/i,
    google: /^gemini-/i,
    xai: /^grok-/i,
    deepseek: /^deepseek-/i,
    mistral: /^(mistral-|mixtral-)/i,
    cohere: /^command-/i
  };

  for (const [name, pattern] of Object.entries(patterns)) {
    if (pattern.test(model)) {
      return { name, config: AI_PROVIDERS[name] };
    }
  }
  return null;
}

function extractApiKey(request) {
  const xApiKey = request.headers.get('X-API-Key');
  if (xApiKey) return xApiKey;
  const authHeader = request.headers.get('Authorization');
  if (authHeader) return authHeader.replace('Bearer ', '').trim();
  return null;
}

// --- 处理器部分 ---

async function proxyToOpenAIFormat(body, apiKey, providerName, config) {
  const { stream = false } = body;
  const headers = {
    'Content-Type': 'application/json',
    [config.authHeader]: config.authFormat(apiKey),
    ...(config.extraHeaders || {})
  };

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    return jsonResponse({ error: `${providerName} error`, details: await response.text() }, response.status);
  }

  if (stream) {
    return new Response(response.body, {
      headers: { 'Content-Type': 'text/event-stream', ...getCORSHeaders() }
    });
  }
  return jsonResponse(await response.json());
}

async function proxyToClaude(body, apiKey, config) {
  const { model, messages, temperature, max_tokens, stream = false } = body;
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const userMsgs = messages.filter(m => m.role !== 'system');
  
  const claudeReq = {
    model,
    messages: userMsgs,
    max_tokens: max_tokens || 4096,
    stream,
    system: system || undefined,
    temperature
  };

  const response = await fetch(`${config.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [config.authHeader]: config.authFormat(apiKey),
      ...config.extraHeaders
    },
    body: JSON.stringify(claudeReq)
  });

  if (!response.ok) return jsonResponse({ error: 'Claude error', details: await response.text() }, response.status);

  if (stream) {
    const { readable, writable } = new TransformStream();
    streamClaudeToOpenAI(response.body, writable, model);
    return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', ...getCORSHeaders() } });
  }

  return jsonResponse(convertClaudeToOpenAI(await response.json(), model));
}

async function proxyToGemini(body, apiKey, config) {
  const { model, messages, temperature, max_tokens, stream = false } = body;
  const contents = messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }]
  }));
  
  const geminiReq = { contents, generationConfig: { temperature, maxOutputTokens: max_tokens } };
  const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
  const url = `${config.baseUrl}/models/${model}:${endpoint}?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(geminiReq)
  });

  if (!response.ok) return jsonResponse({ error: 'Gemini error', details: await response.text() }, response.status);

  if (stream) {
    const { readable, writable } = new TransformStream();
    streamGeminiToOpenAI(response.body, writable, model);
    return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', ...getCORSHeaders() } });
  }

  return jsonResponse(convertGeminiToOpenAI(await response.json(), model));
}

async function proxyToCohere(body, apiKey, config) {
  const { model, messages, stream = false } = body;
  const cohereReq = {
    model,
    message: messages[messages.length - 1].content,
    chat_history: messages.slice(0, -1).map(m => ({ role: m.role === 'assistant' ? 'CHATBOT' : 'USER', message: m.content })),
    stream
  };

  const response = await fetch(`${config.baseUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [config.authHeader]: config.authFormat(apiKey) },
    body: JSON.stringify(cohereReq)
  });

  if (!response.ok) return jsonResponse({ error: 'Cohere error', details: await response.text() }, response.status);
  const data = await response.json();
  
  return jsonResponse({
    id: data.generation_id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ message: { role: 'assistant', content: data.text }, finish_reason: 'stop', index: 0 }]
  });
}

// --- 格式转换与流处理 ---

function convertClaudeToOpenAI(claude, model) {
  return {
    id: claude.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: claude.content[0].text },
      finish_reason: FINISH_REASON_MAP[claude.stop_reason] || 'stop'
    }],
    usage: { prompt_tokens: claude.usage.input_tokens, completion_tokens: claude.usage.output_tokens }
  };
}

function convertGeminiToOpenAI(gemini, model) {
  const candidate = gemini.candidates[0];
  return {
    id: `gemini-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: candidate.content.parts[0].text },
      finish_reason: FINISH_REASON_MAP[candidate.finishReason] || 'stop'
    }]
  };
}

async function streamClaudeToOpenAI(readable, writable, model) {
  const writer = writable.getWriter();
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  try {
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = JSON.parse(line.slice(6));
        if (data.type === 'content_block_delta') {
          const chunk = {
            id: 'claude-stream',
            object: 'chat.completion.chunk',
            choices: [{ delta: { content: data.delta.text }, index: 0, finish_reason: null }]
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        } else if (data.type === 'message_stop') {
          await writer.write(encoder.encode('data: [DONE]\n\n'));
        }
      }
    }
  } finally {
    writer.close();
  }
}

async function streamGeminiToOpenAI(readable, writable, model) {
  const writer = writable.getWriter();
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  try {
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        const data = JSON.parse(line.replace(/^data: /, ''));
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          const chunk = {
            id: 'gemini-stream',
            object: 'chat.completion.chunk',
            choices: [{ delta: { content: text }, index: 0, finish_reason: null }]
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
      }
    }
    await writer.write(encoder.encode('data: [DONE]\n\n'));
  } finally {
    writer.close();
  }
}

// --- 通用工具 ---

async function getProviderModels(request, providerName) {
  const config = AI_PROVIDERS[providerName];
  if (!config?.modelsEndpoint) return jsonResponse({ error: 'Not supported' }, 400);
  const apiKey = extractApiKey(request);
  if (!apiKey) return jsonResponse({ error: 'Missing API key' }, 401);

  const response = await fetch(`${config.baseUrl}${config.modelsEndpoint}`, {
    headers: { [config.authHeader]: config.authFormat(apiKey) }
  });
  return jsonResponse(await response.json());
}

function listProviders() {
  const providers = Object.keys(AI_PROVIDERS).map(name => ({
    name,
    format: AI_PROVIDERS[name].format
  }));
  return jsonResponse({ providers });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...getCORSHeaders() }
  });
}

function getCORSHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key'
  };
}

function handleCORS() {
  return new Response(null, { status: 204, headers: getCORSHeaders() });
}