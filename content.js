// content.js
if (globalThis.__meshyDownloaderContentVersion !== '1.4.1') {
globalThis.__meshyDownloaderContentVersion = '1.4.1';

// ===== TOKEN EXTRACTION FROM COOKIES =====

let pageBearerToken = null;

function isUsableToken(token) {
  if (!token || typeof token !== 'string') return false;
  try {
    const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(encoded));
    return !payload.exp || payload.exp * 1000 > Date.now() + 30000;
  } catch (_) {
    return true;
  }
}

function extractTokenFromCookies() {
  let token = null;

  try {
    const cookies = document.cookie.split(';');
    let authTokenPart0 = null;
    let authTokenPart1 = null;

    for (let cookie of cookies) {
      const separatorIndex = cookie.indexOf('=');
      if (separatorIndex === -1) continue;

      const name = cookie.slice(0, separatorIndex);
      const value = decodeURIComponent(cookie.slice(separatorIndex + 1).trim());
      const trimmedName = name.trim();

      if (trimmedName.endsWith('auth-token.0')) {
        authTokenPart0 = value.trim();
      }
      if (trimmedName.endsWith('auth-token.1')) {
        authTokenPart1 = value.trim();
      }
    }

    if (authTokenPart0 && authTokenPart1) {
      let part0 = authTokenPart0;
      if (part0.startsWith('base64-')) {
        part0 = part0.substring(7);
      }

      const combined = part0 + authTokenPart1;

      try {
        const decoded = atob(combined);
        const parsed = JSON.parse(decoded);

        if (isUsableToken(parsed.access_token)) {
          token = parsed.access_token;
          console.log('✓ TOKEN FOUND FROM COOKIES');
        }
      } catch (e) {
        console.error('❌ Decode error:', e.message);
      }
    }
  } catch (e) {
    console.error('❌ Cookie error:', e.message);
  }

  return token;
}

window.addEventListener('__meshy_token__', (event) => {
  const token = typeof event.detail === 'string' ? event.detail : '';
  if (!isUsableToken(token)) return;
  pageBearerToken = token;
  chrome.runtime.sendMessage({ action: 'saveToken', token }).catch(() => {});
});

setTimeout(() => {
  const token = extractTokenFromCookies();
  if (token) {
    chrome.runtime.sendMessage({ action: 'saveToken', token: token });
  }
}, 1500);


// ===== FETCH INTERCEPTION FOR BEARER TOKEN =====

let tokenSaved = false;
const originalFetch = window.fetch;

window.fetch = function (...args) {
  const request = args[0];
  const options = args[1] || {};

  if (typeof request === 'string' && request.includes('api.meshy.ai')) {
    const authHeader = options.headers?.Authorization || options.headers?.authorization;

    if (authHeader && authHeader.startsWith('Bearer ') && !tokenSaved) {
      const token = authHeader.replace('Bearer ', '');
      chrome.runtime.sendMessage({ action: 'saveToken', token: token });
      tokenSaved = true;
      console.log('✓ TOKEN INTERCEPTED FROM FETCH');
    }
  }

  return originalFetch.apply(this, args);
};


// Auth hook is in main_world.js (registered with world: MAIN in manifest)


// ===== CONTENT SCRIPT: Auth Storage + Decrypt Worker =====

let wasmAuth = null;

// Listen for auth from main world
window.addEventListener('__meshy_auth__', (e) => {
  try {
    wasmAuth = JSON.parse(e.detail);
    console.log('✓ WASM auth credentials captured in content script');
    chrome.runtime.sendMessage({ action: 'saveWasmAuth', auth: wasmAuth });
  } catch (e) {
    console.error('Failed to parse WASM auth:', e);
  }
});


// ===== DECRYPT WORKER (runs in content script context) =====

let decryptWorker = null;
let workerReady = false;
let pendingOps = {};
let opCounter = 0;

