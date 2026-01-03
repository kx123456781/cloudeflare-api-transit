// Cloudflare Worker - 动态多模型 AI API 中转服务
// 支持客户端指定任意提供商和模型,无需预定义模型列表

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
    usesQueryParam: true  // API key 在 URL query 中
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
        version: '3.0.0-dynamic'
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
        error: 'Missing required fields: model, messages',
        hint: 'Optionally specify "provider" field to explicitly choose provider'
      }, 400);
    }

    // 获取提供商配置
    let providerName = explicitProvider;
    let providerConfig;

    if (explicitProvider) {
      // 客户端显式指定提供商
      providerConfig = AI_PROVIDERS[explicitProvider.toLowerCase()];
      if (!providerConfig) {
        return jsonResponse({ 
          error: `Unknown provider: ${explicitProvider}`,
          availableProviders: Object.keys(AI_PROVIDERS)
        }, 400);
      }
    } else {
      // 自动检测提供商
      const detected = autoDetectProvider(model);
      if (detected) {
        providerName = detected.name;
        providerConfig = detected.config;
      } else {
        return jsonResponse({ 
          error: `Cannot auto-detect provider for model: ${model}`,
          hint: 'Please specify "provider" field explicitly in request body',
          example: { provider: 'openai', model: 'gpt-4', messages: [...] }
        }, 400);
      }
    }

    // 获取 API Key
    const apiKey = extractApiKey(request);
    if (!apiKey) {
      return jsonResponse({ 
        error: 'Missing API key',
        hint: 'Provide API key in X-API-Key or Authorization header'
      }, 401);
    }

    // 路由到对应的处理函数
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
    return jsonResponse({ 
      error: error.message,
      type: 'internal_error'
    }, 500);
  }
}

// 自动检测提供商 (基于常见模型前缀)
function autoDetectProvider(model) {
  const patterns = {
    openai: /^(gpt-|o1-|text-|davinci|curie|babbage|ada)/i,
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

// 提取 API Key
function extractApiKey(request) {
  const xApiKey = request.headers.get('X-API-Key');
  if (xApiKey) return xApiKey;

  const authHeader = request.headers.get('Authorization');
  if (authHeader) {
    return authHeader.replace('Bearer ', '').trim();
  }

  return null;
}

// OpenAI 格式 API (适用于 OpenAI, xAI, DeepSeek, Groq, Together, Mistral, OpenRouter 等)
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
    const errorText = await response.text();
    return jsonResponse({ 
      error: `${providerName} API error`,
      status: response.status,
      details: errorText 
    }, response.status);
  }

  if (stream) {
    return new Response(response.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        ...getCORSHeaders()
      }
    });
  }

  const data = await response.json();
  return jsonResponse(data);
}

