/**
 * 视频字幕 Content Script
 * 检测页面视频，通过语音识别添加中英双语字幕
 * 支持并行翻译 + 滚动字幕显示
 */

(function () {
    'use strict';

    let isSubtitleActive = false;
    let recognition = null;
    let subtitleContainer = null;
    let currentVideo = null;
    let mediaStream = null;

    // ====== 字幕行队列 ======
    const MAX_VISIBLE_LINES = 3;   // 最多显示的字幕行数
    const LINE_EXPIRE_MS = 8000;   // 字幕行过期时间（ms）
    let subtitleLines = [];         // {id, en, zh, element, timestamp}
    let lineIdCounter = 0;

    /**
     * 监听来自 Popup 的消息
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

            case 'TAB_CAPTURE_STREAM':
                handleCaptureStream(message.data);
                sendResponse({ success: true });
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
     * 开始字幕识别
     */
    async function startSubtitle(sendResponse) {
        currentVideo = findVideo();

        if (!currentVideo) {
            sendResponse({ status: 'error', message: '未找到视频元素' });
            return;
        }

        // YouTube 提示：语音识别使用系统麦克风，无法直接捕获标签页音频
        // 建议用户使用「字幕翻译」功能
        const isYouTube = location.hostname === 'www.youtube.com' || location.hostname === 'youtube.com';
        if (isYouTube) {
            sendResponse({
                status: 'error',
                message: '语音识别依赖麦克风输入，无法直接识别视频音频。YouTube 视频请使用「字幕翻译」功能'
            });
            return;
        }

        try {
            createSubtitleContainer();

            const response = await chrome.runtime.sendMessage({
                type: 'START_TAB_CAPTURE'
            });

            if (!response.success) {
                throw new Error(response.error || '无法捕获音频');
            }

            startSpeechRecognition();
            isSubtitleActive = true;
            sendResponse({ status: 'started' });
        } catch (error) {
            console.error('启动字幕失败:', error);
            sendResponse({ status: 'error', message: error.message });
        }
    }

    /**
     * 处理来自 tabCapture 的音频流
     */
    function handleCaptureStream(data) {
        if (data.streamId) {
            console.log('TabCapture stream ready:', data.streamId);
        }
    }

    // ==========================================================
    //  并行翻译 + 滚动字幕核心逻辑
    // ==========================================================

    /**
     * 添加一行字幕（并行发起翻译）
     */
    function addSubtitleLine(englishText) {
        const lineId = ++lineIdCounter;

        // 创建字幕行数据
        const line = {
            id: lineId,
            en: englishText,
            zh: '',
            timestamp: Date.now(),
            element: null
        };

        subtitleLines.push(line);

        // 清理过期行
        pruneExpiredLines();

        // 渲染所有字幕行
        renderSubtitleLines();

        // 🔥 并行发起翻译（不等待、不阻塞其他行）
        chrome.runtime.sendMessage({
            type: 'TRANSLATE_SINGLE',
            data: { text: englishText }
        }).then((response) => {
            // 找到这行并更新中文（可能此时行已被pruned，无所谓）
            if (response && response.translation) {
                line.zh = response.translation;
                // 只更新这一行的中文，避免全量重绘
                updateLineZh(line);
            }
        }).catch((err) => {
            console.error(`字幕翻译失败 [${lineId}]:`, err);
        });
    }

    /**
     * 更新临时识别文本（显示在最底部，半透明）
     */
    function updateInterimText(text) {
        if (!subtitleContainer) return;

        let interimEl = subtitleContainer.querySelector('.zhiyi-subtitle-interim');
        if (!interimEl) {
            interimEl = document.createElement('div');
            interimEl.className = 'zhiyi-subtitle-interim';
            subtitleContainer.querySelector('.zhiyi-subtitle-inner').appendChild(interimEl);
        }

        interimEl.textContent = text;
        interimEl.style.display = text ? 'block' : 'none';
    }

    /**
     * 清除临时文本
     */
    function clearInterimText() {
        if (!subtitleContainer) return;
        const interimEl = subtitleContainer.querySelector('.zhiyi-subtitle-interim');
        if (interimEl) {
            interimEl.style.display = 'none';
            interimEl.textContent = '';
        }
    }

    /**
     * 清理过期的字幕行
     */
    function pruneExpiredLines() {
        const now = Date.now();
        // 保留最近的行和未过期的行，但最多保留 MAX_VISIBLE_LINES
        subtitleLines = subtitleLines.filter(
            line => (now - line.timestamp) < LINE_EXPIRE_MS
        );

        // 如果仍然超出最大行数，移除最旧的
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

        // 移除旧的字幕行元素（保留 interim 元素）
        const oldLines = inner.querySelectorAll('.zhiyi-subtitle-line');
        oldLines.forEach(el => el.remove());

        // 获取 interim 元素的引用（如果存在）
        const interimEl = inner.querySelector('.zhiyi-subtitle-interim');

        // 渲染每一行
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
            // 翻译中占位：如果中文还没到，显示淡色加载指示
            if (!line.zh) {
                zhEl.textContent = '翻译中...';
                zhEl.classList.add('zhiyi-translating');
            }

            lineEl.appendChild(enEl);
            lineEl.appendChild(zhEl);

            // 存储元素引用
            line.element = lineEl;

            // 插入到 interim 之前（如果 interim 存在）
            if (interimEl) {
                inner.insertBefore(lineEl, interimEl);
            } else {
                inner.appendChild(lineEl);
            }
        }
    }

    /**
     * 只更新某一行的中文翻译（高效局部更新）
     */
    function updateLineZh(line) {
        if (!line.element) return;

        const zhEl = line.element.querySelector('.zhiyi-subtitle-zh');
        if (zhEl) {
            zhEl.textContent = line.zh;
            zhEl.classList.remove('zhiyi-translating');
            // 添加出现动画
            zhEl.classList.add('zhiyi-zh-ready');
        }
    }

    // ==========================================================
    //  语音识别
    // ==========================================================

    function startSpeechRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            addSubtitleLine('⚠️ 您的浏览器不支持语音识别');
            return;
        }

        recognition = new SpeechRecognition();
        recognition.lang = 'en-US';
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;

        // 重置状态
        subtitleLines = [];
        lineIdCounter = 0;

        recognition.onresult = (event) => {
            let interimTranscript = '';
            let finalText = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;

                if (event.results[i].isFinal) {
                    finalText = transcript;
                } else {
                    interimTranscript += transcript;
                }
            }

            if (finalText) {
                // ✅ 最终结果：立即添加字幕行 + 并行翻译
                clearInterimText();
                addSubtitleLine(finalText);
            } else if (interimTranscript) {
                // 临时结果：显示在底部 interim 区域
                updateInterimText(interimTranscript);
            }
        };

        recognition.onerror = (event) => {
            console.error('语音识别错误:', event.error);
            if (event.error === 'not-allowed') {
                addSubtitleLine('⚠️ 需要麦克风权限');
            } else if (event.error !== 'aborted') {
                setTimeout(() => {
                    if (isSubtitleActive && recognition) {
                        try { recognition.start(); } catch (e) { }
                    }
                }, 1000);
            }
        };

        recognition.onend = () => {
            if (isSubtitleActive) {
                setTimeout(() => {
                    try { recognition?.start(); } catch (e) { }
                }, 300);
            }
        };

        try {
            recognition.start();
        } catch (e) {
            console.error('启动语音识别失败:', e);
        }

        // 定期清理过期字幕行
        startPruneTimer();
    }

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
      <div class="zhiyi-subtitle-inner"></div>
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

    function stopSubtitle() {
        isSubtitleActive = false;

        stopPruneTimer();
        subtitleLines = [];
        lineIdCounter = 0;

        if (recognition) {
            recognition.abort();
            recognition = null;
        }

        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }

        removeSubtitleContainer();

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
