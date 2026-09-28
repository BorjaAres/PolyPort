(function () {
  'use strict';

  const MARKER = '__polyport_tripo_v1__';
  const models = [];
  const seenResources = new Set();
  const externalBuffers = new Map();
  let captureNotice = '';
  let pendingViewerStl = null;

  function safeName(value, fallback) {
    let name = String(value || '').replace(/\\/g, '/').split('/').pop().trim();
    name = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').replace(/\s+/g, ' ').slice(0, 120);
    if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) return fallback;
    return name;
  }

  function canonicalResourceUrl(value, base = location.href) {
    try {
      const url = new URL(String(value || ''), base);
      url.hash = '';
      return url.href;
    } catch (_) { return String(value || ''); }
  }

  function decodeDataUri(uri) {
    const comma = uri.indexOf(',');
    if (comma < 0) throw new Error('The GLB contains an invalid data URI buffer.');
    const metadata = uri.slice(0, comma);
    const payload = uri.slice(comma + 1);
    if (/;base64/i.test(metadata)) {
      const raw = atob(decodeURIComponent(payload).replace(/\s/g, ''));
      const bytes = new Uint8Array(raw.length);
      for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
      return bytes.buffer;
    }
    const decoded = decodeURIComponent(payload);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index) & 0xff;
    return bytes.buffer;
  }

  function resolveGlbBuffers(json, embeddedBinary, modelUrl) {
    const definitions = Array.isArray(json.buffers) && json.buffers.length ? json.buffers : [{}];
    const referencedCount = (json.bufferViews || []).reduce((count, view) => Math.max(count, (view?.buffer ?? 0) + 1), 0);
    const buffers = new Array(Math.max(definitions.length, referencedCount));
    const embeddedCandidates = definitions
      .map((definition, index) => ({ definition: definition || {}, index }))
      .filter(({ definition }) => typeof definition.uri !== 'string' || !definition.uri.trim());
    const sizeMatch = embeddedCandidates.find(({ definition }) => {
      const declared = Number(definition.byteLength);
      const padding = embeddedBinary.byteLength - declared;
      return Number.isInteger(declared) && declared >= 0 && padding >= 0 && padding <= 3;
    });
    const embeddedIndex = sizeMatch?.index ?? embeddedCandidates[0]?.index;
    for (let index = 0; index < definitions.length; index++) {
      const definition = definitions[index] || {};
      const uri = typeof definition.uri === 'string' ? definition.uri.trim() : '';
      if (uri) {
        if (/^data:/i.test(uri)) {
          buffers[index] = decodeDataUri(uri);
        } else {
          const key = canonicalResourceUrl(uri, modelUrl || location.href);
          buffers[index] = externalBuffers.get(key);
        }
      } else if (index === embeddedIndex) {
        // A GLB BIN chunk backs one buffer only. Tripo's meshopt exports can
        // include a larger URI-less placeholder buffer for decoded fallback
        // views; treating that placeholder as the BIN shifts its byte ranges.
        buffers[index] = embeddedBinary;
      }
    }
    if (embeddedIndex !== undefined) {
      for (const view of json.bufferViews || []) {
        const index = view?.buffer ?? 0;
        if (index >= definitions.length && buffers[index] === undefined) buffers[index] = embeddedBinary;
      }
    }
    return buffers;
  }

  async function decodeMeshoptViews(json, buffers) {
    const compressed = (json.bufferViews || []).map((view, index) => ({
      index,
      data: view?.extensions?.EXT_meshopt_compression || view?.extensions?.KHR_meshopt_compression
    })).filter((item) => item.data);
    if (!compressed.length) return new Map();
    if (typeof MeshoptDecoder === 'undefined' || !MeshoptDecoder.supported) {
      throw new Error('This model uses meshopt-compressed geometry, but its decoder is unavailable. Reload PolyPort and the Tripo tab.');
    }
    await MeshoptDecoder.ready;
    const decoded = new Map();
    for (const { index, data } of compressed) {
      const sourceBuffer = buffers[data.buffer ?? 0];
      const offset = Number(data.byteOffset || 0);
      const length = Number(data.byteLength);
      const count = Number(data.count);
      const stride = Number(data.byteStride);
      const outputLength = count * stride;
      if (!(sourceBuffer instanceof ArrayBuffer) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || !Number.isSafeInteger(count) || !Number.isSafeInteger(stride) || !Number.isSafeInteger(outputLength) || offset < 0 || length <= 0 || count <= 0 || stride <= 0 || offset + length > sourceBuffer.byteLength) {
        throw new Error(`Meshopt buffer view ${index} has invalid source bounds or decode dimensions.`);
      }
      const target = new Uint8Array(outputLength);
      const source = new Uint8Array(sourceBuffer, offset, length);
      MeshoptDecoder.decodeGltfBuffer(target, count, stride, source, data.mode, data.filter || 'NONE');
      decoded.set(index, target.buffer);
    }
    return decoded;
  }

  function startDownload(name, output) {
    const blob = new Blob([output.buffer], { type: output.mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${name}.${output.extension}`;
    anchor.style.display = 'none';
    document.documentElement.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return anchor.download;
  }

  function finishPendingViewerStl(model) {
    const pending = pendingViewerStl;
    if (!pending || model.source !== 'viewer') return;
    pendingViewerStl = null;
    try {
      let partId = 'all';
      if (pending.partLabel) {
        const match = model.parts.find((part) => part.label.trim().toLowerCase() === pending.partLabel.trim().toLowerCase());
        if (!match) throw new Error(`Could not find part "${pending.partLabel}" in the viewer. Select it again or use the full model.`);
        partId = match.id;
      }
      void glbToBinaryStl(model.buffer, pending.heightMm, partId, model.url).then((output) => {
        const filename = startDownload(pending.filename, output);
        pending.sendResponse({ ok: true, filename });
      }).catch((error) => {
        pending.sendResponse({ ok: false, error: `Could not convert the GLB or extract an STL from the viewer: ${error?.message || 'unknown error'}` });
      });
    } catch (error) {
      pending.sendResponse({ ok: false, error: `Could not convert the GLB or extract an STL from the viewer: ${error?.message || 'unknown error'}` });
    }
  }

  function failPendingViewerStl(reason) {
    if (!pendingViewerStl) return;
    const pending = pendingViewerStl;
    pendingViewerStl = null;
    pending.sendResponse({ ok: false, error: `${reason} The original GLB error was: ${pending.originalError}` });
  }

  async function captureViewerPreview() {
    let canvases = [];
    const deadline = Date.now() + 8_000;
    while (!canvases.length && Date.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      canvases = [...document.querySelectorAll('canvas')]
        .map((canvas) => ({ canvas, rect: canvas.getBoundingClientRect() }))
        .filter(({ canvas, rect }) => rect.width >= 120 && rect.height >= 120 && canvas.width >= 120 && canvas.height >= 120)
        .sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
      if (!canvases.length) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!canvases.length) throw new Error('Could not find the viewer canvas. Open a model and wait for it to appear.');

    const source = canvases[0].canvas;
    const ratio = Math.min(1, 480 / Math.max(source.width, source.height));
    const preview = document.createElement('canvas');
    preview.width = Math.max(1, Math.round(source.width * ratio));
    preview.height = Math.max(1, Math.round(source.height * ratio));
    const context = preview.getContext('2d');
    if (!context) throw new Error('The browser could not prepare the preview image.');
    context.fillStyle = '#f3f0e8';
    context.fillRect(0, 0, preview.width, preview.height);
    context.drawImage(source, 0, 0, preview.width, preview.height);
    return preview.toDataURL('image/jpeg', 0.84);
  }

  function glbJson(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 20) return null;
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) return null;
    let offset = 12;
    while (offset + 8 <= view.byteLength) {
      const length = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (length < 0 || start + length > view.byteLength) return null;
      if (type === 0x4e4f534a) {
        try {
          return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, length)).replace(/[\u0000\u0020]+$/g, ''));
        } catch (_) { return null; }
      }
      offset = start + length;
    }
    return null;
  }

  function glbParts(buffer) {
    const json = glbJson(buffer);
    if (!json) return [];
    const parts = [];
    (json.nodes || []).forEach((node, nodeIndex) => {
      if (!Number.isInteger(node.mesh) || !json.meshes?.[node.mesh]) return;
      const mesh = json.meshes[node.mesh];
      const primitives = mesh.primitives || [];
      const label = node.name || mesh.name || `Part ${parts.length + 1}`;
      parts.push({
        id: `node:${nodeIndex}`,
        label: String(label).slice(0, 100),
        triangles: primitives.reduce((sum, primitive) => {
          const accessor = json.accessors?.[primitive.indices ?? primitive.attributes?.POSITION];
          if (!accessor) return sum;
          const count = accessor.count || 0;
          const mode = primitive.mode ?? 4;
          return sum + (mode === 4 ? Math.floor(count / 3) : Math.max(0, count - 2));
        }, 0)
      });
    });
    return parts;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== MARKER) return;
    if (event.data.type === 'CAPTURED_BUFFER' && event.data.buffer instanceof ArrayBuffer) {
      const key = canonicalResourceUrl(event.data.url);
      if (key) {
        externalBuffers.delete(key);
        externalBuffers.set(key, event.data.buffer);
        while (externalBuffers.size > 48) externalBuffers.delete(externalBuffers.keys().next().value);
      }
      return;
    }
    if (event.data.type === 'CAPTURE_FAILED') {
      captureNotice = 'Tripo started its regular download, but PolyPort could not read the file to prepare it.';
      notifyPopup({ type: 'TRIPO_CAPTURE_FAILED' });
      return;
    }
    if (event.data.type === 'VIEWER_SCAN_FAILED') {
      captureNotice = event.data.error || 'Could not read the viewer scene.';
      failPendingViewerStl(`Could not recover geometry from the viewer (${captureNotice}).`);
      notifyPopup({ type: 'TRIPO_CAPTURE_FAILED' });
      return;
    }
    if (event.data.type === 'VIEWER_SCAN_DONE') {
      captureNotice = event.data.textureWarnings?.length
        ? `Model captured, but ${event.data.textureWarnings.length} texture(s) could not be read.`
        : '';
      notifyPopup({ type: 'TRIPO_VIEWER_SCAN_DONE', notice: captureNotice });
      return;
    }
    if (event.data.type !== 'CAPTURED_EXPORT' || !(event.data.buffer instanceof ArrayBuffer)) return;
    captureNotice = '';

    const ext = String(event.data.format || '').toLowerCase();
    const source = event.data.sourceKind || 'network';
    const resourceKey = source === 'network' && event.data.url
      ? `${String(event.data.url)}|${event.data.buffer.byteLength}|${ext}`
      : '';
    if (resourceKey && seenResources.has(resourceKey)) return;
    if (resourceKey) seenResources.add(resourceKey);
    const base = safeName(event.data.filename, `tripo_model.${ext}`);
    const filename = /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${ext}`;
    const model = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filename,
      format: ext,
      mime: event.data.mime || 'application/octet-stream',
      source,
      url: event.data.url || '',
      capturedAt: Number(event.data.capturedAt) || Date.now(),
      buffer: event.data.buffer,
      parts: ext === 'glb' ? glbParts(event.data.buffer) : []
    };

    models.unshift(model);
    finishPendingViewerStl(model);
    notifyPopup({ type: 'TRIPO_MODEL_CAPTURED', model: publicModel(model) });
  });

  function publicModel(model) {
    return {
      id: model.id,
      filename: model.filename,
      format: model.format,
      mime: model.mime,
      source: model.source,
      size: model.buffer.byteLength,
      capturedAt: model.capturedAt,
      parts: model.parts
    };
  }

  function notifyPopup(message) {
    try {
      chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; });
    } catch (_) {}
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'TRIPO_GET_MODELS') {
      sendResponse({ ok: true, models: models.map(publicModel), notice: captureNotice });
      return false;
    }

    if (message?.type === 'TRIPO_SCAN_VIEWER') {
      captureNotice = '';
      window.postMessage({ source: MARKER, type: 'SCAN_VIEWER' }, location.origin);
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === 'TRIPO_CAPTURE_PREVIEW') {
      void captureViewerPreview().then(
        (image) => sendResponse({ ok: true, image }),
        (error) => sendResponse({ ok: false, error: error?.message || 'Could not capture the preview.' })
      );
      return true;
    }

    if (message?.type === 'TRIPO_DOWNLOAD') {
      const model = models.find((item) => item.id === message.id);
      if (!model) {
        sendResponse({ ok: false, error: 'This file is no longer in memory. Capture it again from Tripo.' });
        return false;
      }
      const name = safeName(message.filename, 'tripo_model');
      if (message.format === 'stl') {
        void glbToBinaryStl(model.buffer, Number(message.heightMm), message.partId || 'all', model.url).then((output) => {
          sendResponse({ ok: true, filename: startDownload(name, output) });
        }).catch((error) => {
          if (model.format === 'glb' && model.source !== 'viewer' && !pendingViewerStl) {
            const requestedPart = model.parts.find((part) => part.id === (message.partId || 'all'));
            pendingViewerStl = {
              filename: name,
              heightMm: Number(message.heightMm),
              partLabel: requestedPart?.label || '',
              originalError: error?.message || 'unsupported GLB format',
              sendResponse
            };
            notifyPopup({ type: 'TRIPO_STL_VIEWER_FALLBACK' });
            window.postMessage({ source: MARKER, type: 'SCAN_VIEWER' }, location.origin);
          } else {
            sendResponse({ ok: false, error: error?.message || 'Could not prepare the file.' });
          }
        });
        return true;
      }

      try {
        const output = { buffer: model.buffer, mime: model.mime, extension: model.format };
        sendResponse({ ok: true, filename: startDownload(name, output) });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || 'Could not prepare the file.' });
      }
      return false;
    }
    return false;
  });

  const COMPONENTS = {
    5120: { bytes: 1, get: (view, offset) => view.getInt8(offset), max: 127, signed: true },
    5121: { bytes: 1, get: (view, offset) => view.getUint8(offset), max: 255, signed: false },
    5122: { bytes: 2, get: (view, offset) => view.getInt16(offset, true), max: 32767, signed: true },
    5123: { bytes: 2, get: (view, offset) => view.getUint16(offset, true), max: 65535, signed: false },
    5125: { bytes: 4, get: (view, offset) => view.getUint32(offset, true), max: 4294967295, signed: false },
    5126: { bytes: 4, get: (view, offset) => view.getFloat32(offset, true), max: 1, signed: false }
  };
  const WIDTHS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

  function parseGlb(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 20) throw new Error('The file is too small to be a GLB.');
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) throw new Error('The captured file is not a GLB 2.0.');
    let offset = 12;
    let json = null;
    let binary = null;
    while (offset + 8 <= view.byteLength) {
      const length = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (start + length > view.byteLength) throw new Error('The GLB is incomplete or damaged.');
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, length)).replace(/[\u0000\u0020]+$/g, ''));
      if (type === 0x004e4942) binary = buffer.slice(start, start + length);
      offset = start + length;
    }
    if (!json) throw new Error('The GLB does not contain a recognizable JSON chunk.');
    return { json, binary: binary || new ArrayBuffer(0) };
  }

  function accessor(json, buffers, decodedViews, index) {
    const item = json.accessors?.[index];
    if (!item || item.sparse) throw new Error('This model uses a GLB geometry type that PolyPort cannot yet convert to STL.');
    const view = json.bufferViews?.[item.bufferView];
    const component = COMPONENTS[item.componentType];
    const width = WIDTHS[item.type];
    if (!view || !component || !width) throw new Error('The GLB contains an unsupported accessor.');
    const itemSize = width * component.bytes;
    const stride = view.byteStride || itemSize;
    if (!Number.isInteger(item.count) || item.count < 0 || stride < itemSize) throw new Error(`Accessor ${index} has invalid count or stride values.`);
    const bufferIndex = view.buffer ?? 0;
    const decoded = decodedViews.get(item.bufferView);
    const binary = decoded || buffers[bufferIndex];
    if (!(binary instanceof ArrayBuffer)) {
      const uri = json.buffers?.[bufferIndex]?.uri;
      throw new Error(`Accessor ${index} refers to GLB buffer ${bufferIndex}${uri ? ` (${uri})` : ''}, but that buffer was not found among Tripo's loaded resources.`);
    }
    const relativeEnd = (item.byteOffset || 0) + Math.max(0, item.count - 1) * stride + itemSize;
    const start = (decoded ? 0 : (view.byteOffset || 0)) + (item.byteOffset || 0);
    if (relativeEnd > view.byteLength || start + Math.max(0, item.count - 1) * stride + itemSize > binary.byteLength) {
      throw new Error(`GLB accessor ${index} is out of range (view ${item.bufferView}: offset ${item.byteOffset || 0}, count ${item.count}, stride ${stride}, view size ${view.byteLength}, binary size ${binary.byteLength}).`);
    }
    const data = new DataView(binary);
    return {
      count: item.count,
      width,
      get(row, col = 0) {
        if (row < 0 || row >= item.count || col < 0 || col >= width) throw new Error('The GLB contains invalid vertex indices.');
        let value = component.get(data, start + row * stride + col * component.bytes);
        if (item.normalized && item.componentType !== 5126) {
          value = component.signed ? Math.max(value / component.max, -1) : value / component.max;
        }
        return value;
      }
    };
  }

  function nodeMatrix(node) {
    if (node.matrix?.length === 16) return node.matrix;
    const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale || [1, 1, 1];
    const [tx, ty, tz] = node.translation || [0, 0, 0];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    return [
      (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
      (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
      (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
      tx, ty, tz, 1
    ];
  }

  function multiply(a, b) {
    const out = new Array(16).fill(0);
    for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
    return out;
  }

  function point(p, matrix) {
    return [
      matrix[0] * p[0] + matrix[4] * p[1] + matrix[8] * p[2] + matrix[12],
      matrix[1] * p[0] + matrix[5] * p[1] + matrix[9] * p[2] + matrix[13],
      matrix[2] * p[0] + matrix[6] * p[1] + matrix[10] * p[2] + matrix[14]
    ];
  }

  function sceneRoots(json) {
    const scene = json.scenes?.[json.scene ?? 0];
    if (scene?.nodes?.length) return scene.nodes;
    const children = new Set((json.nodes || []).flatMap((node) => node.children || []));
    return (json.nodes || []).map((_, index) => index).filter((index) => !children.has(index));
  }

  function visitTriangles(json, buffers, decodedViews, partId, callback) {
    const roots = sceneRoots(json);
    const selectedNode = String(partId).startsWith('node:') ? Number(String(partId).slice(5)) : null;

    function visit(nodeIndex, parentMatrix, inPart) {
      const node = json.nodes?.[nodeIndex];
      if (!node) return;
      const matrix = multiply(parentMatrix, nodeMatrix(node));
      const inside = inPart || nodeIndex === selectedNode;
      if ((selectedNode === null || inside) && node.mesh !== undefined) {
        const mesh = json.meshes?.[node.mesh];
        for (const primitive of mesh?.primitives || []) {
          const positionIndex = primitive.attributes?.POSITION;
          if (positionIndex === undefined) continue;
          const positions = accessor(json, buffers, decodedViews, positionIndex);
          const indices = primitive.indices === undefined ? null : accessor(json, buffers, decodedViews, primitive.indices);
          const count = indices ? indices.count : positions.count;
          const mode = primitive.mode ?? 4;
          const getIndex = (i) => indices ? indices.get(i) : i;
          const emit = (a, b, c) => {
            const pa = point([positions.get(a, 0), positions.get(a, 1), positions.get(a, 2)], matrix);
            const pb = point([positions.get(b, 0), positions.get(b, 1), positions.get(b, 2)], matrix);
            const pc = point([positions.get(c, 0), positions.get(c, 1), positions.get(c, 2)], matrix);
            if ([...pa, ...pb, ...pc].some((value) => !Number.isFinite(value))) throw new Error('The model contains invalid vertices.');
            callback(pa, pb, pc);
          };
          if (mode === 4) {
            for (let i = 0; i + 2 < count; i += 3) emit(getIndex(i), getIndex(i + 1), getIndex(i + 2));
          } else if (mode === 5) {
            for (let i = 0; i + 2 < count; i++) i % 2 ? emit(getIndex(i + 1), getIndex(i), getIndex(i + 2)) : emit(getIndex(i), getIndex(i + 1), getIndex(i + 2));
          } else if (mode === 6) {
            for (let i = 1; i + 1 < count; i++) emit(getIndex(0), getIndex(i), getIndex(i + 1));
          }
        }
      }
      for (const child of node.children || []) visit(child, matrix, inside);
    }

    for (const root of roots) visit(root, identity(), false);
  }

  function identity() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }

  async function glbToBinaryStl(glbData, targetHeightMm, partId, modelUrl) {
    const { json, binary } = parseGlb(glbData);
    const buffers = resolveGlbBuffers(json, binary, modelUrl);
    const decodedViews = await decodeMeshoptViews(json, buffers);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let triangles = 0;
    visitTriangles(json, buffers, decodedViews, partId, (a, b, c) => {
      triangles++;
      for (const p of [a, b, c]) for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], p[axis]); max[axis] = Math.max(max[axis], p[axis]); }
    });
    if (!triangles) throw new Error('No triangles were found in the model or selected part.');
    const scale = Number.isFinite(targetHeightMm) && targetHeightMm > 0 && max[1] > min[1] ? targetHeightMm / (max[1] - min[1]) : 1;
    const output = new ArrayBuffer(84 + triangles * 50);
    const stl = new DataView(output);
    const header = new TextEncoder().encode('PolyPort 3D - binary STL');
    new Uint8Array(output, 0, header.length).set(header);
    stl.setUint32(80, triangles, true);
    let cursor = 84;
    visitTriangles(json, buffers, decodedViews, partId, (a, b, c) => {
      a = a.map((value) => value * scale); b = b.map((value) => value * scale); c = c.map((value) => value * scale);
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      let n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const length = Math.hypot(...n) || 1;
      n = n.map((value) => value / length);
      for (const value of [...n, ...a, ...b, ...c]) { stl.setFloat32(cursor, value, true); cursor += 4; }
      stl.setUint16(cursor, 0, true); cursor += 2;
    });
    return { buffer: output, mime: 'model/stl', extension: 'stl' };
  }

})();
