<<<<<<< HEAD
/**
 * 网页翻译 Content Script
 * 遍历 DOM 收集文本，并发批量翻译并原地替换
 * 支持滚动时自动翻译新出现的内容（渐进式翻译）
 */

(function () {
    'use strict';

    // 状态管理
    let isTranslated = false;
    let isTranslating = false;
    const originalTexts = new Map(); // 存储原始文本用于恢复
    const translatedNodes = new WeakSet(); // 已翻译或已入队的节点

    // 渐进式翻译的观察器
    let scrollObserver = null;       // IntersectionObserver
    let mutationObserver = null;     // MutationObserver
    let pendingNodes = [];           // 滚动/变更后待翻译的节点
    let translateTimer = null;       // 防抖定时器

    // 不翻译的标签
    const SKIP_TAGS = new Set([
        'SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'INPUT',
        'SELECT', 'OPTION', 'SVG', 'MATH', 'NOSCRIPT', 'IFRAME',
        'CANVAS', 'VIDEO', 'AUDIO', 'IMG', 'BR', 'HR', 'KBD', 'SAMP'
    ]);

    // 不翻译的属性
    const SKIP_CLASSES = ['notranslate', 'zhiyi-translated', 'zhiyi-subtitle'];

    // 配置
    const MEGA_BATCH_CHARS = 15000;  // 单次请求最大字符数（~5000token输入）
    const MAX_ITEMS_PER_BATCH = 120; // 单次请求最大条目数
    const MIN_TEXT_LENGTH = 2;
    const MAX_TEXT_LENGTH = 2000;
    const SCROLL_DEBOUNCE_MS = 300;

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

    // ====== 文本节点检查 ======

    /**
     * 检查一个元素是否应该被跳过
     */
    function shouldSkipElement(el) {
        while (el) {
            if (SKIP_TAGS.has(el.tagName)) return true;
            if (el.classList && SKIP_CLASSES.some(cls => el.classList.contains(cls))) return true;
            if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) return true;
            el = el.parentElement;
        }
        return false;
    }

    /**
     * 检查文本节点是否需要翻译
     */
    function isTranslatableTextNode(node) {
        if (node.nodeType !== Node.TEXT_NODE) return false;
        const text = node.textContent.trim();
        if (!text || text.length < MIN_TEXT_LENGTH) return false;
        if (!/[a-zA-Z]/.test(text)) return false;
        if (!node.parentElement) return false;
        if (translatedNodes.has(node)) return false;
        if (shouldSkipElement(node.parentElement)) return false;
        return true;
    }

    // ====== 收集文本节点 ======

    /**
     * 从指定根元素中收集需要翻译的文本节点
     */
    function collectTextNodesFrom(root) {
        const textNodes = [];
        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function (node) {
                    return isTranslatableTextNode(node)
                        ? NodeFilter.FILTER_ACCEPT
                        : NodeFilter.FILTER_REJECT;
                }
            }
        );

        let node;
        while (node = walker.nextNode()) {
            textNodes.push(node);
        }
        return textNodes;
    }

    // ====== 批量翻译核心 ======

    /**
     * 智能分批：按字符总量 + 条目数上限来切分
     * 目标：尽可能少的 API 请求
     */
    function smartBatch(textNodes) {
        const batches = [];
        let currentBatch = [];
        let currentChars = 0;

        for (const node of textNodes) {
            const t = node.textContent.trim();
            const text = t.length > MAX_TEXT_LENGTH ? t.substring(0, MAX_TEXT_LENGTH) : t;
            const charLen = text.length;

            // 如果当前批次加上这条会超限，先提交当前批次
            if (currentBatch.length > 0 &&
                (currentChars + charLen > MEGA_BATCH_CHARS || currentBatch.length >= MAX_ITEMS_PER_BATCH)) {
                batches.push([...currentBatch]);
                currentBatch = [];
                currentChars = 0;
            }

            currentBatch.push({ node, text });
            currentChars += charLen;
        }

        if (currentBatch.length > 0) {
            batches.push(currentBatch);
        }

        return batches;
    }

    /**
     * 翻译一组文本节点（串行大批量，最小化 API 请求数）
     */
    async function translateNodes(textNodes) {
        if (textNodes.length === 0) return { translated: 0, failed: 0 };

        // 标记为已入队
        textNodes.forEach(n => translatedNodes.add(n));

        // 智能分批
        const batches = smartBatch(textNodes);
        console.log(`[zhiyi] 共 ${textNodes.length} 条文本，分成 ${batches.length} 个请求`);

        let translated = 0;
        let failed = 0;

        // 串行执行每个批次（避免触发频率限制）
        for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
            const batch = batches[batchIdx];
            const texts = batch.map(item => item.text);

            // 通知进度
            chrome.runtime.sendMessage({
                type: 'TRANSLATE_PROGRESS',
                data: {
                    translated: translated + failed,
                    total: textNodes.length,
                    batchInfo: `请求 ${batchIdx + 1}/${batches.length}（${texts.length} 条）`
                }
            }).catch(() => { });

            try {
                const response = await chrome.runtime.sendMessage({
                    type: 'TRANSLATE_BATCH',
                    data: { texts, batchId: batchIdx }
                });

                if (response.error || !response.translations) {
                    console.error('[zhiyi] 翻译出错:', response.error);
                    failed += texts.length;
                    chrome.runtime.sendMessage({
                        type: 'TRANSLATE_ERROR',
                        data: { error: response.error || '翻译返回结果异常' }
                    }).catch(() => { });
                    continue;
                }

                const { translations } = response;
                for (let j = 0; j < batch.length; j++) {
                    const { node } = batch[j];
                    const translation = translations[j];

                    try {
                        if (translation && translation !== texts[j] && node.parentElement) {
                            originalTexts.set(node, node.textContent);
                            node.textContent = translation;
                            node.parentElement.classList.add('zhiyi-translated');
                            translated++;
                        } else {
                            translated++;
                        }
                    } catch (e) {
                        translated++;
                    }
                }
            } catch (err) {
                console.error('[zhiyi] 批次翻译失败:', err);
                failed += texts.length;
                chrome.runtime.sendMessage({
                    type: 'TRANSLATE_ERROR',
                    data: { error: err.message || '翻译请求失败' }
                }).catch(() => { });

                // 频率限制错误，等待后继续
                if (err.message && (err.message.includes('频率') || err.message.includes('429'))) {
                    await new Promise(r => setTimeout(r, 5000));
                }
            }

            // 批次间短暂间隔，避免连续请求
            if (batchIdx < batches.length - 1) {
                await new Promise(r => setTimeout(r, 500));
            }
        }

        return { translated, failed };
    }

    // ====== 主翻译流程 ======

    /**
     * 翻译整个页面（首次触发）
     */
    async function translatePage(sendResponse) {
        isTranslating = true;

        try {
            const textNodes = collectTextNodesFrom(document.body);

            if (textNodes.length === 0) {
                isTranslating = false;
                sendResponse?.({ status: 'done', message: '没有找到需要翻译的内容' });
                return;
            }

            sendResponse?.({ status: 'started', total: textNodes.length });

            const { translated, failed } = await translateNodes(textNodes);

            isTranslated = true;
            isTranslating = false;

            // 启动渐进式翻译（监听滚动和 DOM 变化）
            startProgressiveTranslation();

            chrome.runtime.sendMessage({
                type: 'TRANSLATE_COMPLETE',
                data: { total: textNodes.length, translated }
            }).catch(() => { });

        } catch (error) {
            isTranslating = false;
            console.error('[zhiyi] 页面翻译出错:', error);
        }
    }

    // ====== 渐进式翻译（滚动 + DOM 变化） ======

    /**
     * 启动渐进式翻译观察器
     */
    function startProgressiveTranslation() {
        stopProgressiveTranslation();

        // 1. IntersectionObserver：监测元素进入视口
        // 对页面中的主要容器元素进行观察
        scrollObserver = new IntersectionObserver((entries) => {
            if (!isTranslated) return;

            for (const entry of entries) {
                if (entry.isIntersecting) {
                    // 元素进入视口，收集其中未翻译的文本节点
                    const newNodes = collectTextNodesFrom(entry.target);
                    if (newNodes.length > 0) {
                        pendingNodes.push(...newNodes);
                        scheduleTranslation();
                    }
                }
            }
        }, {
            rootMargin: '200px 0px',  // 提前200px开始翻译（预翻译即将可见的内容）
            threshold: 0
        });

        // 观察页面中的块级元素
        observeBlockElements(document.body);

        // 2. MutationObserver：监测 DOM 变化（无限滚动、AJAX 加载等）
        mutationObserver = new MutationObserver((mutations) => {
            if (!isTranslated) return;

            let hasNewContent = false;

            for (const mutation of mutations) {
                // 跳过我们自己的修改
                if (mutation.type === 'characterData') continue;

                for (const addedNode of mutation.addedNodes) {
                    if (addedNode.nodeType === Node.ELEMENT_NODE) {
                        // 跳过我们自己的元素
                        if (addedNode.classList?.contains('zhiyi-translated') ||
                            addedNode.classList?.contains('zhiyi-subtitle')) {
                            continue;
                        }

                        // 新增的元素，添加到 IntersectionObserver
                        observeBlockElements(addedNode);

                        // 如果在视口内，直接收集翻译
                        if (isElementInViewport(addedNode)) {
                            const newNodes = collectTextNodesFrom(addedNode);
                            if (newNodes.length > 0) {
                                pendingNodes.push(...newNodes);
                                hasNewContent = true;
                            }
                        }
                    } else if (addedNode.nodeType === Node.TEXT_NODE) {
                        if (isTranslatableTextNode(addedNode)) {
                            pendingNodes.push(addedNode);
                            hasNewContent = true;
                        }
                    }
                }
            }

            if (hasNewContent) {
                scheduleTranslation();
            }
        });

        mutationObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    /**
     * 观察块级元素，让 IntersectionObserver 监控它们
     */
    function observeBlockElements(root) {
        if (!scrollObserver) return;

        // 观察直接子块级元素以及较大的容器
        const blockTags = ['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'NAV',
            'P', 'LI', 'TD', 'TH', 'BLOCKQUOTE', 'FIGURE', 'DETAILS',
            'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DL', 'DD', 'DT'];

        if (root.nodeType === Node.ELEMENT_NODE && blockTags.includes(root.tagName)) {
            scrollObserver.observe(root);
        }

        const elements = root.querySelectorAll?.(blockTags.join(','));
        if (elements) {
            elements.forEach(el => {
                // 只观察未翻译的元素
                if (!el.classList.contains('zhiyi-translated')) {
                    scrollObserver.observe(el);
                }
            });
        }
    }

    /**
     * 检查元素是否在视口中
     */
    function isElementInViewport(el) {
        try {
            const rect = el.getBoundingClientRect();
            return rect.bottom >= -200 &&
                rect.top <= (window.innerHeight + 200) &&
                rect.right >= 0 &&
                rect.left <= window.innerWidth;
        } catch {
            return false;
        }
    }

    /**
     * 防抖调度翻译
     */
    function scheduleTranslation() {
        if (translateTimer) clearTimeout(translateTimer);
        translateTimer = setTimeout(() => {
            flushPendingTranslation();
        }, SCROLL_DEBOUNCE_MS);
    }

    /**
     * 执行待翻译节点
     */
    async function flushPendingTranslation() {
        if (pendingNodes.length === 0) return;

        // 取走当前队列中的所有节点
        const nodes = pendingNodes.splice(0, pendingNodes.length);

        // 去重：过滤掉已翻译的
        const uniqueNodes = nodes.filter(n => !translatedNodes.has(n) && isTranslatableTextNode(n));

        if (uniqueNodes.length === 0) return;

        console.log(`[zhiyi] 渐进翻译: ${uniqueNodes.length} 个新文本`);
        await translateNodes(uniqueNodes);
    }

    /**
     * 停止渐进式翻译
     */
    function stopProgressiveTranslation() {
        if (scrollObserver) {
            scrollObserver.disconnect();
            scrollObserver = null;
        }
        if (mutationObserver) {
            mutationObserver.disconnect();
            mutationObserver = null;
        }
        if (translateTimer) {
            clearTimeout(translateTimer);
            translateTimer = null;
        }
        pendingNodes = [];
    }

    // ====== 恢复原文 ======

    /**
     * 恢复原文
     */
    function restoreOriginal() {
        // 停止渐进式翻译
        stopProgressiveTranslation();

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
=======
/**
 * 网页翻译 Content Script
 * 遍历 DOM 收集文本，并发批量翻译并原地替换
 * 支持滚动时自动翻译新出现的内容（渐进式翻译）
 */

(function () {
    'use strict';

    // 状态管理
    let isTranslated = false;
    let isTranslating = false;
    const originalTexts = new Map(); // 存储原始文本用于恢复
    const translatedNodes = new WeakSet(); // 已翻译或已入队的节点

    // 渐进式翻译的观察器
    let scrollObserver = null;       // IntersectionObserver
    let mutationObserver = null;     // MutationObserver
    let pendingNodes = [];           // 滚动/变更后待翻译的节点
    let translateTimer = null;       // 防抖定时器

    // 不翻译的标签
    const SKIP_TAGS = new Set([
        'SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA', 'INPUT',
        'SELECT', 'OPTION', 'SVG', 'MATH', 'NOSCRIPT', 'IFRAME',
        'CANVAS', 'VIDEO', 'AUDIO', 'IMG', 'BR', 'HR', 'KBD', 'SAMP'
    ]);

    // 不翻译的属性
    const SKIP_CLASSES = ['notranslate', 'zhiyi-translated', 'zhiyi-subtitle'];

    // 配置
    const MEGA_BATCH_CHARS = 15000;  // 单次请求最大字符数（~5000token输入）
    const MAX_ITEMS_PER_BATCH = 120; // 单次请求最大条目数
    const MIN_TEXT_LENGTH = 2;
    const MAX_TEXT_LENGTH = 2000;
    const SCROLL_DEBOUNCE_MS = 300;

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

    // ====== 文本节点检查 ======

    /**
     * 检查一个元素是否应该被跳过
     */
    function shouldSkipElement(el) {
        while (el) {
            if (SKIP_TAGS.has(el.tagName)) return true;
            if (el.classList && SKIP_CLASSES.some(cls => el.classList.contains(cls))) return true;
            if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) return true;
            el = el.parentElement;
        }
        return false;
    }

    /**
     * 检查文本节点是否需要翻译
     */
    function isTranslatableTextNode(node) {
        if (node.nodeType !== Node.TEXT_NODE) return false;
        const text = node.textContent.trim();
        if (!text || text.length < MIN_TEXT_LENGTH) return false;
        if (!/[a-zA-Z]/.test(text)) return false;
        if (!node.parentElement) return false;
        if (translatedNodes.has(node)) return false;
        if (shouldSkipElement(node.parentElement)) return false;
        return true;
    }

    // ====== 收集文本节点 ======

    /**
     * 从指定根元素中收集需要翻译的文本节点
     */
    function collectTextNodesFrom(root) {
        const textNodes = [];
        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function (node) {
                    return isTranslatableTextNode(node)
                        ? NodeFilter.FILTER_ACCEPT
                        : NodeFilter.FILTER_REJECT;
                }
            }
        );

        let node;
        while (node = walker.nextNode()) {
            textNodes.push(node);
        }
        return textNodes;
    }

    // ====== 批量翻译核心 ======

    /**
     * 智能分批：按字符总量 + 条目数上限来切分
     * 目标：尽可能少的 API 请求
     */
    function smartBatch(textNodes) {
        const batches = [];
        let currentBatch = [];
        let currentChars = 0;

        for (const node of textNodes) {
            const t = node.textContent.trim();
            const text = t.length > MAX_TEXT_LENGTH ? t.substring(0, MAX_TEXT_LENGTH) : t;
            const charLen = text.length;

            // 如果当前批次加上这条会超限，先提交当前批次
            if (currentBatch.length > 0 &&
                (currentChars + charLen > MEGA_BATCH_CHARS || currentBatch.length >= MAX_ITEMS_PER_BATCH)) {
                batches.push([...currentBatch]);
                currentBatch = [];
                currentChars = 0;
            }

            currentBatch.push({ node, text });
            currentChars += charLen;
        }

        if (currentBatch.length > 0) {
            batches.push(currentBatch);
        }

        return batches;
    }

    /**
     * 翻译一组文本节点（串行大批量，最小化 API 请求数）
     */
    async function translateNodes(textNodes) {
        if (textNodes.length === 0) return { translated: 0, failed: 0 };

        // 标记为已入队
        textNodes.forEach(n => translatedNodes.add(n));

        // 智能分批
        const batches = smartBatch(textNodes);
        console.log(`[zhiyi] 共 ${textNodes.length} 条文本，分成 ${batches.length} 个请求`);

        let translated = 0;
        let failed = 0;

        // 串行执行每个批次（避免触发频率限制）
        for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
            const batch = batches[batchIdx];
            const texts = batch.map(item => item.text);

            // 通知进度
            chrome.runtime.sendMessage({
                type: 'TRANSLATE_PROGRESS',
                data: {
                    translated: translated + failed,
                    total: textNodes.length,
                    batchInfo: `请求 ${batchIdx + 1}/${batches.length}（${texts.length} 条）`
                }
            }).catch(() => { });

            try {
                const response = await chrome.runtime.sendMessage({
                    type: 'TRANSLATE_BATCH',
                    data: { texts, batchId: batchIdx }
                });

                if (response.error || !response.translations) {
                    console.error('[zhiyi] 翻译出错:', response.error);
                    failed += texts.length;
                    chrome.runtime.sendMessage({
                        type: 'TRANSLATE_ERROR',
                        data: { error: response.error || '翻译返回结果异常' }
                    }).catch(() => { });
                    continue;
                }

                const { translations } = response;
                for (let j = 0; j < batch.length; j++) {
                    const { node } = batch[j];
                    const translation = translations[j];

                    try {
                        if (translation && translation !== texts[j] && node.parentElement) {
                            originalTexts.set(node, node.textContent);
                            node.textContent = translation;
                            node.parentElement.classList.add('zhiyi-translated');
                            translated++;
                        } else {
                            translated++;
                        }
                    } catch (e) {
                        translated++;
                    }
                }
            } catch (err) {
                console.error('[zhiyi] 批次翻译失败:', err);
                failed += texts.length;
                chrome.runtime.sendMessage({
                    type: 'TRANSLATE_ERROR',
                    data: { error: err.message || '翻译请求失败' }
                }).catch(() => { });

                // 频率限制错误，等待后继续
                if (err.message && (err.message.includes('频率') || err.message.includes('429'))) {
                    await new Promise(r => setTimeout(r, 5000));
                }
            }

            // 批次间短暂间隔，避免连续请求
            if (batchIdx < batches.length - 1) {
                await new Promise(r => setTimeout(r, 500));
            }
        }

        return { translated, failed };
    }

    // ====== 主翻译流程 ======

    /**
     * 翻译整个页面（首次触发）
     */
    async function translatePage(sendResponse) {
        isTranslating = true;

        try {
            const textNodes = collectTextNodesFrom(document.body);

            if (textNodes.length === 0) {
                isTranslating = false;
                sendResponse?.({ status: 'done', message: '没有找到需要翻译的内容' });
                return;
            }

            sendResponse?.({ status: 'started', total: textNodes.length });

            const { translated, failed } = await translateNodes(textNodes);

            isTranslated = true;
            isTranslating = false;

            // 启动渐进式翻译（监听滚动和 DOM 变化）
            startProgressiveTranslation();

            chrome.runtime.sendMessage({
                type: 'TRANSLATE_COMPLETE',
                data: { total: textNodes.length, translated }
            }).catch(() => { });

        } catch (error) {
            isTranslating = false;
            console.error('[zhiyi] 页面翻译出错:', error);
        }
    }

    // ====== 渐进式翻译（滚动 + DOM 变化） ======

    /**
     * 启动渐进式翻译观察器
     */
    function startProgressiveTranslation() {
        stopProgressiveTranslation();

        // 1. IntersectionObserver：监测元素进入视口
        // 对页面中的主要容器元素进行观察
        scrollObserver = new IntersectionObserver((entries) => {
            if (!isTranslated) return;

            for (const entry of entries) {
                if (entry.isIntersecting) {
                    // 元素进入视口，收集其中未翻译的文本节点
                    const newNodes = collectTextNodesFrom(entry.target);
                    if (newNodes.length > 0) {
                        pendingNodes.push(...newNodes);
                        scheduleTranslation();
                    }
                }
            }
        }, {
            rootMargin: '200px 0px',  // 提前200px开始翻译（预翻译即将可见的内容）
            threshold: 0
        });

        // 观察页面中的块级元素
        observeBlockElements(document.body);

        // 2. MutationObserver：监测 DOM 变化（无限滚动、AJAX 加载等）
        mutationObserver = new MutationObserver((mutations) => {
            if (!isTranslated) return;

            let hasNewContent = false;

            for (const mutation of mutations) {
                // 跳过我们自己的修改
                if (mutation.type === 'characterData') continue;

                for (const addedNode of mutation.addedNodes) {
                    if (addedNode.nodeType === Node.ELEMENT_NODE) {
                        // 跳过我们自己的元素
                        if (addedNode.classList?.contains('zhiyi-translated') ||
                            addedNode.classList?.contains('zhiyi-subtitle')) {
                            continue;
                        }

                        // 新增的元素，添加到 IntersectionObserver
                        observeBlockElements(addedNode);

                        // 如果在视口内，直接收集翻译
                        if (isElementInViewport(addedNode)) {
                            const newNodes = collectTextNodesFrom(addedNode);
                            if (newNodes.length > 0) {
                                pendingNodes.push(...newNodes);
                                hasNewContent = true;
                            }
                        }
                    } else if (addedNode.nodeType === Node.TEXT_NODE) {
                        if (isTranslatableTextNode(addedNode)) {
                            pendingNodes.push(addedNode);
                            hasNewContent = true;
                        }
                    }
                }
            }

            if (hasNewContent) {
                scheduleTranslation();
            }
        });

        mutationObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    /**
     * 观察块级元素，让 IntersectionObserver 监控它们
     */
    function observeBlockElements(root) {
        if (!scrollObserver) return;

        // 观察直接子块级元素以及较大的容器
        const blockTags = ['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'NAV',
            'P', 'LI', 'TD', 'TH', 'BLOCKQUOTE', 'FIGURE', 'DETAILS',
            'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DL', 'DD', 'DT'];

        if (root.nodeType === Node.ELEMENT_NODE && blockTags.includes(root.tagName)) {
            scrollObserver.observe(root);
        }

        const elements = root.querySelectorAll?.(blockTags.join(','));
        if (elements) {
            elements.forEach(el => {
                // 只观察未翻译的元素
                if (!el.classList.contains('zhiyi-translated')) {
                    scrollObserver.observe(el);
                }
            });
        }
    }

    /**
     * 检查元素是否在视口中
     */
    function isElementInViewport(el) {
        try {
            const rect = el.getBoundingClientRect();
            return rect.bottom >= -200 &&
                rect.top <= (window.innerHeight + 200) &&
                rect.right >= 0 &&
                rect.left <= window.innerWidth;
        } catch {
            return false;
        }
    }

    /**
     * 防抖调度翻译
     */
    function scheduleTranslation() {
        if (translateTimer) clearTimeout(translateTimer);
        translateTimer = setTimeout(() => {
            flushPendingTranslation();
        }, SCROLL_DEBOUNCE_MS);
    }

    /**
     * 执行待翻译节点
     */
    async function flushPendingTranslation() {
        if (pendingNodes.length === 0) return;

        // 取走当前队列中的所有节点
        const nodes = pendingNodes.splice(0, pendingNodes.length);

        // 去重：过滤掉已翻译的
        const uniqueNodes = nodes.filter(n => !translatedNodes.has(n) && isTranslatableTextNode(n));

        if (uniqueNodes.length === 0) return;

        console.log(`[zhiyi] 渐进翻译: ${uniqueNodes.length} 个新文本`);
        await translateNodes(uniqueNodes);
    }

    /**
     * 停止渐进式翻译
     */
    function stopProgressiveTranslation() {
        if (scrollObserver) {
            scrollObserver.disconnect();
            scrollObserver = null;
        }
        if (mutationObserver) {
            mutationObserver.disconnect();
            mutationObserver = null;
        }
        if (translateTimer) {
            clearTimeout(translateTimer);
            translateTimer = null;
        }
        pendingNodes = [];
    }

    // ====== 恢复原文 ======

    /**
     * 恢复原文
     */
    function restoreOriginal() {
        // 停止渐进式翻译
        stopProgressiveTranslation();

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
>>>>>>> c14eadc151a0cfc871e90e8c7436b7bc1c7b7a50
