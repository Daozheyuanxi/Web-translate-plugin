/**
 * Popup 交互逻辑
 */

document.addEventListener('DOMContentLoaded', async () => {
    // DOM 元素
    const translateBtn = document.getElementById('translateBtn');
    const subtitleBtn = document.getElementById('subtitleBtn');
    const translateStatus = document.getElementById('translateStatus');
    const subtitleStatus = document.getElementById('subtitleStatus');
    const settingsBtn = document.getElementById('settingsBtn');
    const goSettingsBtn = document.getElementById('goSettingsBtn');
    const apiKeyWarning = document.getElementById('apiKeyWarning');

    // 检查 API Key
    await checkApiKey();

    // 获取当前页面状态
    await updatePageStatus();

    // --- 事件绑定 ---

    // 翻译按钮
    translateBtn.addEventListener('click', async () => {
        translateBtn.disabled = true;
        const btnText = translateBtn.querySelector('.btn-text');
        const btnLoader = translateBtn.querySelector('.btn-loader');

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            if (!tab) {
                showStatus(translateStatus, '未找到活动页面', 'error');
                return;
            }

            btnLoader.style.display = 'block';

            const response = await chrome.tabs.sendMessage(tab.id, {
                type: 'TOGGLE_TRANSLATE'
            });

            if (response.status === 'started') {
                btnText.textContent = '翻译中...';
                showStatus(translateStatus, `正在翻译 ${response.total || ''} 个文本...`, 'processing');

                // 监听翻译完成
                listenForProgress();
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

    // 字幕按钮
    subtitleBtn.addEventListener('click', async () => {
        subtitleBtn.disabled = true;
        const btnText = subtitleBtn.querySelector('.btn-text');
        const btnLoader = subtitleBtn.querySelector('.btn-loader');

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            if (!tab) {
                showStatus(subtitleStatus, '未找到活动页面', 'error');
                return;
            }

            btnLoader.style.display = 'block';

            const response = await chrome.tabs.sendMessage(tab.id, {
                type: 'TOGGLE_SUBTITLE'
            });

            if (response.status === 'started') {
                btnText.textContent = '关闭字幕';
                subtitleBtn.classList.add('active');
                showStatus(subtitleStatus, '语音识别中...', 'active');
            } else if (response.status === 'stopped') {
                btnText.textContent = '开启字幕';
                subtitleBtn.classList.remove('active');
                showStatus(subtitleStatus, '已关闭', '');
            } else if (response.status === 'error') {
                showStatus(subtitleStatus, response.message, 'error');
            }
        } catch (err) {
            console.error('字幕错误:', err);
            showStatus(subtitleStatus, '请刷新页面后重试', 'error');
        }

        subtitleBtn.disabled = false;
        btnLoader.style.display = 'none';
    });

    // 设置按钮
    settingsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    goSettingsBtn?.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // --- 辅助函数 ---

    async function checkApiKey() {
        try {
            const response = await chrome.runtime.sendMessage({ type: 'CHECK_API_KEY' });
            if (!response.hasKey) {
                apiKeyWarning.style.display = 'flex';
                translateBtn.disabled = true;
                subtitleBtn.disabled = true;
            }
        } catch {
            // 忽略
        }
    }

    async function updatePageStatus() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) return;

            // 获取翻译状态
            try {
                const translateRes = await chrome.tabs.sendMessage(tab.id, {
                    type: 'GET_PAGE_STATUS'
                });
                if (translateRes.isTranslated) {
                    translateBtn.querySelector('.btn-text').textContent = '恢复原文';
                    translateBtn.classList.add('active');
                    showStatus(translateStatus, '已翻译', 'active');
                }
                if (translateRes.isTranslating) {
                    translateBtn.disabled = true;
                    showStatus(translateStatus, '正在翻译...', 'processing');
                }
            } catch { }

            // 获取字幕状态
            try {
                const subtitleRes = await chrome.tabs.sendMessage(tab.id, {
                    type: 'GET_SUBTITLE_STATUS'
                });
                if (subtitleRes.isActive) {
                    subtitleBtn.querySelector('.btn-text').textContent = '关闭字幕';
                    subtitleBtn.classList.add('active');
                    showStatus(subtitleStatus, '语音识别中...', 'active');
                }
                if (!subtitleRes.hasVideo) {
                    showStatus(subtitleStatus, '当前页面未检测到视频', '');
                }
            } catch { }
        } catch { }
    }

    function showStatus(element, text, className) {
        element.textContent = text;
        element.className = 'status-text' + (className ? ' ' + className : '');
    }

    function listenForProgress() {
        const btnText = translateBtn.querySelector('.btn-text');
        const btnLoader = translateBtn.querySelector('.btn-loader');

        const listener = (message) => {
            if (message.type === 'TRANSLATE_PROGRESS') {
                const { translated, total } = message.data;
                const pct = Math.round((translated / total) * 100);
                showStatus(translateStatus, `翻译进度: ${pct}% (${translated}/${total})`, 'processing');
            } else if (message.type === 'TRANSLATE_COMPLETE') {
                const { total, translated } = message.data;
                btnText.textContent = '恢复原文';
                btnLoader.style.display = 'none';
                translateBtn.classList.add('active');
                translateBtn.disabled = false;
                showStatus(translateStatus, `已翻译 ${translated} 个文本`, 'active');
                chrome.runtime.onMessage.removeListener(listener);
            }
        };

        chrome.runtime.onMessage.addListener(listener);
    }
});