function initDecryptWorker(authFromBackground = null) {
  return new Promise((resolve, reject) => {
    if (decryptWorker && workerReady) {
      resolve();
      return;
    }

    if (!wasmAuth && authFromBackground) {
      wasmAuth = authFromBackground;
    }

    if (!wasmAuth) {
      reject(new Error('This model is only available as an encrypted .meshy file. Open it in the Meshy 3D viewer once, wait for it to load, and retry.'));
      return;
    }

    const workerUrl = window.location.origin + '/resource/decrypt/loader-worker.js';
    console.log('[Meshy DL] Creating Worker from:', workerUrl);

    try {
      decryptWorker = new Worker(workerUrl);
    } catch (e) {
      console.error('[Meshy DL] Worker creation failed:', e);
      reject(new Error('Worker creation failed: ' + e.message));
      return;
    }

    decryptWorker.onmessage = (e) => {
      const msg = e.data;
      console.log('[Meshy DL] Worker message:', msg.type);

      if (msg.type === 'loaded') {
        console.log('[Meshy DL] WASM loaded, authorizing...');
        decryptWorker.postMessage({
          type: 'authorize',
          hostname: wasmAuth.hostname,
          timestamp: wasmAuth.timestamp,
          signature: wasmAuth.signature
        });
      } else if (msg.type === 'ready') {
        console.log('[Meshy DL] ✓ Worker authorized and ready');
        workerReady = true;
        resolve();
      } else if (msg.type === 'auth_error') {
        console.error('[Meshy DL] Auth error:', msg.error);
        reject(new Error('WASM auth failed: ' + msg.error));
      } else if (msg.type === 'error') {
        console.error('[Meshy DL] Worker error:', msg.error);
        reject(new Error('Worker error: ' + msg.error));
      } else if (msg.type === 'process') {
        const op = pendingOps[msg.id];
        if (op) {
          if (msg.success) {
            op.resolve(msg.data);
          } else {
            if (msg.error === 'auth_expired') {
              workerReady = false;
              decryptWorker.terminate();
              decryptWorker = null;
            }
            op.reject(new Error(msg.error));
          }
          delete pendingOps[msg.id];
        }
      }
    };

    decryptWorker.onerror = (e) => {
      console.error('[Meshy DL] Worker error event:', e);
      reject(new Error('Worker load failed'));
    };
  });
}

function bufferStartsWith(data, text) {
  if (data.byteLength < text.length) return false;
  const bytes = new Uint8Array(data, 0, text.length);
  return text.split('').every((char, index) => bytes[index] === char.charCodeAt(0));
}