// Claude API (Anthropic)
async function proxyToClaude(body, apiKey, config) {
  const { model, messages, temperature, max_tokens, top_p, stream = false } = body;
  
  const systemMessages = messages.filter(m => m.role === 'system');
  const userMessages = messages.filter(m => m.role !== 'system');
  
  const claudeRequest = {
    model: model,
    messages: userMessages,
    max_tokens: max_tokens || 4096,
    stream: stream
  };

  if (temperature !== undefined) claudeRequest.temperature = temperature;
  if (top_p !== undefined) claudeRequest.top_p = top_p;
  if (systemMessages.length > 0) {
    claudeRequest.system = systemMessages.map(m => m.content).join('\n');
  }

  const headers = {
    'Content-Type': 'application/json',
    [config.authHeader]: config.authFormat(apiKey),
    ...config.extraHeaders
  };

  const response = await fetch(`${config.baseUrl}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(claudeRequest)
  });

  if (!response.ok) {
    const error = await response.text();
    return jsonResponse({ error: 'Claude API error', details: error }, response.status);
  }

  if (stream) {
    const { readable, writable } = new TransformStream();
    streamClaudeToOpenAI(response.body, writable, model);
    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...getCORSHeaders()
      }
    });
  }

  const data = await response.json();
  return jsonResponse(convertClaudeToOpenAI(data, model));
}

// Gemini API (Google)
async function proxyToGemini(body, apiKey, config) {
  const { model, messages, temperature, max_tokens, top_p, stream = false } = body;
  
  const contents = messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.role === 'system' ? `[System] ${msg.content}` : msg.content }]
  }));
  
  const geminiRequest = {
    contents,
    generationConfig: {}
  };

  if (temperature !== undefined) geminiRequest.generationConfig.temperature = temperature;
  if (max_tokens !== undefined) geminiRequest.generationConfig.maxOutputTokens = max_tokens;
  if (top_p !== undefined) geminiRequest.generationConfig.topP = top_p;

  const endpoint = stream ? 'streamGenerateContent' : 'generateContent';
  const modelName = model.includes('models/') ? model : `models/${model}`;
  const url = `${config.baseUrl}/${modelName}:${endpoint}?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(geminiRequest)
  });

  if (!response.ok) {
    const error = await response.text();
    return jsonResponse({ error: 'Gemini API error', details: error }, response.status);
  }

  if (stream) {
    const { readable, writable } = new TransformStream();
    streamGeminiToOpenAI(response.body, writable, model);
    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...getCORSHeaders()
      }
    });
  }

  const data = await response.json();
  return jsonResponse(convertGeminiToOpenAI(data, model));
}

