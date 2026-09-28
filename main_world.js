// main_world.js — Runs in the page's MAIN world (not isolated)
// Hooks Worker.postMessage to capture WASM auth credentials

(function () {
    if (window.__meshyDownloaderAuthHook) return;
    window.__meshyDownloaderAuthHook = true;

    const publishBearer = (value) => {
        if (typeof value !== 'string' || !/^Bearer\s+/i.test(value)) return;
        window.dispatchEvent(new CustomEvent('__meshy_token__', {
            detail: value.replace(/^Bearer\s+/i, '')
        }));
    };

    const _origFetch = window.fetch;
    window.fetch = function (...args) {
        try {
            const request = args[0];
            const options = args[1] || {};
            publishBearer(new Headers(options.headers || {}).get('authorization'));
            if (request instanceof Request) publishBearer(request.headers.get('authorization'));
        } catch (_) {}
        return _origFetch.apply(this, args);
    };

    const _origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (String(name).toLowerCase() === 'authorization') publishBearer(String(value));
        return _origSetRequestHeader.call(this, name, value);
    };

    const _origPostMessage = Worker.prototype.postMessage;

    Worker.prototype.postMessage = function (msg, transfer) {
        try {
            if (msg && msg.type === 'authorize' && msg.hostname && msg.signature) {
                // Send auth data to the content script via CustomEvent
                window.dispatchEvent(new CustomEvent('__meshy_auth__', {
                    detail: JSON.stringify({
                        hostname: msg.hostname,
                        timestamp: msg.timestamp,
                        signature: msg.signature
                    })
                }));
                console.log('[Meshy DL] ✓ WASM auth intercepted:', msg.hostname);
            }
        } catch (e) {
            console.error('[Meshy DL] Hook error:', e);
        }
        return _origPostMessage.call(this, msg, transfer);
    };

    console.log('[Meshy DL] ✓ Worker.postMessage hook installed (MAIN world)');
})();
