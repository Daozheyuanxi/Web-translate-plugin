<<<<<<< HEAD
/**
 * Gemini API 封装模块
 * 使用 gemini-2.5-flash 模型进行翻译
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_NAME = 'gemini-2.5-flash';

/**
 * 从 Chrome Storage 获取 API Key
 */
async function getApiKey() {
  const result = await chrome.storage.sync.get(['geminiApiKey']);
  if (!result.geminiApiKey) {
    throw new Error('未设置 Gemini API Key，请在插件设置中配置。');
  }
  return result.geminiApiKey;
}

/**
 * 将 Gemini API 错误信息翻译为中文
 */
function translateApiError(status, errorMessage) {
  // 按 HTTP 状态码映射
  const statusMessages = {
    400: 'API 请求格式错误',
    401: 'API Key 无效或已过期，请检查设置',
    403: 'API Key 无权访问此服务，请检查权限',
    404: 'API 模型不存在或已下线',
    429: '请求频率过高或用量已耗尽，请稍后重试',
    500: 'Gemini 服务器内部错误，请稍后重试',
    503: 'Gemini 服务暂时不可用，请稍后重试',
  };

  // 按错误信息关键词映射
  const keywordMessages = [
    { keyword: 'quota', msg: 'API 用量已耗尽，请检查账单或等待重置' },
    { keyword: 'rate limit', msg: '请求频率超限，请稍后重试' },
    { keyword: 'billing', msg: '计费问题，请检查 Google Cloud 账户计费设置' },
    { keyword: 'permission', msg: 'API Key 权限不足，请检查配置' },
    { keyword: 'invalid', msg: 'API Key 无效，请重新配置' },
    { keyword: 'not found', msg: '服务不存在，请检查 API 配置' },
    { keyword: 'resource exhausted', msg: 'API 资源已耗尽，请等待配额重置或升级计划' },
    { keyword: 'safety', msg: '内容被安全策略拦截' },
    { keyword: 'blocked', msg: '请求被拦截，可能触发安全过滤' },
  ];

  const lowerErr = (errorMessage || '').toLowerCase();

  // 优先用关键词匹配（更精确）
  for (const { keyword, msg } of keywordMessages) {
    if (lowerErr.includes(keyword)) {
      return msg;
    }
  }

  // 其次用状态码
  if (status && statusMessages[status]) {
    return statusMessages[status];
  }

  // 最后返回原始错误 + 提示
  return errorMessage ? `API 错误: ${errorMessage}` : 'API 调用失败，请稍后重试';
}

/**
 * 调用 Gemini API 进行翻译
 * @param {string[]} texts - 要翻译的文本数组
 * @returns {Promise<string[]>} 翻译结果数组
 */
async function translateTexts(texts) {
  const apiKey = await getApiKey();

  if (!texts || texts.length === 0) return [];

  // 构建翻译提示
  const prompt = buildTranslationPrompt(texts);

  const url = `${GEMINI_API_BASE}/${MODEL_NAME}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      topP: 0.8,
      maxOutputTokens: 65536
    }
  };

  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (data.error) {
    const chineseMsg = translateApiError(response.status, data.error.message);
    throw new Error(chineseMsg);
  }

  const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!resultText) {
    throw new Error('Gemini API 返回结果为空');
  }

  return parseTranslationResult(resultText, texts.length);
}

/**
 * 调用 Gemini API 翻译单句（用于字幕实时翻译）
 * @param {string} text - 要翻译的英文文本
 * @returns {Promise<string>} 中文翻译
 */
async function translateSingle(text) {
  const apiKey = await getApiKey();

  if (!text || text.trim().length === 0) return '';

  const url = `${GEMINI_API_BASE}/${MODEL_NAME}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        parts: [{
          text: `将以下英文翻译为简体中文，只返回翻译结果，不要添加任何解释或额外内容：\n\n${text}`
        }]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      topP: 0.8,
      maxOutputTokens: 1024
    }
  };

  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(`Gemini API 错误: ${data.error.message}`);
  }

  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

/**
 * 构建批量翻译的提示词
 */
function buildTranslationPrompt(texts) {
  const numberedTexts = texts.map((t, i) => `[${i + 1}] ${t}`).join('\n');

  return `Translate each numbered line below from English to Simplified Chinese.
Rules:
- Keep the [N] numbering format exactly
- Output ONLY the translated lines, one per line
- Do NOT add any explanation, comments or extra text
- Keep any HTML tags unchanged
- Ensure EVERY numbered line has a translation

Input:
${numberedTexts}`;
}

