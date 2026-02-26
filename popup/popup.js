/**
 * Popup 交互逻辑
 * 三功能面板：网页翻译 / 字幕翻译 / 语音字幕
 */

document.addEventListener('DOMContentLoaded', async () => {
    // DOM 元素
    const translateBtn = document.getElementById('translateBtn');
    const captionBtn = document.getElementById('captionBtn');
    const subtitleBtn = document.getElementById('subtitleBtn');
    const translateStatus = document.getElementById('translateStatus');
    const captionStatus = document.getElementById('captionStatus');
    const subtitleStatus = document.getElementById('subtitleStatus');
    const settingsBtn = document.getElementById('settingsBtn');
    const goSettingsBtn = document.getElementById('goSettingsBtn');
    const apiKeyWarning = document.getElementById('apiKeyWarning');
    const apiStatusDot = document.getElementById('apiStatusDot');
    const apiStatusText = document.getElementById('apiStatusText');
    const apiPingBtn = document.getElementById('apiPingBtn');

    // 检查 API Key
    const hasKey = await checkApiKey();

    // 自动测试 API 连接（只在有 Key 时）
    if (hasKey) {
        runApiPing();
    }

    // 手动测试按钮
    apiPingBtn.addEventListener('click', () => runApiPing());

    // 获取当前页面状态
    await updatePageStatus();

    // ====== 1. 网页翻译 ======

    translateBtn.addEventListener('click', async () => {
        translateBtn.disabled = true;
        const btnText = translateBtn.querySelector('.btn-text');
        const btnLoader = translateBtn.querySelector('.btn-loader');

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) { showStatus(translateStatus, '未找到活动页面', 'error'); return; }

            btnLoader.style.display = 'block';

            const response = await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' });

            if (response.status === 'started') {
                btnText.textContent = '翻译中...';
                showStatus(translateStatus, `正在翻译 ${response.total || ''} 个文本...`, 'processing');
                listenForTranslateProgress();
            } else if (response.status === 'restored') {
                btnText.textContent = '翻译页面';
                translateBtn.classList.remove('active');
                showStatus(translateStatus, '已恢复原文', '');
                translateBtn.disabled = false;
                btnLoader.style.display = 'none';
            } else if (response.status === 'busy') {
                showStatus(translateStatus, response.message, 'processing');
                translateBtn.disabled = false;
                btnLoader.style.display = 'none';
            } else if (response.status === 'done') {
                showStatus(translateStatus, response.message, '');
                translateBtn.disabled = false;
                btnLoader.style.display = 'none';
            }
        } catch (err) {
            console.error('翻译错误:', err);
            showStatus(translateStatus, '请刷新页面后重试', 'error');
            translateBtn.disabled = false;
            btnLoader.style.display = 'none';
        }
    });

    // ====== 2. 字幕翻译 ======

    captionBtn.addEventListener('click', async () => {
        captionBtn.disabled = true;
        const btnText = captionBtn.querySelector('.btn-text');
        const btnLoader = captionBtn.querySelector('.btn-loader');

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) { showStatus(captionStatus, '未找到活动页面', 'error'); return; }

            btnLoader.style.display = 'block';

            const response = await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_CAPTION_TRANSLATE' });

            if (response.status === 'started') {
                btnText.textContent = '关闭字幕';
                captionBtn.classList.add('active');
                showStatus(captionStatus, `正在翻译 ${response.total || ''} 条字幕...`, 'processing');
                listenForCaptionProgress();
            } else if (response.status === 'stopped') {
                btnText.textContent = '翻译字幕';
                captionBtn.classList.remove('active');
                showStatus(captionStatus, '已关闭', '');
            } else if (response.status === 'error') {
                showStatus(captionStatus, response.message, 'error');
            }
        } catch (err) {
            console.error('字幕翻译错误:', err);
            showStatus(captionStatus, '请刷新页面后重试', 'error');
        }

        captionBtn.disabled = false;
        btnLoader.style.display = 'none';
    });

    // ====== 3. 语音字幕 ======

    subtitleBtn.addEventListener('click', async () => {
        subtitleBtn.disabled = true;
        const btnText = subtitleBtn.querySelector('.btn-text');
        const btnLoader = subtitleBtn.querySelector('.btn-loader');

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) { showStatus(subtitleStatus, '未找到活动页面', 'error'); return; }

            btnLoader.style.display = 'block';

            const response = await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SUBTITLE' });

            if (response.status === 'started') {
                btnText.textContent = '关闭识别';
                subtitleBtn.classList.add('active');
                showStatus(subtitleStatus, '语音识别中...', 'active');
            } else if (response.status === 'stopped') {
                btnText.textContent = '开启识别';
                subtitleBtn.classList.remove('active');
                showStatus(subtitleStatus, '已关闭', '');
            } else if (response.status === 'error') {
                showStatus(subtitleStatus, response.message, 'error');
            }
        } catch (err) {
            console.error('语音字幕错误:', err);
            showStatus(subtitleStatus, '请刷新页面后重试', 'error');
        }

        subtitleBtn.disabled = false;
        btnLoader.style.display = 'none';
    });

    // ====== 设置 ======

    settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
    goSettingsBtn?.addEventListener('click', () => chrome.runtime.openOptionsPage());

    // ====== 辅助函数 ======

    async function checkApiKey() {
        try {
            const response = await chrome.runtime.sendMessage({ type: 'CHECK_API_KEY' });
            if (!response.hasKey) {
                apiKeyWarning.style.display = 'flex';
                translateBtn.disabled = true;
                captionBtn.disabled = true;
                subtitleBtn.disabled = true;
                // 无 Key 时显示未配置状态
                apiStatusDot.className = 'status-dot error';
                apiStatusText.textContent = '未配置 API Key';
                apiStatusText.className = 'api-status-text error';
                return false;
            }
            return true;
        } catch {
            return false;
        }
    }

    async function updatePageStatus() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) return;

            // 网页翻译状态
            try {
                const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_STATUS' });
                if (res.isTranslated) {
                    translateBtn.querySelector('.btn-text').textContent = '恢复原文';
                    translateBtn.classList.add('active');
                    showStatus(translateStatus, '已翻译', 'active');
                }
                if (res.isTranslating) {
                    translateBtn.disabled = true;
                    showStatus(translateStatus, '正在翻译...', 'processing');
                }
            } catch { }

            // 字幕翻译状态
            try {
                const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CAPTION_STATUS' });
                if (res.isActive) {
                    captionBtn.querySelector('.btn-text').textContent = '关闭字幕';
                    captionBtn.classList.add('active');
                    if (res.progress.done < res.progress.total) {
                        const pct = Math.round((res.progress.done / res.progress.total) * 100);
                        showStatus(captionStatus, `翻译中 ${pct}%`, 'processing');
                    } else {
                        showStatus(captionStatus, '字幕翻译已完成', 'active');
                    }
                } else if (!res.hasVideo) {
                    showStatus(captionStatus, '未检测到视频', '');
                } else if (!res.hasCaptions) {
                    showStatus(captionStatus, '未检测到字幕轨道', '');
                }
            } catch { }

            // 语音字幕状态
            try {
                const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SUBTITLE_STATUS' });
                if (res.isActive) {
                    subtitleBtn.querySelector('.btn-text').textContent = '关闭识别';
                    subtitleBtn.classList.add('active');
                    showStatus(subtitleStatus, '语音识别中...', 'active');
                } else if (!res.hasVideo) {
                    showStatus(subtitleStatus, '未检测到视频', '');
                }
            } catch { }
        } catch { }
    }

    function showStatus(element, text, className) {
        element.textContent = text;
        element.className = 'status-text' + (className ? ' ' + className : '');
    }

    function listenForTranslateProgress() {
        const btnText = translateBtn.querySelector('.btn-text');
        const btnLoader = translateBtn.querySelector('.btn-loader');

        const listener = (message) => {
            if (message.type === 'TRANSLATE_PROGRESS') {
                const { translated, total, batchInfo } = message.data;
                const pct = Math.round((translated / total) * 100);
                const info = batchInfo ? ` · ${batchInfo}` : '';
                showStatus(translateStatus, `翻译进度: ${pct}%${info}`, 'processing');
            } else if (message.type === 'TRANSLATE_COMPLETE') {
                const { translated } = message.data;
                btnText.textContent = '恢复原文';
                btnLoader.style.display = 'none';
                translateBtn.classList.add('active');
                translateBtn.disabled = false;
                showStatus(translateStatus, `已翻译 ${translated} 个文本`, 'active');
                chrome.runtime.onMessage.removeListener(listener);
            } else if (message.type === 'TRANSLATE_ERROR') {
                const errMsg = message.data?.error || '翻译出错';
                showStatus(translateStatus, errMsg, 'error');
                // 不移除 listener，翻译仍在继续其他批次
            }
        };
        chrome.runtime.onMessage.addListener(listener);
    }

    /**
     * API 连接测试
     */
    async function runApiPing() {
        // 设置 UI 为测试中状态
        apiPingBtn.disabled = true;
        apiPingBtn.classList.add('spinning');
        apiStatusDot.className = 'status-dot testing';
        apiStatusText.textContent = '正在测试连接...';
        apiStatusText.className = 'api-status-text testing';

        try {
            const result = await chrome.runtime.sendMessage({ type: 'API_PING' });

            if (result.success) {
                apiStatusDot.className = 'status-dot success';
                apiStatusText.textContent = `连接正常 · 延迟 ${result.latency}ms`;
                apiStatusText.className = 'api-status-text success';
            } else {
                apiStatusDot.className = 'status-dot error';
                const errMsg = result.error || '连接失败';
                // 截断过长的错误信息
                const displayErr = errMsg.length > 40 ? errMsg.substring(0, 40) + '...' : errMsg;
                apiStatusText.textContent = `连接失败 · ${displayErr}`;
                apiStatusText.className = 'api-status-text error';
                apiStatusText.title = errMsg; // 完整错误信息悬浮显示
            }
        } catch (err) {
            apiStatusDot.className = 'status-dot error';
            apiStatusText.textContent = '测试失败: ' + (err.message || '未知错误');
            apiStatusText.className = 'api-status-text error';
        }

        apiPingBtn.disabled = false;
        apiPingBtn.classList.remove('spinning');
    }

    function listenForCaptionProgress() {
        const btnText = captionBtn.querySelector('.btn-text');
        const btnLoader = captionBtn.querySelector('.btn-loader');

        const listener = (message) => {
            if (message.type === 'CAPTION_TRANSLATE_PROGRESS') {
                const { done, total } = message.data;
                const pct = Math.round((done / total) * 100);
                showStatus(captionStatus, `字幕翻译中 ${pct}% (${done}/${total})`, 'processing');
            } else if (message.type === 'CAPTION_TRANSLATE_COMPLETE') {
                btnLoader.style.display = 'none';
                showStatus(captionStatus, '字幕翻译完成 ✓', 'active');
                chrome.runtime.onMessage.removeListener(listener);
            }
        };
        chrome.runtime.onMessage.addListener(listener);
    }
});
