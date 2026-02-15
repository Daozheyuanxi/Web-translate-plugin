/**
 * 网页翻译 Content Script
 * 遍历 DOM 收集文本，批量翻译并原地替换
 */

(function () {
    'use strict';

    // 状态管理
    let isTranslated = false;
    let isTranslating = false;
    const originalTexts = new Map(); // 存储原始文本用于恢复

    // 不翻译的标签
    const SKIP_TAGS = new Set([
        'SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'INPUT',
        'SELECT', 'OPTION', 'SVG', 'MATH', 'NOSCRIPT', 'IFRAME',
        'CANVAS', 'VIDEO', 'AUDIO', 'IMG', 'BR', 'HR'
    ]);

    // 不翻译的属性
    const SKIP_CLASSES = ['notranslate', 'zhiyi-translated', 'zhiyi-subtitle'];

    // 批量大小
    const BATCH_SIZE = 25;

    /**
     * 监听来自 Popup 的消息
     */
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message.type) {
            case 'TOGGLE_TRANSLATE':
                if (isTranslating) {
                    sendResponse({ status: 'busy', message: '正在翻译中...' });
                    return;
                }
                if (isTranslated) {
                    restoreOriginal();
                    sendResponse({ status: 'restored' });
                } else {
                    translatePage(sendResponse);
                    return true; // 异步响应
                }
                break;

            case 'GET_PAGE_STATUS':
                sendResponse({
                    isTranslated,
                    isTranslating
                });
                break;
        }
    });

    /**
     * 收集页面中所有需要翻译的文本节点
     */
    function collectTextNodes() {
        const textNodes = [];
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function (node) {
                    // 跳过空白节点
                    if (!node.textContent.trim()) {
                        return NodeFilter.FILTER_REJECT;
                    }

                    // 跳过已翻译的节点
                    if (node.parentElement?.classList?.contains('zhiyi-translated')) {
                        return NodeFilter.FILTER_REJECT;
                    }

                    // 跳过特殊标签
                    let parent = node.parentElement;
                    while (parent) {
                        if (SKIP_TAGS.has(parent.tagName)) {
                            return NodeFilter.FILTER_REJECT;
                        }
                        if (SKIP_CLASSES.some(cls => parent.classList?.contains(cls))) {
                            return NodeFilter.FILTER_REJECT;
                        }
                        parent = parent.parentElement;
                    }

                    // 只翻译包含英文字符的文本
                    if (/[a-zA-Z]/.test(node.textContent)) {
                        return NodeFilter.FILTER_ACCEPT;
                    }

                    return NodeFilter.FILTER_REJECT;
                }
            }
        );

        let node;
        while (node = walker.nextNode()) {
            textNodes.push(node);
        }

        return textNodes;
    }

    /**
     * 翻译整个页面
     */
    async function translatePage(sendResponse) {
        isTranslating = true;

        try {
            const textNodes = collectTextNodes();

            if (textNodes.length === 0) {
                isTranslating = false;
                sendResponse?.({ status: 'done', message: '没有找到需要翻译的内容' });
                return;
            }

            // 发送总数信息
            sendResponse?.({ status: 'started', total: textNodes.length });

            // 分批翻译
            let translated = 0;
            for (let i = 0; i < textNodes.length; i += BATCH_SIZE) {
                const batch = textNodes.slice(i, i + BATCH_SIZE);
                const texts = batch.map(node => node.textContent.trim());

                try {
                    const response = await chrome.runtime.sendMessage({
                        type: 'TRANSLATE_BATCH',
                        data: {
                            texts,
                            batchId: Math.floor(i / BATCH_SIZE)
                        }
                    });

                    if (response.error) {
                        console.error('翻译出错:', response.error);
                        continue;
                    }

                    // 替换文本
                    const { translations } = response;
                    for (let j = 0; j < batch.length; j++) {
                        if (translations[j] && translations[j] !== texts[j]) {
                            // 保存原始文本
                            originalTexts.set(batch[j], batch[j].textContent);
                            // 替换文本
                            batch[j].textContent = translations[j];
                            // 标记为已翻译
                            batch[j].parentElement?.classList.add('zhiyi-translated');
                        }
                    }

                    translated += batch.length;

                    // 发送进度更新
                    chrome.runtime.sendMessage({
                        type: 'TRANSLATE_PROGRESS',
                        data: { translated, total: textNodes.length }
                    }).catch(() => { });
                } catch (err) {
                    console.error('批次翻译失败:', err);
                }
            }

            isTranslated = true;
            isTranslating = false;

            // 通知完成
            chrome.runtime.sendMessage({
                type: 'TRANSLATE_COMPLETE',
                data: { total: textNodes.length, translated }
            }).catch(() => { });

        } catch (error) {
            isTranslating = false;
            console.error('页面翻译出错:', error);
        }
    }

    /**
     * 恢复原文
     */
    function restoreOriginal() {
        for (const [node, originalText] of originalTexts) {
            try {
                node.textContent = originalText;
                node.parentElement?.classList.remove('zhiyi-translated');
            } catch (e) {
                // 节点可能已被移除
            }
        }

        originalTexts.clear();
        isTranslated = false;
    }
})();