async function decryptAndDownload(modelUrl, filename, requestId, authFromBackground = null, format = 'glb', targetHeightMm = null, bearerToken = null) {
  try {
    console.log('[Meshy DL] Starting decrypt for:', requestId);
    let encrypted = isEncryptedModelUrl(modelUrl);

    // Step 2: Fetch .meshy file
    chrome.runtime.sendMessage({ action: 'decryptStatus', requestId, status: 'fetching' });
    console.log('[Meshy DL] Fetching .meshy file...');

    const assetUrl = new URL(modelUrl, location.href);
    const plainFetchOptions = { credentials: 'omit', cache: 'no-store' };
    let response;

    try {
      if (bearerToken && assetUrl.hostname === 'api.meshy.ai') {
        try {
          response = await fetch(assetUrl.href, {
            ...plainFetchOptions,
            headers: { Authorization: `Bearer ${bearerToken}` }
          });
        } catch (_) {
          // Some signed Meshy URLs reject custom headers during the CORS preflight.
          response = await fetch(assetUrl.href, plainFetchOptions);
        }
      } else {
        // Signed CDN/storage URLs must not receive Meshy cookies or custom headers.
        response = await fetch(assetUrl.href, plainFetchOptions);
      }
    } catch (_) {
      throw new Error("The browser could not fetch this model file. Reopen the model in Meshy's 3D viewer, wait until it loads, then try again.");
    }
    if (!response.ok) throw new Error('Fetch failed: ' + response.status);
    const sourceData = await response.arrayBuffer();
    console.log('[Meshy DL] Got', sourceData.byteLength, 'bytes');

    const sourceIsGlb = bufferStartsWith(sourceData, 'glTF');
    const sourceIsMeshy = bufferStartsWith(sourceData, 'MESHY.AI');
    if (encrypted && sourceIsGlb) encrypted = false;
    if (encrypted && !sourceIsMeshy) {
      throw new Error('Meshy returned an expired or invalid model file. Reopen this model in the 3D viewer, wait until it loads, press Fetch Models again, then retry the download.');
    }
    if (encrypted) await initDecryptWorker(authFromBackground);

    // Step 3: Decrypt
    chrome.runtime.sendMessage({ action: 'decryptStatus', requestId, status: 'decrypting' });
    console.log('[Meshy DL] Decrypting...');

    let glbData = sourceData;
    if (encrypted) {
      const id = ++opCounter;
      glbData = await new Promise((resolve, reject) => {
        pendingOps[id] = { resolve, reject };
        decryptWorker.postMessage({ id, type: 'process', data: sourceData }, [sourceData]);
      });
    }
    console.log('[Meshy DL] ✓ Decrypted to', glbData.byteLength, 'bytes');

    // Step 4: Keep the original GLB or convert its triangle geometry to STL.
    const outputData = format === 'stl' ? glbToBinaryStl(glbData, targetHeightMm) : glbData;
    const mimeType = format === 'stl' ? 'model/stl' : 'model/gltf-binary';
    const blob = new Blob([outputData], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);

    chrome.runtime.sendMessage({ action: 'decryptStatus', requestId, status: 'done' });
    console.log('[Meshy DL] ✓ Download triggered:', filename);
  } catch (err) {
    console.error('[Meshy DL] Decrypt failed:', err);
    chrome.runtime.sendMessage({ action: 'decryptStatus', requestId, status: 'error', error: err.message });
    throw err;
  }
}

// Handle messages from background
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getFreshToken') {
    const token = pageBearerToken || extractTokenFromCookies();
    sendResponse(token
      ? { success: true, token }
      : { success: false, error: 'No current Meshy token was found in this tab.' });
    return;
  }

  if (request.action === 'meshyDownloaderPing') {
    sendResponse({ success: true, hasWasmAuth: Boolean(wasmAuth) });
    return;
  }

  if (request.action === 'processAndDownload' || request.action === 'decryptAndDownload') {
    console.log('[Meshy DL] Received decrypt request:', request.requestId);
    decryptAndDownload(
      request.modelUrl,
      request.filename,
      request.requestId,
      request.wasmAuth,
      request.format,
      request.targetHeightMm,
      request.bearerToken
    ).then(() => sendResponse({ success: true })).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }
});

