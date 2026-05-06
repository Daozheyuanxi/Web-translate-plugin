/**
 * Background Service Worker
 * 处理来自 Content Script 和 Popup 的消息，调用 Gemini API
 */

import { translateTexts, translateSingle, translateCaptions, getApiKey, getGroqApiKey, translateApiError, transcribeAudio } from '../utils/api.js';

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

        case 'TRANSLATE_ALL_CAPTIONS':
            return handleTranslateAllCaptions(message.data);

        case 'TRANSLATE_SINGLE':
            return handleTranslateSingle(message.data);

        case 'START_TAB_CAPTURE':
            return handleStartTabCapture(sender.tab);

        case 'STOP_TAB_CAPTURE':
            return handleStopTabCapture();

        case 'AUDIO_CHUNK':
            return handleAudioChunk(message.data);

        case 'CHECK_API_KEY':
            return handleCheckApiKey();

        case 'CHECK_GROQ_KEY':
            return handleCheckGroqKey();

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
 * 一次性翻译全部字幕（1~2个请求完成整个视频）
 */
async function handleTranslateAllCaptions(data) {
    const { texts } = data;

    const translations = await translateCaptions(texts);

    // 缓存结果
    for (let i = 0; i < texts.length; i++) {
        if (translations[i]) {
            translationCache.set(texts[i], translations[i]);
        }
    }

    return { translations };
}

/**
 * 单句翻译（用于字幕）
 */
async function handleTranslateSingle(data) {
    const { text } = data;

    const cached = translationCache.get(text);
    if (cached) {
        return { translation: cached };
    }

    const translation = await translateSingle(text);
    translationCache.set(text, translation);
    return { translation };
}

// ====== Tab Audio Capture + Offscreen Document ======

let captureTabId = null;

/**
 * 开始标签页音频捕获
 * 1. 获取 tabCapture streamId
 * 2. 创建 offscreen document
 * 3. 通知 offscreen 开始录制
 */
async function handleStartTabCapture(tab) {
    try {
        // 获取 streamId
        const streamId = await chrome.tabCapture.getMediaStreamId({
            targetTabId: tab.id
        });

        captureTabId = tab.id;

        // 创建 offscreen document（如果尚未存在）
        await ensureOffscreenDocument();

        // 通知 offscreen document 开始录制
        const result = await chrome.runtime.sendMessage({
            type: 'OFFSCREEN_START_RECORDING',
            streamId: streamId
        });

        if (!result?.success) {
            throw new Error(result?.error || '启动录音失败');
        }

        return { success: true };
    } catch (error) {
        console.error('[SW] Tab capture error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 停止标签页音频捕获
 */
async function handleStopTabCapture() {
    try {
        // 通知 offscreen 停止录制
        await chrome.runtime.sendMessage({
            type: 'OFFSCREEN_STOP_RECORDING'
        }).catch(() => { });

        // 关闭 offscreen document
        await closeOffscreenDocument();

        captureTabId = null;
        return { success: true };
    } catch (error) {
        console.error('[SW] Stop capture error:', error);
        return { success: true }; // 即使出错也返回成功，确保 UI 状态正确
    }
}

/**
 * 处理音频片段：Groq Whisper 转写 → Gemini 翻译 → 广播结果
 */
async function handleAudioChunk(data) {
    const { audio, mimeType } = data;

    try {
        // 1. Groq Whisper 语音识别
        const englishText = await transcribeAudio(audio, mimeType);

        if (!englishText || englishText.trim().length === 0) {
            return { success: true, empty: true };
        }

        // 2. Gemini 翻译
        let chineseText = '';
        try {
            const cached = translationCache.get(englishText);
            if (cached) {
                chineseText = cached;
            } else {
                chineseText = await translateSingle(englishText);
                translationCache.set(englishText, chineseText);
            }
        } catch (err) {
            console.error('[SW] Translation error:', err);
            chineseText = '翻译失败';
        }

        // 3. 广播结果给 content script
        if (captureTabId) {
            chrome.tabs.sendMessage(captureTabId, {
                type: 'SUBTITLE_RESULT',
                data: { en: englishText, zh: chineseText }
            }).catch(() => { });
        }

        return { success: true, en: englishText, zh: chineseText };
    } catch (error) {
        console.error('[SW] Audio chunk processing error:', error);

        // 广播错误给 content script
        if (captureTabId) {
            chrome.tabs.sendMessage(captureTabId, {
                type: 'SUBTITLE_ERROR',
                data: { error: error.message }
            }).catch(() => { });
        }

        return { success: false, error: error.message };
    }
}

// ====== Offscreen Document 管理 ======

async function ensureOffscreenDocument() {
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (existingContexts.length > 0) return;

    await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: '录制标签页音频用于语音识别'
    });
}

async function closeOffscreenDocument() {
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (existingContexts.length > 0) {
        await chrome.offscreen.closeDocument();
    }
}

// ====== Key 检查 ======

async function handleCheckApiKey() {
    try {
        const result = await chrome.storage.sync.get(['geminiApiKey']);
        return { hasKey: !!result.geminiApiKey };
    } catch {
        return { hasKey: false };
    }
}

async function handleCheckGroqKey() {
    try {
        const result = await chrome.storage.sync.get(['groqApiKey']);
        return { hasKey: !!result.groqApiKey };
    } catch {
        return { hasKey: false };
    }
}

// 安装或更新时的初始化
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        chrome.runtime.openOptionsPage();
    }
});