// Cohere API
async function proxyToCohere(body, apiKey, config) {
  const { model, messages, temperature, max_tokens, stream = false } = body;
  
  // Cohere 使用不同的格式
  const lastMessage = messages[messages.length - 1];
  const chatHistory = messages.slice(0, -1).map(m => ({
    role: m.role === 'assistant' ? 'CHATBOT' : 'USER',
    message: m.content
  }));

  const cohereRequest = {
    model: model,
    message: lastMessage.content,
    chat_history: chatHistory,
    stream: stream
  };

  if (temperature !== undefined) cohereRequest.temperature = temperature;
  if (max_tokens !== undefined) cohereRequest.max_tokens = max_tokens;

  const response = await fetch(`${config.baseUrl}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [config.authHeader]: config.authFormat(apiKey)
    },
    body: JSON.stringify(cohereRequest)
  });

  if (!response.ok) {
    const error = await response.text();
    return jsonResponse({ error: 'Cohere API error', details: error }, response.status);
  }

  const data = await response.json();
  
  // 转换为 OpenAI 格式
  return jsonResponse({
    id: data.generation_id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: data.text
      },
      finish_reason: data.finish_reason || 'stop'
    }],
    usage: {
      prompt_tokens: data.meta?.tokens?.input_tokens || 0,
      completion_tokens: data.meta?.tokens?.output_tokens || 0,
      total_tokens: (data.meta?.tokens?.input_tokens || 0) + (data.meta?.tokens?.output_tokens || 0)
    }
  });
}

// 获取提供商的模型列表
async function getProviderModels(request, providerName) {
  const config = AI_PROVIDERS[providerName];
  
  if (!config) {
    return jsonResponse({ 
      error: `Unknown provider: ${providerName}`,
      availableProviders: Object.keys(AI_PROVIDERS)
    }, 404);
  }

  if (!config.modelsEndpoint) {
    return jsonResponse({ 
      error: `Provider ${providerName} does not support model listing`,
      hint: 'Refer to provider documentation for available models'
    }, 400);
  }

  const apiKey = extractApiKey(request);
  if (!apiKey) {
    return jsonResponse({ 
      error: 'Missing API key',
      hint: 'Provide API key in X-API-Key or Authorization header'
    }, 401);
  }

  try {
    const headers = {
      [config.authHeader]: config.authFormat(apiKey),
      ...(config.extraHeaders || {})
    };

    const response = await fetch(`${config.baseUrl}${config.modelsEndpoint}`, {
      headers
    });

    if (!response.ok) {
      const error = await response.text();
      return jsonResponse({ error: 'Failed to fetch models', details: error }, response.status);
    }

    const data = await response.json();
    return jsonResponse(data);
  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

// 列出支持的提供商
function listProviders() {
  const providers = Object.entries(AI_PROVIDERS).map(([name, config]) => ({
    name,
    baseUrl: config.baseUrl,
    format: config.format,
    supportsModelListing: !!config.modelsEndpoint
  }));
  
  return jsonResponse({
    providers,
    usage: {
      listModels: 'GET /v1/providers/{provider}/models with API key',
      chatCompletion: 'POST /v1/chat/completions with {"provider": "...", "model": "...", "messages": [...]}'
    }
  });
}

// 格式转换函数
function convertClaudeToOpenAI(claudeResponse, model) {
  const content = claudeResponse.content?.[0]?.text || '';
  
  return {
    id: claudeResponse.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content
      },
      finish_reason: claudeResponse.stop_reason || 'stop'
    }],
    usage: {
      prompt_tokens: claudeResponse.usage?.input_tokens || 0,
      completion_tokens: claudeResponse.usage?.output_tokens || 0,
      total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0)
    }
  };
}

function convertGeminiToOpenAI(geminiResponse, model) {
  const candidate = geminiResponse.candidates?.[0];
  const content = candidate?.content?.parts?.[0]?.text || '';
  
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content
      },
      finish_reason: candidate?.finishReason?.toLowerCase() || 'stop'
    }],
    usage: {
      prompt_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
      completion_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
      total_tokens: geminiResponse.usageMetadata?.totalTokenCount || 0
    }
  };
}

// 流式转换函数
async function streamClaudeToOpenAI(readableStream, writable, model) {
  const writer = writable.getWriter();
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  try {
    let buffer = '';
    let hasContent = false;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        
        try {
          const data = JSON.parse(jsonStr);
          
          // 文本增量
          if (data.type === 'content_block_delta' && data.delta?.text) {
            hasContent = true;
            const chunk = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{
                index: 0,
                delta: { content: data.delta.text },
                finish_reason: null
              }]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
          
          // 工具调用增量
          if (data.type === 'content_block_delta' && data.delta?.type === 'input_json_delta') {
            hasContent = true;
            const chunk = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: data.index || 0,
                    function: {
                      arguments: data.delta.partial_json
                    }
                  }]
                },
                finish_reason: null
              }]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
          
          // 工具调用开始
          if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
            hasContent = true;
            const chunk = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: data.index || 0,
                    id: data.content_block.id,
                    type: 'function',
                    function: {
                      name: data.content_block.name,
                      arguments: ''
                    }
                  }]
                },
                finish_reason: null
              }]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
          
          // 消息结束
          if (data.type === 'message_delta' && data.delta?.stop_reason) {
            const finishReason = FINISH_REASON_MAP[data.delta.stop_reason] || 'stop';
            const chunk = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: finishReason
              }]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
          
          if (data.type === 'message_stop') {
            await writer.write(encoder.encode('data: [DONE]\n\n'));
          }
          
          // 错误事件
          if (data.type === 'error') {
            const errorChunk = {
              error: {
                message: data.error?.message || 'Stream error',
                type: data.error?.type || 'stream_error'
              }
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
            break;
          }
        } catch (e) {
          console.error('Claude stream parse error:', e, 'line:', jsonStr);
        }
      }
    }
    
    if (hasContent) {
      await writer.write(encoder.encode('data: [DONE]\n\n'));
    }
  } catch (error) {
    console.error('Claude stream error:', error);
    try {
      const errorChunk = {
        error: {
          message: error.message,
          type: 'stream_error'
        }
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
    } catch {}
  } finally {
    writer.close();
  }
}

async function streamGeminiToOpenAI(readableStream, writable, model) {
  const writer = writable.getWriter();
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  try {
    let buffer = '';
    let hasContent = false;
    let lastFinishReason = null;
    let hasError = false;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        
        const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed;
        if (!jsonStr || jsonStr === '[DONE]') continue;
        
        try {
          const data = JSON.parse(jsonStr);
          
          // 检查错误
          if (data.error) {
            hasError = true;
            const errorChunk = {
              error: {
                message: data.error.message || 'Gemini API error',
                type: data.error.status || 'api_error',
                code: data.error.code
              }
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
            break;
          }
          
          const candidate = data.candidates?.[0];
          
          // 无 candidates 容错
          if (!candidate) {
            if (!hasError && !hasContent) {
              const warningChunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                  index: 0,
                  delta: { 
                    content: '[Content filtered by safety settings]' 
                  },
                  finish_reason: 'content_filter'
                }]
              };
              await writer.write(encoder.encode(`data: ${JSON.stringify(warningChunk)}\n\n`));
              hasError = true;
            }
            continue;
          }
          
          // 处理文本内容
          const textPart = candidate.content?.parts?.find(p => p.text);
          if (textPart?.text) {
            hasContent = true;
            const chunk = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{
                index: 0,
                delta: { content: textPart.text },
                finish_reason: null
              }]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
          
          // 处理函数调用
          const functionCall = candidate.content?.parts?.find(p => p.functionCall);
          if (functionCall) {
            hasContent = true;
            const chunk = {
              id: `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: `call_${Date.now()}`,
                    type: 'function',
                    function: {
                      name: functionCall.functionCall.name,
                      arguments: JSON.stringify(functionCall.functionCall.args || {})
                    }
                  }]
                },
                finish_reason: null
              }]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
          
          // 记录 finishReason
          if (candidate.finishReason) {
            lastFinishReason = candidate.finishReason;
          }
        } catch (e) {
          console.error('Gemini stream parse error:', e, 'line:', jsonStr);
        }
      }
    }
    
    // 发送最终 finish_reason 和 [DONE]
    if (hasContent || hasError) {
      if (!hasError) {
        const mappedReason = FINISH_REASON_MAP[lastFinishReason] || 'stop';
        const finalChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: mappedReason
          }]
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
      }
      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } else {
      const errorChunk = {
        error: {
          message: 'No content received from Gemini',
          type: 'empty_response'
        }
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
    }
  } catch (error) {
    console.error('Gemini stream error:', error);
    try {
      const errorChunk = {
        error: {
          message: error.message || 'Stream processing error',
          type: 'stream_error'
        }
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
    } catch {}
  } finally {
    writer.close();
  }
}