function isEncryptedModelUrl(value) {
  try {
    return new URL(value).pathname.toLowerCase().endsWith('.meshy');
  } catch (_) {
    return /\.meshy(?:[?#]|$)/i.test(String(value));
  }
}

function glbToBinaryStl(glbData, targetHeightMm = null) {
  const view = new DataView(glbData);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) {
    throw new Error('The decrypted model is not a valid GLB 2.0 file.');
  }

  let offset = 12;
  let json = null;
  let binary = null;
  while (offset + 8 <= view.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const bytes = glbData.slice(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(bytes));
    if (type === 0x004e4942) binary = bytes;
    offset += 8 + length;
  }
  if (!json || !binary) throw new Error('The GLB has no readable geometry.');

  const component = {
    5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2],
    5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4]
  };
  const dimensions = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

  function readAccessor(index) {
    const accessor = json.accessors[index];
    const bufferView = json.bufferViews[accessor.bufferView];
    const [Ctor, bytesPerComponent] = component[accessor.componentType];
    const size = dimensions[accessor.type];
    if (!Ctor || !size || accessor.sparse) throw new Error('Unsupported GLB accessor.');
    const start = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
    const stride = bufferView.byteStride || size * bytesPerComponent;
    const dataView = new DataView(binary, start, bufferView.byteLength - (accessor.byteOffset || 0));
    const getter = accessor.componentType === 5126 ? 'getFloat32'
      : accessor.componentType === 5125 ? 'getUint32'
      : accessor.componentType === 5123 ? 'getUint16'
      : accessor.componentType === 5122 ? 'getInt16'
      : accessor.componentType === 5121 ? 'getUint8' : 'getInt8';
    const values = [];
    for (let i = 0; i < accessor.count; i++) {
      const row = [];
      for (let c = 0; c < size; c++) row.push(dataView[getter](i * stride + c * bytesPerComponent, true));
      values.push(size === 1 ? row[0] : row);
    }
    return values;
  }

  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const multiply = (a, b) => {
    const out = new Array(16).fill(0);
    for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
    return out;
  };
  function nodeMatrix(node) {
    if (node.matrix) return node.matrix;
    const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale || [1, 1, 1];
    const [tx, ty, tz] = node.translation || [0, 0, 0];
    return [
      (1-2*y*y-2*z*z)*sx, (2*x*y+2*z*w)*sx, (2*x*z-2*y*w)*sx, 0,
      (2*x*y-2*z*w)*sy, (1-2*x*x-2*z*z)*sy, (2*y*z+2*x*w)*sy, 0,
      (2*x*z+2*y*w)*sz, (2*y*z-2*x*w)*sz, (1-2*x*x-2*y*y)*sz, 0,
      tx, ty, tz, 1
    ];
  }
  const transform = (p, m) => [
    m[0]*p[0] + m[4]*p[1] + m[8]*p[2] + m[12],
    m[1]*p[0] + m[5]*p[1] + m[9]*p[2] + m[13],
    m[2]*p[0] + m[6]*p[1] + m[10]*p[2] + m[14]
  ];

  const triangles = [];
  function visit(nodeIndex, parentMatrix) {
    const node = json.nodes[nodeIndex];
    const matrix = multiply(parentMatrix, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const primitive of json.meshes[node.mesh].primitives || []) {
        if (primitive.mode !== undefined && primitive.mode !== 4) continue;
        const positions = readAccessor(primitive.attributes.POSITION);
        const indices = primitive.indices !== undefined
          ? readAccessor(primitive.indices) : positions.map((_, i) => i);
        for (let i = 0; i + 2 < indices.length; i += 3) {
          triangles.push(indices.slice(i, i + 3).map(index => transform(positions[index], matrix)));
        }
      }
    }
    for (const child of node.children || []) visit(child, matrix);
  }
  const scene = json.scenes?.[json.scene || 0];
  for (const node of scene?.nodes || json.nodes.map((_, i) => i)) visit(node, identity);
  if (!triangles.length) throw new Error('No triangle mesh was found for STL conversion.');

  if (Number.isFinite(targetHeightMm) && targetHeightMm > 0) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const triangle of triangles) for (const point of triangle) for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
    const modelHeight = max[1] - min[1];
    if (modelHeight > 0) {
      const resize = targetHeightMm / modelHeight;
      for (const triangle of triangles) for (const point of triangle)
        for (let axis = 0; axis < 3; axis++) point[axis] *= resize;
    }
  }

  const output = new ArrayBuffer(84 + triangles.length * 50);
  const stl = new DataView(output);
  stl.setUint32(80, triangles.length, true);
  let cursor = 84;
  for (const triangle of triangles) {
    const [a, b, c] = triangle;
    const ab = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
    const ac = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
    let normal = [ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]];
    const length = Math.hypot(...normal) || 1;
    normal = normal.map(value => value / length);
    for (const value of [...normal, ...a, ...b, ...c]) { stl.setFloat32(cursor, value, true); cursor += 4; }
    stl.setUint16(cursor, 0, true); cursor += 2;
  }
  return output;
}
}
