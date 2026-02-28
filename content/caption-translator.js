<<<<<<< HEAD
/**
 * 字幕轨道翻译 Content Script
 * 拦截视频已有字幕（YouTube timedtext / HTML5 <track>），
 * 批量翻译后按时间戳同步显示中英双语字幕
 */

(function () {
    'use strict';

    let isActive = false;
    let currentVideo = null;
    let captionOverlay = null;
    let captionData = [];       // [{start, end, en, zh}]
    let displayTimer = null;
    let translationProgress = { total: 0, done: 0 };

    // ====== 消息监听 ======

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message.type) {
            case 'TOGGLE_CAPTION_TRANSLATE':
                if (isActive) {
                    stopCaptionTranslate();
                    sendResponse({ status: 'stopped' });
                } else {
                    startCaptionTranslate(sendResponse);
                    return true;
                }
                break;

            case 'GET_CAPTION_STATUS':
                sendResponse({
                    isActive,
                    hasVideo: !!findVideo(),
                    hasCaptions: detectCaptionSource() !== null,
                    progress: translationProgress
                });
                break;
        }
    });

    // ====== 视频查找 ======

    function findVideo() {
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
            if (!video.paused && video.readyState >= 2) return video;
        }
        return videos[0] || null;
    }

    // ====== 字幕来源检测 ======

    /**
     * 检测字幕来源类型
     * @returns {'youtube' | 'track' | null}
     */
    function detectCaptionSource() {
        // 1. YouTube
        if (isYouTubePage()) return 'youtube';

        // 2. HTML5 <track>
        const video = findVideo();
        if (video) {
            const tracks = video.querySelectorAll('track');
            for (const track of tracks) {
                if (track.kind === 'subtitles' || track.kind === 'captions') {
                    return 'track';
                }
            }
            // 也检查 textTracks API
            if (video.textTracks && video.textTracks.length > 0) {
                return 'track';
            }
        }

        return null;
    }

    function isYouTubePage() {
        return location.hostname === 'www.youtube.com' || location.hostname === 'youtube.com';
    }

    // ====== 启动 ======

    async function startCaptionTranslate(sendResponse) {
        currentVideo = findVideo();
        if (!currentVideo) {
            sendResponse({ status: 'error', message: '未找到视频元素' });
            return;
        }

        const source = detectCaptionSource();
        if (!source) {
            sendResponse({ status: 'error', message: '未检测到字幕轨道，请尝试使用「语音字幕」功能' });
            return;
        }

        try {
            createCaptionOverlay();
            showOverlayMessage('正在获取字幕数据...');

            let rawCaptions = [];

            if (source === 'youtube') {
                rawCaptions = await fetchYouTubeCaptions();
            } else if (source === 'track') {
                rawCaptions = await fetchTrackCaptions();
            }

            if (rawCaptions.length === 0) {
                showOverlayMessage('未能获取到字幕内容');
                sendResponse({ status: 'error', message: '字幕内容为空' });
                return;
            }

            // 初始化 captionData（英文已有，中文待翻译）
            captionData = rawCaptions.map(c => ({
                start: c.start,
                end: c.end,
                en: c.text,
                zh: ''
            }));

            showOverlayMessage(`获取到 ${captionData.length} 条字幕，正在翻译...`);
            isActive = true;
            sendResponse({ status: 'started', total: captionData.length });

            // 立即开始同步显示（英文先显示，中文翻译完后补上）
            startSyncDisplay();

            // 批量翻译所有字幕
            await batchTranslateAll();

        } catch (error) {
            console.error('字幕翻译启动失败:', error);
            sendResponse({ status: 'error', message: error.message });
        }
    }

    // ====== YouTube 字幕获取 ======

    async function fetchYouTubeCaptions() {
        // 多种方案按优先级尝试
        const captionUrl = await extractYouTubeCaptionUrl();
        if (!captionUrl) {
            throw new Error('未找到 YouTube 字幕数据。请确认：\n1. 视频有 CC 字幕（点击播放器的 CC 按钮查看）\n2. 如果是刚导航到视频页面，请刷新页面后重试');
        }

        console.log('[zhiyi] Caption URL found:', captionUrl.substring(0, 100) + '...');

        // 获取 JSON3 格式的字幕
        let fetchUrl;
        try {
            fetchUrl = new URL(captionUrl);
        } catch (e) {
            // URL 可能包含未反转义的字符
            const cleaned = captionUrl.replace(/\\u0026/g, '&').replace(/\\\/\//g, '//');
            fetchUrl = new URL(cleaned);
        }
        fetchUrl.searchParams.set('fmt', 'json3');

        const response = await fetch(fetchUrl.toString());
        if (!response.ok) {
            throw new Error('获取 YouTube 字幕失败: HTTP ' + response.status);
        }

        const text = await response.text();
        if (!text || text.length === 0) {
            throw new Error('YouTube 字幕响应为空');
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            console.error('[zhiyi] Caption JSON parse failed, response preview:', text.substring(0, 200));
            throw new Error('字幕数据格式异常，请刷新页面后重试');
        }

        return parseYouTubeJSON3(data);
    }

    /**
     * 从 YouTube 页面提取字幕轨道 URL
     * 使用多重方案确保兼容性
     */
    async function extractYouTubeCaptionUrl() {
        // 方案1：注入页面级脚本提取（最可靠）
        const urlFromInjection = await extractViaPageInjection();
        if (urlFromInjection) return urlFromInjection;

        // 方案2：解析页面 HTML 源码
        const urlFromHtml = extractFromPageSource();
        if (urlFromHtml) return urlFromHtml;

        // 方案3：通过 YouTube API 获取
        const urlFromApi = await extractFromYouTubeApi();
        if (urlFromApi) return urlFromApi;

        return null;
    }

    /**
     * 方案1：注入页面级脚本提取 ytInitialPlayerResponse
     * Content Script 运行在隔离环境，无法直接访问页面 JS 变量。
     * 通过注入 <script> 标签到页面 DOM，在页面上下文中读取数据，
     * 再通过 window.postMessage 传回 Content Script。
     */
    function extractViaPageInjection() {
        return new Promise((resolve) => {
            const CHANNEL = 'zhiyi-caption-extract-' + Date.now();

            // 监听来自页面脚本的消息
            const handler = (event) => {
                if (event.source !== window) return;
                if (event.data?.channel !== CHANNEL) return;

                window.removeEventListener('message', handler);

                if (event.data.captionUrl) {
                    resolve(event.data.captionUrl);
                } else {
                    resolve(null);
                }
            };
            window.addEventListener('message', handler);

            // 注入页面级脚本
            const script = document.createElement('script');
            script.textContent = `
                (function() {
                    var channel = '${CHANNEL}';
                    var captionUrl = null;
                    try {
                        // 尝试多个数据来源
                        var playerResp = null;

                        // 来源1: ytInitialPlayerResponse 全局变量
                        if (window.ytInitialPlayerResponse) {
                            playerResp = window.ytInitialPlayerResponse;
                        }

                        // 来源2: ytplayer.config
                        if (!playerResp && window.ytplayer && window.ytplayer.config) {
                            playerResp = window.ytplayer.config.args &&
                                         window.ytplayer.config.args.raw_player_response;
                        }

                        // 来源3: document.ytInitialPlayerResponse (某些情况)
                        if (!playerResp && document.ytInitialPlayerResponse) {
                            playerResp = document.ytInitialPlayerResponse;
                        }

                        // 来源4: 从 ytcfg 中获取
                        if (!playerResp && window.ytcfg) {
                            var data = window.ytcfg.data_ || window.ytcfg.d && window.ytcfg.d();
                            if (data && data.PLAYER_VARS) {
                                try {
                                    var pv = typeof data.PLAYER_VARS === 'string' ?
                                             JSON.parse(data.PLAYER_VARS) : data.PLAYER_VARS;
                                    playerResp = pv.embedded_player_response || pv;
                                } catch(e) {}
                            }
                        }

                        if (playerResp && playerResp.captions &&
                            playerResp.captions.playerCaptionsTracklistRenderer &&
                            playerResp.captions.playerCaptionsTracklistRenderer.captionTracks) {

                            var tracks = playerResp.captions.playerCaptionsTracklistRenderer.captionTracks;

                            // 优先英文字幕
                            var enTrack = tracks.find(function(t) {
                                return t.languageCode === 'en';
                            });
                            // 其次自动生成字幕
                            var autoTrack = tracks.find(function(t) {
                                return t.kind === 'asr';
                            });
                            var track = enTrack || autoTrack || tracks[0];
                            if (track && track.baseUrl) {
                                captionUrl = track.baseUrl;
                            }
                        }
                    } catch(e) {
                        console.error('[zhiyi] caption extraction error:', e);
                    }

                    window.postMessage({
                        channel: channel,
                        captionUrl: captionUrl
                    }, '*');
                })();
            `;
            document.documentElement.appendChild(script);
            script.remove();

            // 超时 fallback
            setTimeout(() => {
                window.removeEventListener('message', handler);
                resolve(null);
            }, 3000);
        });
    }

    /**
     * 方案2：从页面 HTML 源码中解析字幕数据
     * YouTube 首次加载时会在 HTML 中内嵌 ytInitialPlayerResponse
     */
    function extractFromPageSource() {
        try {
            // 获取整个页面 HTML
            const html = document.documentElement.innerHTML;

            // 直接搜索 captionTracks 的 baseUrl（最可靠的正则方案）
            // YouTube 在 HTML 中内嵌的 JSON 数据里，baseUrl 后紧跟 languageCode
            const baseUrlMatch = html.match(/"captionTracks":\s*\[\s*\{[^}]*?"baseUrl"\s*:\s*"(https?:[^"]+)"/);
            if (baseUrlMatch) {
                // 反转义 YouTube JSON 中的编码字符
                const url = baseUrlMatch[1]
                    .replace(/\\u0026/g, '&')
                    .replace(/\\\//g, '/')
                    .replace(/\\"/g, '"');
                console.log('[zhiyi] Found caption URL from HTML source');
                return url;
            }

            // 备选：尝试匹配完整的 ytInitialPlayerResponse 并解析
            // 注意：YouTube 的 JSON 非常大，使用非贪婪可能截断，所以只在上面方法失败时使用
            const playerRespMatch = html.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{.*?\});\s*var\s/);
            if (playerRespMatch) {
                try {
                    const data = JSON.parse(playerRespMatch[1]);
                    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                    if (tracks && tracks.length > 0) {
                        const enTrack = tracks.find(t => t.languageCode === 'en');
                        const autoTrack = tracks.find(t => t.kind === 'asr');
                        const track = enTrack || autoTrack || tracks[0];
                        if (track?.baseUrl) return track.baseUrl;
                    }
                } catch (e) {
                    console.log('[zhiyi] ytInitialPlayerResponse JSON parse failed');
                }
            }

        } catch (e) {
            console.error('[zhiyi] HTML parse error:', e);
        }

        return null;
    }

    /**
     * 方案3：通过 YouTube innertube API
     */
    async function extractFromYouTubeApi() {
        try {
            const videoId = new URLSearchParams(location.search).get('v');
            if (!videoId) return null;

            // 使用 YouTube innertube API（公开可用）
            const response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    videoId: videoId,
                    context: {
                        client: {
                            hl: 'en',
                            gl: 'US',
                            clientName: 'WEB',
                            clientVersion: '2.20240101.00.00'
                        }
                    }
                })
            });

            if (!response.ok) return null;

            let data;
            try {
                data = await response.json();
            } catch (e) {
                console.error('[zhiyi] Innertube JSON parse failed');
                return null;
            }

            const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            if (tracks && tracks.length > 0) {
                const enTrack = tracks.find(t => t.languageCode === 'en');
                const autoTrack = tracks.find(t => t.kind === 'asr');
                const track = enTrack || autoTrack || tracks[0];
                if (track?.baseUrl) {
                    console.log('[zhiyi] Found caption URL from innertube API');
                    return track.baseUrl;
                }
            }
        } catch (e) {
            console.error('[zhiyi] YouTube innertube API error:', e);
        }

        return null;
    }

    /**
     * 解析 YouTube JSON3 字幕格式
     */
    function parseYouTubeJSON3(data) {
        const captions = [];
        const events = data.events || [];

        for (const event of events) {
            if (!event.segs) continue;

            const text = event.segs.map(s => s.utf8 || '').join('').trim();
            if (!text || text === '\n') continue;

            const startMs = event.tStartMs || 0;
            const durationMs = event.dDurationMs || 3000;

            captions.push({
                start: startMs / 1000,
                end: (startMs + durationMs) / 1000,
                text: text
            });
        }

        return captions;
    }

    // ====== HTML5 <track> 字幕获取 ======

    async function fetchTrackCaptions() {
        const video = currentVideo;
        if (!video) throw new Error('video not found');

        // 方法1：从 TextTrack API 获取
        if (video.textTracks && video.textTracks.length > 0) {
            for (let i = 0; i < video.textTracks.length; i++) {
                const track = video.textTracks[i];
                if (track.kind === 'subtitles' || track.kind === 'captions') {
                    // 激活 track 以加载 cues
                    const prevMode = track.mode;
                    track.mode = 'showing';

                    // 等待 cues 加载
                    await new Promise(resolve => setTimeout(resolve, 500));

                    if (track.cues && track.cues.length > 0) {
                        const captions = [];
                        for (let j = 0; j < track.cues.length; j++) {
                            const cue = track.cues[j];
                            captions.push({
                                start: cue.startTime,
                                end: cue.endTime,
                                text: cue.text || cue.getCueAsHTML?.()?.textContent || ''
                            });
                        }
                        // 恢复原始模式，隐藏原始字幕（我们自己显示）
                        track.mode = 'hidden';
                        return captions;
                    }
                    track.mode = prevMode;
                }
            }
        }

        // 方法2：从 <track> 元素的 src 获取 WebVTT
        const trackElements = video.querySelectorAll('track');
        for (const trackEl of trackElements) {
            if ((trackEl.kind === 'subtitles' || trackEl.kind === 'captions') && trackEl.src) {
                const captions = await fetchAndParseVTT(trackEl.src);
                if (captions.length > 0) {
                    // 隐藏原始字幕
                    if (trackEl.track) trackEl.track.mode = 'hidden';
                    return captions;
                }
            }
        }

        throw new Error('未能从 track 元素获取字幕');
    }

    /**
     * 获取并解析 WebVTT 格式字幕
     */
    async function fetchAndParseVTT(url) {
        const response = await fetch(url);
        const text = await response.text();
        return parseVTT(text);
    }

    function parseVTT(vttText) {
        const captions = [];
        const blocks = vttText.split(/\n\n+/);

        for (const block of blocks) {
            const lines = block.trim().split('\n');
            // 查找时间戳行
            for (let i = 0; i < lines.length; i++) {
                const timeMatch = lines[i].match(
                    /(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/
                );
                if (timeMatch) {
                    const start = parseVTTTime(timeMatch[1]);
                    const end = parseVTTTime(timeMatch[2]);
                    const text = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim();
                    if (text) {
                        captions.push({ start, end, text });
                    }
                    break;
                }
            }
        }

        return captions;
    }

    function parseVTTTime(timeStr) {
        const parts = timeStr.replace(',', '.').split(':');
        const hours = parseInt(parts[0]);
        const minutes = parseInt(parts[1]);
        const seconds = parseFloat(parts[2]);
        return hours * 3600 + minutes * 60 + seconds;
    }

    // ====== 批量翻译 ======

    const TRANSLATE_BATCH_SIZE = 20;

    async function batchTranslateAll() {
        const total = captionData.length;
        translationProgress = { total, done: 0 };

        // 分批翻译，每批内并行，批次间顺序
        for (let i = 0; i < total; i += TRANSLATE_BATCH_SIZE) {
            if (!isActive) break;

            const batch = captionData.slice(i, i + TRANSLATE_BATCH_SIZE);
            const texts = batch.map(c => c.en);

            try {
                const response = await chrome.runtime.sendMessage({
                    type: 'TRANSLATE_BATCH',
                    data: { texts, batchId: Math.floor(i / TRANSLATE_BATCH_SIZE) }
                });

                if (response && response.translations) {
                    for (let j = 0; j < batch.length; j++) {
                        if (response.translations[j]) {
                            batch[j].zh = response.translations[j];
                        }
                    }
                }

                translationProgress.done = Math.min(i + TRANSLATE_BATCH_SIZE, total);

                // 通知 popup 进度
                chrome.runtime.sendMessage({
                    type: 'CAPTION_TRANSLATE_PROGRESS',
                    data: { done: translationProgress.done, total }
                }).catch(() => { });
            } catch (err) {
                console.error(`字幕翻译批次 ${Math.floor(i / TRANSLATE_BATCH_SIZE)} 失败:`, err);
            }
        }

        // 翻译完成
        chrome.runtime.sendMessage({
            type: 'CAPTION_TRANSLATE_COMPLETE',
            data: { total }
        }).catch(() => { });
    }

    // ====== 同步显示 ======

    function startSyncDisplay() {
        stopSyncDisplay();
        displayTimer = setInterval(syncCaptionToVideo, 100);
    }

    function stopSyncDisplay() {
        if (displayTimer) {
            clearInterval(displayTimer);
            displayTimer = null;
        }
    }

    function syncCaptionToVideo() {
        if (!currentVideo || !captionOverlay) return;

        const currentTime = currentVideo.currentTime;

        // 找到当前时间对应的字幕
        const activeCaptions = captionData.filter(
            c => currentTime >= c.start && currentTime <= c.end
        );

        const inner = captionOverlay.querySelector('.zhiyi-caption-inner');
        if (!inner) return;

        if (activeCaptions.length === 0) {
            inner.style.opacity = '0';
            return;
        }

        inner.style.opacity = '1';

        // 合并同时显示的字幕
        const enLines = activeCaptions.map(c => c.en).join(' ');
        const zhLines = activeCaptions.map(c => c.zh).filter(Boolean).join(' ');

        const enEl = inner.querySelector('.zhiyi-caption-en');
        const zhEl = inner.querySelector('.zhiyi-caption-zh');

        if (enEl && enEl.textContent !== enLines) {
            enEl.textContent = enLines;
        }

        if (zhEl) {
            if (zhLines) {
                zhEl.textContent = zhLines;
                zhEl.classList.remove('zhiyi-translating');
            } else {
                zhEl.textContent = '翻译中...';
                zhEl.classList.add('zhiyi-translating');
            }
        }
    }

    // ====== 字幕覆盖层 UI ======

    function createCaptionOverlay() {
        removeCaptionOverlay();

        captionOverlay = document.createElement('div');
        captionOverlay.id = 'zhiyi-caption-overlay';
        captionOverlay.className = 'zhiyi-subtitle';

        captionOverlay.innerHTML = `
      <div class="zhiyi-caption-inner" style="opacity: 0;">
        <div class="zhiyi-caption-en"></div>
        <div class="zhiyi-caption-zh"></div>
      </div>
      <div class="zhiyi-caption-message" style="display: none;"></div>
    `;

        if (currentVideo) {
            const videoParent = currentVideo.parentElement;
            const computedStyle = window.getComputedStyle(videoParent);
            if (computedStyle.position === 'static') {
                videoParent.style.position = 'relative';
            }
            videoParent.appendChild(captionOverlay);
        } else {
            document.body.appendChild(captionOverlay);
        }
    }

    function showOverlayMessage(msg) {
        if (!captionOverlay) return;
        const msgEl = captionOverlay.querySelector('.zhiyi-caption-message');
        if (msgEl) {
            msgEl.textContent = msg;
            msgEl.style.display = 'block';
        }
    }

    function hideOverlayMessage() {
        if (!captionOverlay) return;
        const msgEl = captionOverlay.querySelector('.zhiyi-caption-message');
        if (msgEl) msgEl.style.display = 'none';
    }

    function removeCaptionOverlay() {
        const existing = document.getElementById('zhiyi-caption-overlay');
        if (existing) existing.remove();
        captionOverlay = null;
    }

    // ====== 停止 ======

    function stopCaptionTranslate() {
        isActive = false;
        stopSyncDisplay();
        captionData = [];
        translationProgress = { total: 0, done: 0 };
        removeCaptionOverlay();
    }
})();
=======
/**
 * 字幕轨道翻译 Content Script
 * 拦截视频已有字幕（YouTube timedtext / HTML5 <track>），
 * 批量翻译后按时间戳同步显示中英双语字幕
 */

