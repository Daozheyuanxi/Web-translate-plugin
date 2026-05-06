/**
 * 设置页面逻辑
 */

document.addEventListener('DOMContentLoaded', async () => {
    const apiKeyInput = document.getElementById('apiKey');
    const groqKeyInput = document.getElementById('groqKey');
    const toggleBtn = document.getElementById('toggleVisibility');
    const toggleGroqBtn = document.getElementById('toggleGroqVisibility');
    const saveBtn = document.getElementById('saveBtn');
    const saveStatus = document.getElementById('saveStatus');

    // 加载已保存的设置
    const saved = await chrome.storage.sync.get(['geminiApiKey', 'groqApiKey']);
    if (saved.geminiApiKey) {
        apiKeyInput.value = saved.geminiApiKey;
    }
    if (saved.groqApiKey) {
        groqKeyInput.value = saved.groqApiKey;
    }

    // 显示/隐藏 API Key
    toggleBtn.addEventListener('click', () => {
        const isPassword = apiKeyInput.type === 'password';
        apiKeyInput.type = isPassword ? 'text' : 'password';
    });

    toggleGroqBtn.addEventListener('click', () => {
        const isPassword = groqKeyInput.type === 'password';
        groqKeyInput.type = isPassword ? 'text' : 'password';
    });

    // 保存设置
    saveBtn.addEventListener('click', async () => {
        const apiKey = apiKeyInput.value.trim();
        const groqKey = groqKeyInput.value.trim();

        if (!apiKey) {
            showSaveStatus('请输入 Gemini API Key', 'error');
            return;
        }

        // 验证 Gemini API Key 格式
        if (!apiKey.startsWith('AI') && apiKey.length < 20) {
            showSaveStatus('Gemini API Key 格式不正确', 'error');
            return;
        }

        try {
            saveBtn.disabled = true;
            saveBtn.textContent = '保存中...';

            const settings = { geminiApiKey: apiKey };
            if (groqKey) {
                settings.groqApiKey = groqKey;
            }

            await chrome.storage.sync.set(settings);

            const msg = groqKey ? '✓ 已保存（Gemini + Groq）' : '✓ 已保存（Gemini）';
            showSaveStatus(msg, 'success');
        } catch (error) {
            showSaveStatus('保存失败: ' + error.message, 'error');
        }

        saveBtn.disabled = false;
        saveBtn.textContent = '保存设置';
    });

    // 支持 Enter 键保存
    apiKeyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveBtn.click();
    });
    groqKeyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveBtn.click();
    });

    function showSaveStatus(text, type) {
        saveStatus.textContent = text;
        saveStatus.className = 'save-status ' + type;

        setTimeout(() => {
            saveStatus.textContent = '';
            saveStatus.className = 'save-status';
        }, 3000);
    }
});
