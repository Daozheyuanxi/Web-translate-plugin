/**
 * Background Service Worker
 * 处理来自 Content Script 和 Popup 的消息，调用 Gemini API
 */

import { translateTexts, translateSingle, getApiKey, translateApiError } from '../utils/api.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_NAME = 'gemini-2.5-flash';

// 翻译缓存
const translationCache = new Map();

// 监听消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse).catch(err => {
        sendResponse({ error: err.message });
    });
    return true; // 保持消息通道开放，等待异步响应
});

/**
 * 消息处理路由
 */
async function handleMessage(message, sender) {
    switch (message.type) {
        case 'TRANSLATE_BATCH':
            return handleTranslateBatch(message.data);

        case 'TRANSLATE_SINGLE':
            return handleTranslateSingle(message.data);

        case 'START_TAB_CAPTURE':
            return handleStartTabCapture(sender.tab);

        case 'STOP_TAB_CAPTURE':
            return handleStopTabCapture();

        case 'CHECK_API_KEY':
            return handleCheckApiKey();

        case 'API_PING':
            return handleApiPing();

        case 'GET_TRANSLATE_STATUS':
            return { isTranslating: false };

        default:
            return { error: '未知的消息类型: ' + message.type };
    }
}

/**
 * API 连接测试（ping）
 * 发送一个极小的请求来测试连接和延迟
 */
async function handleApiPing() {
    const startTime = Date.now();
    try {
        const apiKey = await getApiKey();
        const url = `${GEMINI_API_BASE}/${MODEL_NAME}:generateContent?key=${apiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: 'Reply with only: OK' }] }],
                generationConfig: { maxOutputTokens: 5 }
            })
        });

        const latency = Date.now() - startTime;

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            const errMsg = translateApiError(response.status, data?.error?.message);
            return { success: false, latency, error: errMsg };
        }

        return { success: true, latency };
    } catch (error) {
        const latency = Date.now() - startTime;
        return { success: false, latency, error: error.message };
    }
}

/**
 * 批量翻译
 */
async function handleTranslateBatch(data) {
    const { texts, batchId } = data;

    // 检查缓存
    const uncachedTexts = [];
    const uncachedIndices = [];
    const results = new Array(texts.length);

    for (let i = 0; i < texts.length; i++) {
        const cached = translationCache.get(texts[i]);
        if (cached) {
            results[i] = cached;
        } else {
            uncachedTexts.push(texts[i]);
            uncachedIndices.push(i);
        }
    }

    if (uncachedTexts.length > 0) {
        const translations = await translateTexts(uncachedTexts);

        for (let i = 0; i < uncachedTexts.length; i++) {
            const translation = translations[i] || uncachedTexts[i];
            translationCache.set(uncachedTexts[i], translation);
            results[uncachedIndices[i]] = translation;
        }
    }

    return { translations: results, batchId };
}

/**
 * 单句翻译（用于字幕）
 */
async function handleTranslateSingle(data) {
    const { text } = data;

    // 检查缓存
    const cached = translationCache.get(text);
    if (cached) {
        return { translation: cached };
    }

    const translation = await translateSingle(text);
    translationCache.set(text, translation);
    return { translation };
}

/**
 * 开始标签页音频捕获
 */
let captureStreamId = null;

async function handleStartTabCapture(tab) {
    try {
        // 使用 offscreen document 来处理音频
        const streamId = await chrome.tabCapture.getMediaStreamId({
            targetTabId: tab.id
        });

        captureStreamId = streamId;
        return { streamId, success: true };
    } catch (error) {
        return { error: error.message, success: false };
    }
}

/**
 * 停止标签页音频捕获
 */
async function handleStopTabCapture() {
    captureStreamId = null;
    return { success: true };
}

/**
 * 检查 API Key 是否已配置
 */
async function handleCheckApiKey() {
    try {
        const result = await chrome.storage.sync.get(['geminiApiKey']);
        return { hasKey: !!result.geminiApiKey };
    } catch {
        return { hasKey: false };
    }
}

// 安装或更新时的初始化
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        // 首次安装，打开设置页面
        chrome.runtime.openOptionsPage();
    }
});