/**
 * 解析翻译结果
 */
function parseTranslationResult(resultText, expectedCount) {
  const lines = resultText.trim().split('\n').filter(line => line.trim());
  const results = new Array(expectedCount).fill('');

  for (const line of lines) {
    // 匹配多种编号格式: [1] xxx, 1. xxx, 1) xxx, 1: xxx
    const match = line.match(/^\s*(?:\[(\d+)\]|(\d+)[.):\s])\s*(.+)$/);
    if (match) {
      const index = parseInt(match[1] || match[2]) - 1;
      const text = (match[3] || '').trim();
      if (index >= 0 && index < expectedCount && text) {
        results[index] = text;
      }
    }
  }

  // 如果编号匹配失败但行数完全一致，按顺序赋值
  const filledCount = results.filter(r => r).length;
  if (filledCount === 0 && lines.length === expectedCount) {
    for (let i = 0; i < expectedCount; i++) {
      // 去除可能的编号前缀
      results[i] = lines[i].replace(/^\s*(?:\[\d+\]|\d+[.):\s])\s*/, '').trim();
    }
  }

  return results;
}

/**
 * 带重试的 fetch
 */
async function fetchWithRetry(url, options, maxRetries = 3) {
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok || response.status === 400) {
        return response;
      }

      if (response.status === 429) {
        // 速率限制，等待后重试
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, (i + 1) * 2000));
          continue;
        }
        // 最后一次重试仍然 429，解析并抛出中文错误
        const data = await response.json().catch(() => ({}));
        throw new Error(translateApiError(429, data?.error?.message || 'rate limit exceeded'));
      }

      // 其他非 OK 状态码，解析并抛出中文错误
      const data = await response.json().catch(() => ({}));
      throw new Error(translateApiError(response.status, data?.error?.message || ''));
    } catch (error) {
      lastError = error;
      if (error.message && !error.message.includes('fetch')) {
        // 如果是我们翻译过的错误，直接抛出
        if (i >= maxRetries - 1) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, (i + 1) * 1000));
    }
  }

  throw lastError || new Error('网络请求失败，请检查网络连接');
}

// 暴露给 service-worker 使用
export { translateTexts, translateSingle, getApiKey, translateApiError };
=======
/**
 * Gemini API 封装模块
 * 使用 gemini-2.5-flash 模型进行翻译
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_NAME = 'gemini-2.5-flash';

/**
 * 从 Chrome Storage 获取 API Key
 */
async function getApiKey() {
  const result = await chrome.storage.sync.get(['geminiApiKey']);
  if (!result.geminiApiKey) {
    throw new Error('未设置 Gemini API Key，请在插件设置中配置。');
  }
  return result.geminiApiKey;
}

/**
 * 将 Gemini API 错误信息翻译为中文
 */
function translateApiError(status, errorMessage) {
  // 按 HTTP 状态码映射
  const statusMessages = {
    400: 'API 请求格式错误',
    401: 'API Key 无效或已过期，请检查设置',
    403: 'API Key 无权访问此服务，请检查权限',
    404: 'API 模型不存在或已下线',
    429: '请求频率过高或用量已耗尽，请稍后重试',
    500: 'Gemini 服务器内部错误，请稍后重试',
    503: 'Gemini 服务暂时不可用，请稍后重试',
  };

  // 按错误信息关键词映射
  const keywordMessages = [
    { keyword: 'quota', msg: 'API 用量已耗尽，请检查账单或等待重置' },
    { keyword: 'rate limit', msg: '请求频率超限，请稍后重试' },
    { keyword: 'billing', msg: '计费问题，请检查 Google Cloud 账户计费设置' },
    { keyword: 'permission', msg: 'API Key 权限不足，请检查配置' },
    { keyword: 'invalid', msg: 'API Key 无效，请重新配置' },
    { keyword: 'not found', msg: '服务不存在，请检查 API 配置' },
    { keyword: 'resource exhausted', msg: 'API 资源已耗尽，请等待配额重置或升级计划' },
    { keyword: 'safety', msg: '内容被安全策略拦截' },
    { keyword: 'blocked', msg: '请求被拦截，可能触发安全过滤' },
  ];

  const lowerErr = (errorMessage || '').toLowerCase();

  // 优先用关键词匹配（更精确）
  for (const { keyword, msg } of keywordMessages) {
    if (lowerErr.includes(keyword)) {
      return msg;
    }
  }

  // 其次用状态码
  if (status && statusMessages[status]) {
    return statusMessages[status];
  }

  // 最后返回原始错误 + 提示
  return errorMessage ? `API 错误: ${errorMessage}` : 'API 调用失败，请稍后重试';
}