(function () {
    'use strict';

    let isActive = false;
    let currentVideo = null;
    let captionOverlay = null;
    let captionData = [];       // [{start, end, en, zh}]
    let displayTimer = null;
    let translationProgress = { total: 0, done: 0 };

    // ====== 消息监听 ======

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message.type) {
            case 'TOGGLE_CAPTION_TRANSLATE':
                if (isActive) {
                    stopCaptionTranslate();
                    sendResponse({ status: 'stopped' });
                } else {
                    startCaptionTranslate(sendResponse);
                    return true;
                }
                break;

            case 'GET_CAPTION_STATUS':
                sendResponse({
                    isActive,
                    hasVideo: !!findVideo(),
                    hasCaptions: detectCaptionSource() !== null,
                    progress: translationProgress
                });
                break;
        }
    });

    // ====== 视频查找 ======

    function findVideo() {
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
            if (!video.paused && video.readyState >= 2) return video;
        }
        return videos[0] || null;
    }

    // ====== 字幕来源检测 ======

    /**
     * 检测字幕来源类型
     * @returns {'youtube' | 'track' | null}
     */
    function detectCaptionSource() {
        // 1. YouTube
        if (isYouTubePage()) return 'youtube';

        // 2. HTML5 <track>
        const video = findVideo();
        if (video) {
            const tracks = video.querySelectorAll('track');
            for (const track of tracks) {
                if (track.kind === 'subtitles' || track.kind === 'captions') {
                    return 'track';
                }
            }
            // 也检查 textTracks API
            if (video.textTracks && video.textTracks.length > 0) {
                return 'track';
            }
        }

        return null;
    }

    function isYouTubePage() {
        return location.hostname === 'www.youtube.com' || location.hostname === 'youtube.com';
    }

    // ====== 启动 ======

    async function startCaptionTranslate(sendResponse) {
        currentVideo = findVideo();
        if (!currentVideo) {
            sendResponse({ status: 'error', message: '未找到视频元素' });
            return;
        }

        const source = detectCaptionSource();
        if (!source) {
            sendResponse({ status: 'error', message: '未检测到字幕轨道，请尝试使用「语音字幕」功能' });
            return;
        }

        try {
            createCaptionOverlay();
            showOverlayMessage('正在获取字幕数据...');

            let rawCaptions = [];

            if (source === 'youtube') {
                rawCaptions = await fetchYouTubeCaptions();
            } else if (source === 'track') {
                rawCaptions = await fetchTrackCaptions();
            }

            if (rawCaptions.length === 0) {
                showOverlayMessage('未能获取到字幕内容');
                sendResponse({ status: 'error', message: '字幕内容为空' });
                return;
            }

            // 初始化 captionData（英文已有，中文待翻译）
            captionData = rawCaptions.map(c => ({
                start: c.start,
                end: c.end,
                en: c.text,
                zh: ''
            }));

            showOverlayMessage(`获取到 ${captionData.length} 条字幕，正在翻译...`);
            isActive = true;
            sendResponse({ status: 'started', total: captionData.length });

            // 立即开始同步显示（英文先显示，中文翻译完后补上）
            startSyncDisplay();

            // 批量翻译所有字幕
            await batchTranslateAll();

        } catch (error) {
            console.error('字幕翻译启动失败:', error);
            sendResponse({ status: 'error', message: error.message });
        }
    }

    // ====== YouTube 字幕获取 ======

    async function fetchYouTubeCaptions() {
        // 多种方案按优先级尝试
        const captionUrl = await extractYouTubeCaptionUrl();
        if (!captionUrl) {
            throw new Error('未找到 YouTube 字幕数据。请确认：\n1. 视频有 CC 字幕（点击播放器的 CC 按钮查看）\n2. 如果是刚导航到视频页面，请刷新页面后重试');
        }

        console.log('[zhiyi] Caption URL found:', captionUrl.substring(0, 100) + '...');

        // 获取 JSON3 格式的字幕
        let fetchUrl;
        try {
            fetchUrl = new URL(captionUrl);
        } catch (e) {
            // URL 可能包含未反转义的字符
            const cleaned = captionUrl.replace(/\\u0026/g, '&').replace(/\\\/\//g, '//');
            fetchUrl = new URL(cleaned);
        }
        fetchUrl.searchParams.set('fmt', 'json3');

        const response = await fetch(fetchUrl.toString());
        if (!response.ok) {
            throw new Error('获取 YouTube 字幕失败: HTTP ' + response.status);
        }

        const text = await response.text();
        if (!text || text.length === 0) {
            throw new Error('YouTube 字幕响应为空');
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            console.error('[zhiyi] Caption JSON parse failed, response preview:', text.substring(0, 200));
            throw new Error('字幕数据格式异常，请刷新页面后重试');
        }

        return parseYouTubeJSON3(data);
    }

    /**
     * 从 YouTube 页面提取字幕轨道 URL
     * 使用多重方案确保兼容性
     */
    async function extractYouTubeCaptionUrl() {
        // 方案1：注入页面级脚本提取（最可靠）
        const urlFromInjection = await extractViaPageInjection();
        if (urlFromInjection) return urlFromInjection;

        // 方案2：解析页面 HTML 源码
        const urlFromHtml = extractFromPageSource();
        if (urlFromHtml) return urlFromHtml;

        // 方案3：通过 YouTube API 获取
        const urlFromApi = await extractFromYouTubeApi();
        if (urlFromApi) return urlFromApi;

        return null;
    }

    /**
     * 方案1：注入页面级脚本提取 ytInitialPlayerResponse
     * Content Script 运行在隔离环境，无法直接访问页面 JS 变量。
     * 通过注入 <script> 标签到页面 DOM，在页面上下文中读取数据，
     * 再通过 window.postMessage 传回 Content Script。
     */
    function extractViaPageInjection() {
        return new Promise((resolve) => {
            const CHANNEL = 'zhiyi-caption-extract-' + Date.now();

            // 监听来自页面脚本的消息
            const handler = (event) => {
                if (event.source !== window) return;
                if (event.data?.channel !== CHANNEL) return;

                window.removeEventListener('message', handler);

                if (event.data.captionUrl) {
                    resolve(event.data.captionUrl);
                } else {
                    resolve(null);
                }
            };
            window.addEventListener('message', handler);

            // 注入页面级脚本
            const script = document.createElement('script');
            script.textContent = `
                (function() {
                    var channel = '${CHANNEL}';
                    var captionUrl = null;
                    try {
                        // 尝试多个数据来源
                        var playerResp = null;

                        // 来源1: ytInitialPlayerResponse 全局变量
                        if (window.ytInitialPlayerResponse) {
                            playerResp = window.ytInitialPlayerResponse;
                        }

                        // 来源2: ytplayer.config
                        if (!playerResp && window.ytplayer && window.ytplayer.config) {
                            playerResp = window.ytplayer.config.args &&
                                         window.ytplayer.config.args.raw_player_response;
                        }

                        // 来源3: document.ytInitialPlayerResponse (某些情况)
                        if (!playerResp && document.ytInitialPlayerResponse) {
                            playerResp = document.ytInitialPlayerResponse;
                        }

                        // 来源4: 从 ytcfg 中获取
                        if (!playerResp && window.ytcfg) {
                            var data = window.ytcfg.data_ || window.ytcfg.d && window.ytcfg.d();
                            if (data && data.PLAYER_VARS) {
                                try {
                                    var pv = typeof data.PLAYER_VARS === 'string' ?
                                             JSON.parse(data.PLAYER_VARS) : data.PLAYER_VARS;
                                    playerResp = pv.embedded_player_response || pv;
                                } catch(e) {}
                            }
                        }

                        if (playerResp && playerResp.captions &&
                            playerResp.captions.playerCaptionsTracklistRenderer &&
                            playerResp.captions.playerCaptionsTracklistRenderer.captionTracks) {

                            var tracks = playerResp.captions.playerCaptionsTracklistRenderer.captionTracks;

                            // 优先英文字幕
                            var enTrack = tracks.find(function(t) {
                                return t.languageCode === 'en';
                            });
                            // 其次自动生成字幕
                            var autoTrack = tracks.find(function(t) {
                                return t.kind === 'asr';
                            });
                            var track = enTrack || autoTrack || tracks[0];
                            if (track && track.baseUrl) {
                                captionUrl = track.baseUrl;
                            }
                        }
                    } catch(e) {
                        console.error('[zhiyi] caption extraction error:', e);
                    }

                    window.postMessage({
                        channel: channel,
                        captionUrl: captionUrl
                    }, '*');
                })();
            `;
            document.documentElement.appendChild(script);
            script.remove();

            // 超时 fallback
            setTimeout(() => {
                window.removeEventListener('message', handler);
                resolve(null);
            }, 3000);
        });
    }

    /**
     * 方案2：从页面 HTML 源码中解析字幕数据
     * YouTube 首次加载时会在 HTML 中内嵌 ytInitialPlayerResponse
     */
    function extractFromPageSource() {
        try {
            // 获取整个页面 HTML
            const html = document.documentElement.innerHTML;

            // 直接搜索 captionTracks 的 baseUrl（最可靠的正则方案）
            // YouTube 在 HTML 中内嵌的 JSON 数据里，baseUrl 后紧跟 languageCode
            const baseUrlMatch = html.match(/"captionTracks":\s*\[\s*\{[^}]*?"baseUrl"\s*:\s*"(https?:[^"]+)"/);
            if (baseUrlMatch) {
                // 反转义 YouTube JSON 中的编码字符
                const url = baseUrlMatch[1]
                    .replace(/\\u0026/g, '&')
                    .replace(/\\\//g, '/')
                    .replace(/\\"/g, '"');
                console.log('[zhiyi] Found caption URL from HTML source');
                return url;
            }

            // 备选：尝试匹配完整的 ytInitialPlayerResponse 并解析
            // 注意：YouTube 的 JSON 非常大，使用非贪婪可能截断，所以只在上面方法失败时使用
            const playerRespMatch = html.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{.*?\});\s*var\s/);
            if (playerRespMatch) {
                try {
                    const data = JSON.parse(playerRespMatch[1]);
                    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                    if (tracks && tracks.length > 0) {
                        const enTrack = tracks.find(t => t.languageCode === 'en');
                        const autoTrack = tracks.find(t => t.kind === 'asr');
                        const track = enTrack || autoTrack || tracks[0];
                        if (track?.baseUrl) return track.baseUrl;
                    }
                } catch (e) {
                    console.log('[zhiyi] ytInitialPlayerResponse JSON parse failed');
                }
            }

        } catch (e) {
            console.error('[zhiyi] HTML parse error:', e);
        }

        return null;
    }

    /**
     * 方案3：通过 YouTube innertube API
     */
    async function extractFromYouTubeApi() {
        try {
            const videoId = new URLSearchParams(location.search).get('v');
            if (!videoId) return null;

            // 使用 YouTube innertube API（公开可用）
            const response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    videoId: videoId,
                    context: {
                        client: {
                            hl: 'en',
                            gl: 'US',
                            clientName: 'WEB',
                            clientVersion: '2.20240101.00.00'
                        }
                    }
                })
            });

            if (!response.ok) return null;

            let data;
            try {
                data = await response.json();
            } catch (e) {
                console.error('[zhiyi] Innertube JSON parse failed');
                return null;
            }

            const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            if (tracks && tracks.length > 0) {
                const enTrack = tracks.find(t => t.languageCode === 'en');
                const autoTrack = tracks.find(t => t.kind === 'asr');
                const track = enTrack || autoTrack || tracks[0];
                if (track?.baseUrl) {
                    console.log('[zhiyi] Found caption URL from innertube API');
                    return track.baseUrl;
                }
            }
        } catch (e) {
            console.error('[zhiyi] YouTube innertube API error:', e);
        }

        return null;
    }

    /**
     * 解析 YouTube JSON3 字幕格式
     */
    function parseYouTubeJSON3(data) {
        const captions = [];
        const events = data.events || [];

        for (const event of events) {
            if (!event.segs) continue;

            const text = event.segs.map(s => s.utf8 || '').join('').trim();
            if (!text || text === '\n') continue;

            const startMs = event.tStartMs || 0;
            const durationMs = event.dDurationMs || 3000;

            captions.push({
                start: startMs / 1000,
                end: (startMs + durationMs) / 1000,
                text: text
            });
        }

        return captions;
    }

    // ====== HTML5 <track> 字幕获取 ======

    async function fetchTrackCaptions() {
        const video = currentVideo;
        if (!video) throw new Error('video not found');

        // 方法1：从 TextTrack API 获取
        if (video.textTracks && video.textTracks.length > 0) {
            for (let i = 0; i < video.textTracks.length; i++) {
                const track = video.textTracks[i];
                if (track.kind === 'subtitles' || track.kind === 'captions') {
                    // 激活 track 以加载 cues
                    const prevMode = track.mode;
                    track.mode = 'showing';

                    // 等待 cues 加载
                    await new Promise(resolve => setTimeout(resolve, 500));

                    if (track.cues && track.cues.length > 0) {
                        const captions = [];
                        for (let j = 0; j < track.cues.length; j++) {
                            const cue = track.cues[j];
                            captions.push({
                                start: cue.startTime,
                                end: cue.endTime,
                                text: cue.text || cue.getCueAsHTML?.()?.textContent || ''
                            });
                        }
                        // 恢复原始模式，隐藏原始字幕（我们自己显示）
                        track.mode = 'hidden';
                        return captions;
                    }
                    track.mode = prevMode;
                }
            }
        }

        // 方法2：从 <track> 元素的 src 获取 WebVTT
        const trackElements = video.querySelectorAll('track');
        for (const trackEl of trackElements) {
            if ((trackEl.kind === 'subtitles' || trackEl.kind === 'captions') && trackEl.src) {
                const captions = await fetchAndParseVTT(trackEl.src);
                if (captions.length > 0) {
                    // 隐藏原始字幕
                    if (trackEl.track) trackEl.track.mode = 'hidden';
                    return captions;
                }
            }
        }

        throw new Error('未能从 track 元素获取字幕');
    }

    /**
     * 获取并解析 WebVTT 格式字幕
     */
    async function fetchAndParseVTT(url) {
        const response = await fetch(url);
        const text = await response.text();
        return parseVTT(text);
    }

    function parseVTT(vttText) {
        const captions = [];
        const blocks = vttText.split(/\n\n+/);

        for (const block of blocks) {
            const lines = block.trim().split('\n');
            // 查找时间戳行
            for (let i = 0; i < lines.length; i++) {
                const timeMatch = lines[i].match(
                    /(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/
                );
                if (timeMatch) {
                    const start = parseVTTTime(timeMatch[1]);
                    const end = parseVTTTime(timeMatch[2]);
                    const text = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim();
                    if (text) {
                        captions.push({ start, end, text });
                    }
                    break;
                }
            }
        }

        return captions;
    }

    function parseVTTTime(timeStr) {
        const parts = timeStr.replace(',', '.').split(':');
        const hours = parseInt(parts[0]);
        const minutes = parseInt(parts[1]);
        const seconds = parseFloat(parts[2]);
        return hours * 3600 + minutes * 60 + seconds;
    }

    // ====== 批量翻译 ======

    const TRANSLATE_BATCH_SIZE = 20;

    async function batchTranslateAll() {
        const total = captionData.length;
        translationProgress = { total, done: 0 };

        // 分批翻译，每批内并行，批次间顺序
        for (let i = 0; i < total; i += TRANSLATE_BATCH_SIZE) {
            if (!isActive) break;

            const batch = captionData.slice(i, i + TRANSLATE_BATCH_SIZE);
            const texts = batch.map(c => c.en);

            try {
                const response = await chrome.runtime.sendMessage({
                    type: 'TRANSLATE_BATCH',
                    data: { texts, batchId: Math.floor(i / TRANSLATE_BATCH_SIZE) }
                });

                if (response && response.translations) {
                    for (let j = 0; j < batch.length; j++) {
                        if (response.translations[j]) {
                            batch[j].zh = response.translations[j];
                        }
                    }
                }

                translationProgress.done = Math.min(i + TRANSLATE_BATCH_SIZE, total);

                // 通知 popup 进度
                chrome.runtime.sendMessage({
                    type: 'CAPTION_TRANSLATE_PROGRESS',
                    data: { done: translationProgress.done, total }
                }).catch(() => { });
            } catch (err) {
                console.error(`字幕翻译批次 ${Math.floor(i / TRANSLATE_BATCH_SIZE)} 失败:`, err);
            }
        }

        // 翻译完成
        chrome.runtime.sendMessage({
            type: 'CAPTION_TRANSLATE_COMPLETE',
            data: { total }
        }).catch(() => { });
    }

    // ====== 同步显示 ======

    function startSyncDisplay() {
        stopSyncDisplay();
        displayTimer = setInterval(syncCaptionToVideo, 100);
    }

    function stopSyncDisplay() {
        if (displayTimer) {
            clearInterval(displayTimer);
            displayTimer = null;
        }
    }

    function syncCaptionToVideo() {
        if (!currentVideo || !captionOverlay) return;

        const currentTime = currentVideo.currentTime;

        // 找到当前时间对应的字幕
        const activeCaptions = captionData.filter(
            c => currentTime >= c.start && currentTime <= c.end
        );

        const inner = captionOverlay.querySelector('.zhiyi-caption-inner');
        if (!inner) return;

        if (activeCaptions.length === 0) {
            inner.style.opacity = '0';
            return;
        }

        inner.style.opacity = '1';

        // 合并同时显示的字幕
        const enLines = activeCaptions.map(c => c.en).join(' ');
        const zhLines = activeCaptions.map(c => c.zh).filter(Boolean).join(' ');

        const enEl = inner.querySelector('.zhiyi-caption-en');
        const zhEl = inner.querySelector('.zhiyi-caption-zh');

        if (enEl && enEl.textContent !== enLines) {
            enEl.textContent = enLines;
        }

        if (zhEl) {
            if (zhLines) {
                zhEl.textContent = zhLines;
                zhEl.classList.remove('zhiyi-translating');
            } else {
                zhEl.textContent = '翻译中...';
                zhEl.classList.add('zhiyi-translating');
            }
        }
    }

    // ====== 字幕覆盖层 UI ======

    function createCaptionOverlay() {
        removeCaptionOverlay();

        captionOverlay = document.createElement('div');
        captionOverlay.id = 'zhiyi-caption-overlay';
        captionOverlay.className = 'zhiyi-subtitle';

        captionOverlay.innerHTML = `
      <div class="zhiyi-caption-inner" style="opacity: 0;">
        <div class="zhiyi-caption-en"></div>
        <div class="zhiyi-caption-zh"></div>
      </div>
      <div class="zhiyi-caption-message" style="display: none;"></div>
    `;

        if (currentVideo) {
            const videoParent = currentVideo.parentElement;
            const computedStyle = window.getComputedStyle(videoParent);
            if (computedStyle.position === 'static') {
                videoParent.style.position = 'relative';
            }
            videoParent.appendChild(captionOverlay);
        } else {
            document.body.appendChild(captionOverlay);
        }
    }

    function showOverlayMessage(msg) {
        if (!captionOverlay) return;
        const msgEl = captionOverlay.querySelector('.zhiyi-caption-message');
        if (msgEl) {
            msgEl.textContent = msg;
            msgEl.style.display = 'block';
        }
    }

    function hideOverlayMessage() {
        if (!captionOverlay) return;
        const msgEl = captionOverlay.querySelector('.zhiyi-caption-message');
        if (msgEl) msgEl.style.display = 'none';
    }

    function removeCaptionOverlay() {
        const existing = document.getElementById('zhiyi-caption-overlay');
        if (existing) existing.remove();
        captionOverlay = null;
    }

    // ====== 停止 ======

    function stopCaptionTranslate() {
        isActive = false;
        stopSyncDisplay();
        captionData = [];
        translationProgress = { total: 0, done: 0 };
        removeCaptionOverlay();
    }
})();
>>>>>>> c14eadc151a0cfc871e90e8c7436b7bc1c7b7a50
