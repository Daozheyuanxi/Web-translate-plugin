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
      maxOutputTokens: 8192
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

  return `你是一个专业的翻译引擎。请将以下编号的英文文本翻译为简体中文。

要求：
1. 保持编号格式不变，每行一个翻译结果
2. 只返回翻译结果，不要添加解释
3. 保持原始HTML标签不变（如果有的话）
4. 翻译要自然流畅，符合中文表达习惯

原文：
${numberedTexts}`;
}

/**
 * 解析翻译结果
 */
function parseTranslationResult(resultText, expectedCount) {
  const lines = resultText.trim().split('\n').filter(line => line.trim());
  const results = [];

  for (const line of lines) {
    // 匹配 [数字] 格式
    const match = line.match(/^\[(\d+)\]\s*(.+)$/);
    if (match) {
      const index = parseInt(match[1]) - 1;
      results[index] = match[2].trim();
    }
  }

  // 确保结果数量与输入一致
  const finalResults = [];
  for (let i = 0; i < expectedCount; i++) {
    finalResults.push(results[i] || '');
  }

  return finalResults;
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
        await new Promise(resolve => setTimeout(resolve, (i + 1) * 2000));
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, (i + 1) * 1000));
    }
  }

  throw lastError || new Error('请求失败，已达到最大重试次数');
}

// 暴露给 service-worker 使用
export { translateTexts, translateSingle, getApiKey };
