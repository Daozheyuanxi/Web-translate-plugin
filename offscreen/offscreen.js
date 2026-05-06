/**
 * Offscreen Document — 标签页音频录制
 * 接收 tabCapture streamId，使用 MediaRecorder 每 5 秒录制一段音频，
 * 转为 base64 发送给 service worker 处理。
 */

let mediaRecorder = null;
let mediaStream = null;
const CHUNK_INTERVAL_MS = 5000; // 每 5 秒一段

// 监听来自 service worker 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'OFFSCREEN_START_RECORDING':
            startRecording(message.streamId)
                .then(() => sendResponse({ success: true }))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true; // 异步响应

        case 'OFFSCREEN_STOP_RECORDING':
            stopRecording();
            sendResponse({ success: true });
            break;
    }
});

/**
 * 开始录制标签页音频
 */
async function startRecording(streamId) {
    // 通过 tabCapture streamId 获取音频流
    mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            mandatory: {
                chromeMediaSource: 'tab',
                chromeMediaSourceId: streamId
            }
        },
        video: false
    });

    // 创建 MediaRecorder（webm/opus 格式，Groq Whisper 支持）
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

    mediaRecorder = new MediaRecorder(mediaStream, {
        mimeType,
        audioBitsPerSecond: 64000 // 64kbps 够用且省带宽
    });

    // 每个 chunk 到达时发送给 service worker
    mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0) {
            const base64 = await blobToBase64(event.data);
            chrome.runtime.sendMessage({
                type: 'AUDIO_CHUNK',
                data: {
                    audio: base64,
                    mimeType: mimeType
                }
            }).catch(() => { });
        }
    };

    mediaRecorder.onerror = (event) => {
        console.error('[offscreen] MediaRecorder error:', event.error);
    };

    // 开始录制，每 CHUNK_INTERVAL_MS 毫秒产生一个 chunk
    mediaRecorder.start(CHUNK_INTERVAL_MS);
    console.log('[offscreen] Recording started, chunk interval:', CHUNK_INTERVAL_MS, 'ms');

    // 同时让音频继续在标签页中播放（不静音）
    // 创建一个 AudioContext 将音频流连接到扬声器
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(mediaStream);
    source.connect(audioCtx.destination);
}

/**
 * 停止录制
 */
function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    mediaRecorder = null;

    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }

    console.log('[offscreen] Recording stopped');
}

/**
 * Blob 转 base64
 */
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            // data:audio/webm;base64,XXXX → 取逗号后面部分
            const base64 = reader.result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}