/**
 * 调用 Gemini API 进行翻译
 * @param {string[]} texts - 要翻译的文本数组
 * @returns {Promise<string[]>} 翻译结果数组
 */
async function translateTexts(texts) {
  const apiKey = await getApiKey();

  if (!texts || texts.length === 0) return [];

  // 构建翻译提示
  const prompt = buildTranslationPrompt(texts);

  const url = `${GEMINI_API_BASE}/${MODEL_NAME}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      topP: 0.8,
      maxOutputTokens: 65536
    }
  };

  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (data.error) {
    const chineseMsg = translateApiError(response.status, data.error.message);
    throw new Error(chineseMsg);
  }

  const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!resultText) {
    throw new Error('Gemini API 返回结果为空');
  }

  return parseTranslationResult(resultText, texts.length);
}

/**
 * 调用 Gemini API 翻译单句（用于字幕实时翻译）
 * @param {string} text - 要翻译的英文文本
 * @returns {Promise<string>} 中文翻译
 */
async function translateSingle(text) {
  const apiKey = await getApiKey();

  if (!text || text.trim().length === 0) return '';

  const url = `${GEMINI_API_BASE}/${MODEL_NAME}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        parts: [{
          text: `将以下英文翻译为简体中文，只返回翻译结果，不要添加任何解释或额外内容：\n\n${text}`
        }]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      topP: 0.8,
      maxOutputTokens: 1024
    }
  };

  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(`Gemini API 错误: ${data.error.message}`);
  }

  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

/**
 * 构建批量翻译的提示词
 */
function buildTranslationPrompt(texts) {
  const numberedTexts = texts.map((t, i) => `[${i + 1}] ${t}`).join('\n');

  return `Translate each numbered line below from English to Simplified Chinese.
Rules:
- Keep the [N] numbering format exactly
- Output ONLY the translated lines, one per line
- Do NOT add any explanation, comments or extra text
- Keep any HTML tags unchanged
- Ensure EVERY numbered line has a translation

Input:
${numberedTexts}`;
}

/**
 * 解析翻译结果
 */
function parseTranslationResult(resultText, expectedCount) {
  const lines = resultText.trim().split('\n').filter(line => line.trim());
  const results = new Array(expectedCount).fill('');

  for (const line of lines) {
    // 匹配多种编号格式: [1] xxx, 1. xxx, 1) xxx, 1: xxx
    const match = line.match(/^\s*(?:\[(\d+)\]|(\d+)[.):\s])\s*(.+)$/);
    if (match) {
      const index = parseInt(match[1] || match[2]) - 1;
      const text = (match[3] || '').trim();
      if (index >= 0 && index < expectedCount && text) {
        results[index] = text;
      }
    }
  }

  // 如果编号匹配失败但行数完全一致，按顺序赋值
  const filledCount = results.filter(r => r).length;
  if (filledCount === 0 && lines.length === expectedCount) {
    for (let i = 0; i < expectedCount; i++) {
      // 去除可能的编号前缀
      results[i] = lines[i].replace(/^\s*(?:\[\d+\]|\d+[.):\s])\s*/, '').trim();
    }
  }

  return results;
}

/**
 * 带重试的 fetch
 */
async function fetchWithRetry(url, options, maxRetries = 3) {
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok || response.status === 400) {
        return response;
      }

      if (response.status === 429) {
        // 速率限制，等待后重试
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, (i + 1) * 2000));
          continue;
        }
        // 最后一次重试仍然 429，解析并抛出中文错误
        const data = await response.json().catch(() => ({}));
        throw new Error(translateApiError(429, data?.error?.message || 'rate limit exceeded'));
      }

      // 其他非 OK 状态码，解析并抛出中文错误
      const data = await response.json().catch(() => ({}));
      throw new Error(translateApiError(response.status, data?.error?.message || ''));
    } catch (error) {
      lastError = error;
      if (error.message && !error.message.includes('fetch')) {
        // 如果是我们翻译过的错误，直接抛出
        if (i >= maxRetries - 1) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, (i + 1) * 1000));
    }
  }

  throw lastError || new Error('网络请求失败，请检查网络连接');
}

// 暴露给 service-worker 使用
export { translateTexts, translateSingle, getApiKey, translateApiError };
>>>>>>> c14eadc151a0cfc871e90e8c7436b7bc1c7b7a50
