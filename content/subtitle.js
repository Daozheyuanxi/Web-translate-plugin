/**
 * 视频字幕 Content Script
 * 通过标签页音频捕获 + Groq Whisper 语音识别 + Gemini 翻译
 * 显示中英双语字幕（滚动显示）
 */

(function () {
    'use strict';

    let isSubtitleActive = false;
    let subtitleContainer = null;
    let currentVideo = null;

    // ====== 字幕行队列 ======
    const MAX_VISIBLE_LINES = 3;
    const LINE_EXPIRE_MS = 10000;
    let subtitleLines = [];
    let lineIdCounter = 0;

    /**
     * 监听来自 Popup / Service Worker 的消息
     */
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message.type) {
            case 'TOGGLE_SUBTITLE':
                if (isSubtitleActive) {
                    stopSubtitle();
                    sendResponse({ status: 'stopped' });
                } else {
                    startSubtitle(sendResponse);
                    return true; // 异步响应
                }
                break;

            case 'GET_SUBTITLE_STATUS':
                sendResponse({
                    isActive: isSubtitleActive,
                    hasVideo: !!findVideo()
                });
                break;

            case 'SUBTITLE_RESULT':
                handleSubtitleResult(message.data);
                break;

            case 'SUBTITLE_ERROR':
                handleSubtitleError(message.data);
                break;
        }
    });

    /**
     * 查找页面中的视频元素
     */
    function findVideo() {
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
            if (!video.paused && video.readyState >= 2) {
                return video;
            }
        }
        return videos[0] || null;
    }

    /**
     * 开始字幕识别（Tab Audio Capture 模式）
     */
    async function startSubtitle(sendResponse) {
        currentVideo = findVideo();

        if (!currentVideo) {
            sendResponse({ status: 'error', message: '未找到视频元素' });
            return;
        }

        try {
            createSubtitleContainer();
            showStatusMessage('正在启动音频捕获...');

            // 请求 service worker 开始标签页音频捕获
            const response = await chrome.runtime.sendMessage({
                type: 'START_TAB_CAPTURE'
            });

            if (!response.success) {
                throw new Error(response.error || '无法捕获音频');
            }

            isSubtitleActive = true;
            subtitleLines = [];
            lineIdCounter = 0;

            showStatusMessage('音频捕获已启动，等待语音...');

            // 定期清理过期字幕行
            startPruneTimer();

            sendResponse({ status: 'started' });
        } catch (error) {
            console.error('启动字幕失败:', error);
            sendResponse({ status: 'error', message: error.message });
        }
    }

    /**
     * 接收来自 service worker 的转写+翻译结果
     */
    function handleSubtitleResult(data) {
        if (!isSubtitleActive) return;

        const { en, zh } = data;
        if (!en) return;

        hideStatusMessage();
        addSubtitleLine(en, zh);
    }

    /**
     * 接收来自 service worker 的错误
     */
    function handleSubtitleError(data) {
        if (!isSubtitleActive) return;
        console.error('[zhiyi] 字幕错误:', data.error);
        showStatusMessage('⚠️ ' + (data.error || '识别出错'));
    }

    // ==========================================================
    //  字幕行管理 + 滚动显示
    // ==========================================================

    /**
     * 添加一行字幕（英文 + 中文已就绪）
     */
    function addSubtitleLine(en, zh) {
        const lineId = ++lineIdCounter;

        const line = {
            id: lineId,
            en: en,
            zh: zh || '',
            timestamp: Date.now(),
            element: null
        };

        subtitleLines.push(line);
        pruneExpiredLines();
        renderSubtitleLines();
    }

    /**
     * 清理过期的字幕行
     */
    function pruneExpiredLines() {
        const now = Date.now();
        subtitleLines = subtitleLines.filter(
            line => (now - line.timestamp) < LINE_EXPIRE_MS
        );

        while (subtitleLines.length > MAX_VISIBLE_LINES) {
            subtitleLines.shift();
        }
    }

    /**
     * 渲染所有字幕行到容器
     */
    function renderSubtitleLines() {
        if (!subtitleContainer) return;

        const inner = subtitleContainer.querySelector('.zhiyi-subtitle-inner');
        if (!inner) return;

        // 移除旧的字幕行元素（保留 status 元素）
        const oldLines = inner.querySelectorAll('.zhiyi-subtitle-line');
        oldLines.forEach(el => el.remove());

        // 获取 status 元素的引用
        const statusEl = inner.querySelector('.zhiyi-subtitle-status');

        for (const line of subtitleLines) {
            const lineEl = document.createElement('div');
            lineEl.className = 'zhiyi-subtitle-line';
            lineEl.dataset.lineId = line.id;

            const enEl = document.createElement('div');
            enEl.className = 'zhiyi-subtitle-en';
            enEl.textContent = line.en;

            const zhEl = document.createElement('div');
            zhEl.className = 'zhiyi-subtitle-zh';
            zhEl.textContent = line.zh || '';

            if (!line.zh) {
                zhEl.textContent = '翻译中...';
                zhEl.classList.add('zhiyi-translating');
            }

            lineEl.appendChild(enEl);
            lineEl.appendChild(zhEl);
            line.element = lineEl;

            if (statusEl) {
                inner.insertBefore(lineEl, statusEl);
            } else {
                inner.appendChild(lineEl);
            }
        }
    }

    // ==========================================================
    //  定时清理
    // ==========================================================

    let pruneTimerId = null;

    function startPruneTimer() {
        stopPruneTimer();
        pruneTimerId = setInterval(() => {
            const before = subtitleLines.length;
            pruneExpiredLines();
            if (subtitleLines.length !== before) {
                renderSubtitleLines();
            }
        }, 2000);
    }

    function stopPruneTimer() {
        if (pruneTimerId) {
            clearInterval(pruneTimerId);
            pruneTimerId = null;
        }
    }

    // ==========================================================
    //  字幕容器 UI
    // ==========================================================

    function createSubtitleContainer() {
        removeSubtitleContainer();

        subtitleContainer = document.createElement('div');
        subtitleContainer.id = 'zhiyi-subtitle-container';
        subtitleContainer.className = 'zhiyi-subtitle';

        subtitleContainer.innerHTML = `
      <div class="zhiyi-subtitle-inner">
        <div class="zhiyi-subtitle-status" style="display: none;"></div>
      </div>
    `;

        if (currentVideo) {
            const videoParent = currentVideo.parentElement;
            const computedStyle = window.getComputedStyle(videoParent);
            if (computedStyle.position === 'static') {
                videoParent.style.position = 'relative';
            }
            videoParent.appendChild(subtitleContainer);
        } else {
            document.body.appendChild(subtitleContainer);
        }
    }

    function showStatusMessage(msg) {
        if (!subtitleContainer) return;
        const statusEl = subtitleContainer.querySelector('.zhiyi-subtitle-status');
        if (statusEl) {
            statusEl.textContent = msg;
            statusEl.style.display = 'block';
        }
    }

    function hideStatusMessage() {
        if (!subtitleContainer) return;
        const statusEl = subtitleContainer.querySelector('.zhiyi-subtitle-status');
        if (statusEl) {
            statusEl.style.display = 'none';
        }
    }

    function stopSubtitle() {
        isSubtitleActive = false;

        stopPruneTimer();
        subtitleLines = [];
        lineIdCounter = 0;

        removeSubtitleContainer();

        // 通知 service worker 停止音频捕获
        chrome.runtime.sendMessage({ type: 'STOP_TAB_CAPTURE' }).catch(() => { });
    }

    function removeSubtitleContainer() {
        const existing = document.getElementById('zhiyi-subtitle-container');
        if (existing) {
            existing.remove();
        }
        subtitleContainer = null;
    }
})();