// ==================== 模型列表 ====================
async function getProviderModels(request, providerName, env) {
  const config = AI_PROVIDERS[providerName];
  
  if (!config) {
    return jsonResponse({ 
      error: `Unknown provider: ${providerName}`,
      availableProviders: Object.keys(AI_PROVIDERS)
    }, 404);
  }

  if (!config.modelsEndpoint) {
    return jsonResponse({ 
      error: `Provider ${providerName} does not support model listing`,
      hint: 'Refer to provider documentation for available models'
    }, 400);
  }

  const apiKeyResult = extractAndValidateApiKey(request, config);
  if (!apiKeyResult.success) {
    return jsonResponse({ 
      error: apiKeyResult.error,
      hint: apiKeyResult.hint
    }, 401);
  }

  try {
    const url = new URL(request.url);
    const headers = buildHeaders(config, apiKeyResult.apiKey);
    
    let apiUrl = `${config.baseUrl}${config.modelsEndpoint}`;
    
    if (config.supportsPagination) {
      const params = new URLSearchParams();
      const limit = url.searchParams.get('limit') || '100';
      const after = url.searchParams.get('after');
      
      params.append('limit', limit);
      if (after) params.append('after', after);
      
      apiUrl += `?${params.toString()}`;
    }
    
    const response = await fetchWithTimeout(apiUrl, { headers }, REQUEST_TIMEOUT);

    if (!response.ok) {
      return handleErrorResponse(response, providerName);
    }

    const data = await response.json();
    
    if (config.supportsPagination && data.data) {
      return jsonResponse({
        ...data,
        pagination: {
          hasMore: data.has_more || false,
          nextCursor: data.data[data.data.length - 1]?.id,
          hint: 'Use ?limit=N&after=CURSOR for pagination'
        }
      });
    }
    
    return jsonResponse(data);
  } catch (error) {
    if (error.message.includes('timeout')) {
      return jsonResponse({
        error: 'Request timeout',
        hint: 'The provider took too long to respond. Try again or use pagination.',
        details: error.message
      }, 504);
    }
    
    return jsonResponse({ 
      error: 'Failed to fetch models',
      details: error.message 
    }, 500);
  }
}

