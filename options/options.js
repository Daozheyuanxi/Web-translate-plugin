<<<<<<< HEAD
/**
 * 设置页面逻辑
 */

document.addEventListener('DOMContentLoaded', async () => {
    const apiKeyInput = document.getElementById('apiKey');
    const toggleBtn = document.getElementById('toggleVisibility');
    const saveBtn = document.getElementById('saveBtn');
    const saveStatus = document.getElementById('saveStatus');

    // 加载已保存的设置
    const saved = await chrome.storage.sync.get(['geminiApiKey']);
    if (saved.geminiApiKey) {
        apiKeyInput.value = saved.geminiApiKey;
    }

    // 显示/隐藏 API Key
    toggleBtn.addEventListener('click', () => {
        const isPassword = apiKeyInput.type === 'password';
        apiKeyInput.type = isPassword ? 'text' : 'password';
    });

    // 保存设置
    saveBtn.addEventListener('click', async () => {
        const apiKey = apiKeyInput.value.trim();

        if (!apiKey) {
            showSaveStatus('请输入 API Key', 'error');
            return;
        }

        // 验证 API Key 格式
        if (!apiKey.startsWith('AI') && apiKey.length < 20) {
            showSaveStatus('API Key 格式不正确', 'error');
            return;
        }

        try {
            saveBtn.disabled = true;
            saveBtn.textContent = '保存中...';

            await chrome.storage.sync.set({ geminiApiKey: apiKey });

            showSaveStatus('✓ 已保存', 'success');
        } catch (error) {
            showSaveStatus('保存失败: ' + error.message, 'error');
        }

        saveBtn.disabled = false;
        saveBtn.textContent = '保存设置';
    });

    // 支持 Enter 键保存
    apiKeyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            saveBtn.click();
        }
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
=======
/**
 * 设置页面逻辑
 */

document.addEventListener('DOMContentLoaded', async () => {
    const apiKeyInput = document.getElementById('apiKey');
    const toggleBtn = document.getElementById('toggleVisibility');
    const saveBtn = document.getElementById('saveBtn');
    const saveStatus = document.getElementById('saveStatus');

    // 加载已保存的设置
    const saved = await chrome.storage.sync.get(['geminiApiKey']);
    if (saved.geminiApiKey) {
        apiKeyInput.value = saved.geminiApiKey;
    }

    // 显示/隐藏 API Key
    toggleBtn.addEventListener('click', () => {
        const isPassword = apiKeyInput.type === 'password';
        apiKeyInput.type = isPassword ? 'text' : 'password';
    });

    // 保存设置
    saveBtn.addEventListener('click', async () => {
        const apiKey = apiKeyInput.value.trim();

        if (!apiKey) {
            showSaveStatus('请输入 API Key', 'error');
            return;
        }

        // 验证 API Key 格式
        if (!apiKey.startsWith('AI') && apiKey.length < 20) {
            showSaveStatus('API Key 格式不正确', 'error');
            return;
        }

        try {
            saveBtn.disabled = true;
            saveBtn.textContent = '保存中...';

            await chrome.storage.sync.set({ geminiApiKey: apiKey });

            showSaveStatus('✓ 已保存', 'success');
        } catch (error) {
            showSaveStatus('保存失败: ' + error.message, 'error');
        }

        saveBtn.disabled = false;
        saveBtn.textContent = '保存设置';
    });

    // 支持 Enter 键保存
    apiKeyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            saveBtn.click();
        }
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
>>>>>>> c14eadc151a0cfc871e90e8c7436b7bc1c7b7a50
