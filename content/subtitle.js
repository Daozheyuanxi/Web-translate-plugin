/**
 * 视频字幕 Content Script
 * 检测页面视频，通过语音识别添加中英双语字幕
 */

(function () {
    'use strict';

    let isSubtitleActive = false;
    let recognition = null;
    let subtitleContainer = null;
    let currentVideo = null;
    let mediaStream = null;

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
        // 优先查找正在播放的视频
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
            if (!video.paused && video.readyState >= 2) {
                return video;
            }
        }
        // 返回第一个视频
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

        try {
            // 创建字幕容器
            createSubtitleContainer();

            // 请求 tabCapture
            const response = await chrome.runtime.sendMessage({
                type: 'START_TAB_CAPTURE'
            });

            if (!response.success) {
                throw new Error(response.error || '无法捕获音频');
            }

            // 使用 Web Speech API 进行语音识别
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
        // streamId 可用于后续音频处理
        if (data.streamId) {
            console.log('TabCapture stream ready:', data.streamId);
        }
    }

    /**
     * 初始化 Web Speech API 语音识别
     */
    let lastTranslation = '';   // 保持在外层，跨事件保留
    let translateTimer = null;  // 防抖定时器
    let translateAbort = null;  // 用于取消过时的翻译

    /**
     * 发起翻译请求（独立于事件回调，避免 async 竞态）
     */
    function requestTranslation(englishText) {
        // 清除之前的防抖定时器
        if (translateTimer) {
            clearTimeout(translateTimer);
        }

        // 先立即显示英文，中文保留上一次的
        updateSubtitle(englishText, lastTranslation, false);

        // 防抖 200ms，避免短时间内重复发送翻译请求
        translateTimer = setTimeout(() => {
            // 生成一个本次翻译的标记
            const currentRequest = Symbol();
            translateAbort = currentRequest;

            chrome.runtime.sendMessage({
                type: 'TRANSLATE_SINGLE',
                data: { text: englishText }
            }).then((response) => {
                // 如果已经有更新的翻译请求，忽略这个过时的结果
                if (translateAbort !== currentRequest) return;

                if (response && response.translation) {
                    lastTranslation = response.translation;
                    updateSubtitle(englishText, lastTranslation, false);
                } else if (response && response.error) {
                    console.error('字幕翻译失败:', response.error);
                    // 即使翻译失败，也显示英文
                    updateSubtitle(englishText, lastTranslation || '翻译中...', false);
                }
            }).catch((err) => {
                if (translateAbort !== currentRequest) return;
                console.error('字幕翻译请求失败:', err);
            });
        }, 200);
    }

    function startSpeechRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SpeechRecognition) {
            updateSubtitle('⚠️ 您的浏览器不支持语音识别', '');
            return;
        }

        recognition = new SpeechRecognition();
        recognition.lang = 'en-US';
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;

        // 重置翻译状态
        lastTranslation = '';
        translateTimer = null;
        translateAbort = null;

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
                // 最终结果：立即显示英文，并发起翻译
                requestTranslation(finalText);
            } else if (interimTranscript) {
                // 临时结果：显示英文（半透明），保留上一次的中文
                updateSubtitle(interimTranscript, lastTranslation, true);
            }
        };

        recognition.onerror = (event) => {
            console.error('语音识别错误:', event.error);
            if (event.error === 'not-allowed') {
                updateSubtitle('⚠️ 需要麦克风权限', '请在浏览器设置中允许麦克风访问');
            } else if (event.error !== 'aborted') {
                // 非手动停止的错误，尝试重启
                setTimeout(() => {
                    if (isSubtitleActive && recognition) {
                        try {
                            recognition.start();
                        } catch (e) { }
                    }
                }, 1000);
            }
        };

        recognition.onend = () => {
            // 如果字幕仍在激活状态，自动重启识别
            if (isSubtitleActive) {
                setTimeout(() => {
                    try {
                        recognition?.start();
                    } catch (e) { }
                }, 300);
            }
        };

        try {
            recognition.start();
        } catch (e) {
            console.error('启动语音识别失败:', e);
        }
    }

    /**
     * 创建字幕容器
     */
    function createSubtitleContainer() {
        // 移除已有的字幕容器
        removeSubtitleContainer();

        subtitleContainer = document.createElement('div');
        subtitleContainer.id = 'zhiyi-subtitle-container';
        subtitleContainer.className = 'zhiyi-subtitle';

        subtitleContainer.innerHTML = `
      <div class="zhiyi-subtitle-inner">
        <div class="zhiyi-subtitle-en"></div>
        <div class="zhiyi-subtitle-zh"></div>
      </div>
    `;

        // 将字幕容器插入到视频元素附近
        if (currentVideo) {
            const videoParent = currentVideo.parentElement;
            // 设置父容器的定位
            const computedStyle = window.getComputedStyle(videoParent);
            if (computedStyle.position === 'static') {
                videoParent.style.position = 'relative';
            }
            videoParent.appendChild(subtitleContainer);
        } else {
            document.body.appendChild(subtitleContainer);
        }
    }

    /**
     * 更新字幕内容
     */
    function updateSubtitle(enText, zhText, isInterim = false) {
        if (!subtitleContainer) return;

        const enEl = subtitleContainer.querySelector('.zhiyi-subtitle-en');
        const zhEl = subtitleContainer.querySelector('.zhiyi-subtitle-zh');

        if (enEl) {
            enEl.textContent = enText;
            enEl.style.opacity = isInterim ? '0.7' : '1';
        }

        if (zhEl && zhText) {
            zhEl.textContent = zhText;
        }
    }

    /**
     * 停止字幕
     */
    function stopSubtitle() {
        isSubtitleActive = false;

        // 清理翻译状态
        if (translateTimer) {
            clearTimeout(translateTimer);
            translateTimer = null;
        }
        translateAbort = null;
        lastTranslation = '';

        if (recognition) {
            recognition.abort();
            recognition = null;
        }

        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }

        removeSubtitleContainer();

        // 通知 background 停止捕获
        chrome.runtime.sendMessage({ type: 'STOP_TAB_CAPTURE' }).catch(() => { });
    }

    /**
     * 移除字幕容器
     */
    function removeSubtitleContainer() {
        const existing = document.getElementById('zhiyi-subtitle-container');
        if (existing) {
            existing.remove();
        }
        subtitleContainer = null;
    }
})();