function listProviders() {
  const providers = Object.entries(AI_PROVIDERS).map(([name, config]) => ({
    name,
    baseUrl: config.baseUrl,
    format: config.format,
    supportsModelListing: !!config.modelsEndpoint,
    supportsVision: !!config.supportsVision,
    supportsFunctionCalling: !!config.supportsFunctionCalling,
    authScheme: config.authScheme
  }));
  
  return jsonResponse({
    providers,
    features: {
      multimodal: 'Send images via content array with type: image_url',
      functionCalling: 'Use tools and tool_choice parameters',
      retry: 'Automatic retry with exponential backoff for 429 and 5xx',
      gatewayAuth: 'Set GATEWAY_SECRET env var to enable gateway authentication'
    },
    usage: {
      explicitProvider: 'POST /v1/chat/completions with {"provider": "openai", "model": "gpt-4", "messages": [...]}',
      autoDetect: 'POST /v1/chat/completions with {"model": "gpt-4", "messages": [...]}',
      listModels: 'GET /v1/providers/{provider}/models with API key',
      multimodal: 'messages: [{"role": "user", "content": [{"type": "text", "text": "..."}, {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}]}]',
      functionCalling: '{"tools": [{"type": "function", "function": {"name": "...", "description": "...", "parameters": {...}}}], "tool_choice": "auto"}'
    }
  });
}

// ==================== 工具函数 ====================
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCORSHeaders()
    }
  });
}

function getCORSHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Gateway-Secret',
    'Access-Control-Max-Age': '86400'
  };
}

function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: getCORSHeaders()
  });
}
  const encoder = new TextEncoder();

  try {
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;
          
          try {
            const data = JSON.parse(jsonStr);
            
            if (data.type === 'content_block_delta' && data.delta?.text) {
              const chunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                  index: 0,
                  delta: { content: data.delta.text },
                  finish_reason: null
                }]
              };
              await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            } else if (data.type === 'message_stop') {
              await writer.write(encoder.encode('data: [DONE]\n\n'));
            }
          } catch (e) {
            console.error('Parse error:', e);
          }
        }
      }
    }
  } finally {
    writer.close();
  }
}

async function streamGeminiToOpenAI(readableStream, writable, model) {
  const writer = writable.getWriter();
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  try {
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6);
          if (jsonStr === '[DONE]') continue;
          
          try {
            const data = JSON.parse(jsonStr);
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            
            if (text) {
              const chunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                  index: 0,
                  delta: { content: text },
                  finish_reason: null
                }]
              };
              await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
          } catch (e) {
            console.error('Parse error:', e);
          }
        }
      }
    }
    
    await writer.write(encoder.encode('data: [DONE]\n\n'));
  } finally {
    writer.close();
  }
}

// 工具函数
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCORSHeaders()
    }
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
  return new Response(null, {
    status: 204,
    headers: getCORSHeaders()
  });
}