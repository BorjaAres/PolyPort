// Runs in Tripo Studio's page context to observe model resources already loaded
// by the viewer and, on request, serialize the visible Three.js scene as a GLB.
(function () {
  'use strict';

  if (window.__polyportTripoInstalled) return;
  window.__polyportTripoInstalled = true;

  const MARKER = '__polyport_tripo_v1__';
  const originalFetch = window.fetch;
  const supported = new Set(['glb', 'gltf', 'obj', 'stl', 'fbx', '3mf', 'usd', 'usdz']);
  let scanning = false;

  function extensionFrom(url, filename, mime) {
    const names = [filename || ''];
    try { names.push(new URL(url, location.href).pathname); } catch (_) { names.push(String(url || '')); }
    for (const name of names) {
      const match = String(name).match(/\.([a-z0-9]{2,5})(?:$|[?#])/i);
      if (match && supported.has(match[1].toLowerCase())) return match[1].toLowerCase();
    }
    const type = String(mime || '').toLowerCase();
    if (type.includes('gltf-binary') || type.includes('model/gltf-binary')) return 'glb';
    if (type.includes('gltf+json') || type.includes('model/gltf')) return 'gltf';
    if (type.includes('stl')) return 'stl';
    if (type.includes('obj')) return 'obj';
    return null;
  }

  function filenameFromDisposition(value) {
    if (!value) return '';
    const utf = value.match(/filename\*=UTF-8''([^;]+)/i);
    const basic = value.match(/filename\s*=\s*"?([^";]+)"?/i);
    try { return decodeURIComponent((utf && utf[1]) || (basic && basic[1]) || ''); }
    catch (_) { return (basic && basic[1]) || ''; }
  }

  function filenameFromUrl(url, ext) {
    try {
      const last = new URL(url, location.href).pathname.split('/').filter(Boolean).pop();
      if (last) return decodeURIComponent(last);
    } catch (_) {}
    return `tripo_model.${ext}`;
  }

  function publishBuffer(url, buffer, mime, filename, source) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) return false;
    const ext = extensionFrom(url, filename, mime);
    if (!ext) return false;
    window.postMessage({
      source: MARKER,
      type: 'CAPTURED_EXPORT',
      filename: filename || filenameFromUrl(url, ext),
      format: ext,
      mime: mime || 'application/octet-stream',
      url: String(url || ''),
      sourceKind: source || 'network',
      capturedAt: Date.now(),
      buffer
    }, location.origin, [buffer]);
    return true;
  }

  function isExternalBinary(url, filename, mime = '') {
    for (const name of [filename || '', url || '']) {
      try {
        const pathname = new URL(String(name), location.href).pathname;
        if (/\.(?:bin|buffer)$/i.test(pathname)) return true;
      } catch (_) {
        if (/\.(?:bin|buffer)(?:$|[?#])/i.test(String(name))) return true;
      }
    }
    return /^(?:application\/gltf-buffer|application\/octet-stream)(?:\s*;|$)/i.test(String(mime || ''));
  }

  function publishExternalBuffer(url, buffer) {
    if (!(buffer instanceof ArrayBuffer) || !buffer.byteLength) return false;
    window.postMessage({ source: MARKER, type: 'CAPTURED_BUFFER', url: String(url || ''), buffer }, location.origin, [buffer]);
    return true;
  }

  async function captureResponse(url, response) {
    if (!response || !response.ok) return;
    const resourceUrl = response.url || url;
    const mime = response.headers.get('content-type') || '';
    const filename = filenameFromDisposition(response.headers.get('content-disposition'));
    const ext = extensionFrom(resourceUrl, filename, mime);
    const externalBinary = !ext && isExternalBinary(resourceUrl, filename, mime);
    if (!ext && !externalBinary) return;
    try {
      const copy = await response.clone().arrayBuffer();
      if (ext) publishBuffer(resourceUrl, copy, mime, filename, 'network');
      else publishExternalBuffer(resourceUrl, copy);
    } catch (error) {
      console.debug('[PolyPort 3D: Tripo] Could not read a loaded model resource:', error);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== MARKER) return;
    if (event.data.type === 'SCAN_VIEWER') void captureViewerScene();
  });

  // Observe model files fetched by Tripo's own viewer. No export button, account
  // plan check, or extension-side quota is involved in this passive capture.
  window.fetch = function (...args) {
    const request = args[0];
    const url = typeof request === 'string' ? request : (request && request.url) || String(request || '');
    const promise = originalFetch.apply(this, args);
    return promise.then((response) => {
      void captureResponse(url, response);
      return response;
    });
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__tripoCompanionUrl = String(url || '');
    return originalOpen.call(this, method, url, ...rest);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', async () => {
      if (this.status < 200 || this.status >= 300) return;
      const url = this.responseURL || this.__tripoCompanionUrl || '';
      const mime = this.getResponseHeader('content-type') || '';
      const filename = filenameFromDisposition(this.getResponseHeader('content-disposition'));
      const ext = extensionFrom(url, filename, mime);
      const externalBinary = !ext && isExternalBinary(url, filename, mime);
      if (!ext && !externalBinary) return;
      try {
        const result = this.response instanceof ArrayBuffer
          ? this.response.slice(0)
          : this.response instanceof Blob
            ? await this.response.arrayBuffer()
            : typeof this.response === 'string'
              ? new TextEncoder().encode(this.response).buffer
              : this.response && typeof this.response === 'object'
                ? new TextEncoder().encode(JSON.stringify(this.response)).buffer
              : null;
        if (result) {
          if (ext) publishBuffer(url, result, mime, filename, 'network');
          else publishExternalBuffer(url, result);
        }
      } catch (error) {
        console.debug('[PolyPort 3D: Tripo] Could not read a loaded XHR model resource:', error);
      }
    }, { once: true });
    return originalSend.apply(this, args);
  };

  function sceneKeyScore(key) {
    const name = String(key).toLowerCase();
    if (/scene/.test(name)) return 10;
    if (/tres|three|renderer/.test(name)) return 9;
    if (/pinia|store|provide|context/.test(name)) return 8;
    if (/vue_app|instance|subtree|setup|proxy/.test(name)) return 7;
    if (/memoized|props|statenode|child|sibling|return|current|value|fiber/.test(name)) return 6;
    return 0;
  }

  function isTraversable(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Blob) return false;
    if (typeof Node !== 'undefined' && value instanceof Node) return false;
    return true;
  }

  function childObjects(value) {
    let keys;
    try { keys = Reflect.ownKeys(value); } catch (_) { return []; }
    keys.sort((a, b) => sceneKeyScore(b) - sceneKeyScore(a));
    const result = [];
    for (const key of keys.slice(0, Array.isArray(value) ? 120 : 300)) {
      try {
        const child = value[key];
        if (isTraversable(child)) result.push({ value: child, key: String(key) });
      } catch (_) {}
    }
    return result;
  }

  function findScene(start, budget) {
    if (!isTraversable(start)) return null;
    const seen = new WeakSet();
    const stack = [{ value: start, depth: 0 }];
    while (stack.length && budget.remaining > 0) {
      const { value, depth } = stack.pop();
      if (!isTraversable(value) || seen.has(value)) continue;
      seen.add(value);
      budget.remaining--;
      try { if (value.isScene === true && typeof value.traverse === 'function') return value; } catch (_) {}
      if (depth >= 20) continue;
      const children = childObjects(value);
      for (let index = children.length - 1; index >= 0; index--) stack.push({ value: children[index].value, depth: depth + 1 });
    }
    return null;
  }

  function findTresScene() {
    const roots = [];
    const add = (value) => { if (isTraversable(value)) roots.push(value); };
    try { add(window.__vue_app__); } catch (_) {}
    try { add(window.__NUXT__); } catch (_) {}

    for (const selector of ['#__nuxt', '#app', '[data-v-app]', '[data-reactroot]']) {
      const element = document.querySelector(selector);
      if (!element) continue;
      try { add(element.__vue_app__); } catch (_) {}
      try { add(element.__vueParentComponent); } catch (_) {}
      for (const key of Reflect.ownKeys(element)) {
        if (!/react(Fiber|Container|Props)|scene|three|tres|renderer|nuxt|vue/i.test(String(key))) continue;
        try { add(element[key]); } catch (_) {}
      }
    }

    for (const canvas of document.querySelectorAll('canvas')) {
      let element = canvas;
      for (let depth = 0; element && depth < 10; depth++, element = element.parentElement) {
        try { add(element.__vueParentComponent); } catch (_) {}
        for (const key of Reflect.ownKeys(element)) {
          if (!/react(Fiber|Container|Props)|scene|three|tres|renderer|nuxt|vue/i.test(String(key))) continue;
          try { add(element[key]); } catch (_) {}
        }
      }
    }

    let globalKeys = [];
    try { globalKeys = Object.keys(window).filter((key) => /^__(?:.*(?:tres|three|scene|renderer|pinia|vue|nuxt|reactfiber|reactcontainer))/i.test(key) || /^(?:THREE|scene|renderer|tres|pinia)$/i.test(key)); } catch (_) {}
    for (const key of globalKeys) {
      try { add(window[key]); } catch (_) {}
    }

    const seenRoots = new WeakSet();
    const budget = { remaining: 40_000 };
    for (const root of roots) {
      if (!isTraversable(root) || seenRoots.has(root)) continue;
      seenRoots.add(root);
      const scene = findScene(root, budget);
      if (scene) return scene;
      if (budget.remaining <= 0) break;
    }
    return null;
  }

  function collectMeshes(scene) {
    if (typeof scene.updateMatrixWorld === 'function') scene.updateMatrixWorld(true);
    const all = [];
    scene.traverse((object) => {
      if (!object?.isMesh || !object.geometry?.attributes?.position) return;
      if (object.geometry.attributes.position.count < 3) return;
      if (/^(ground|floor|grid|shadow|background|skybox|helper)(\b|[_ -])/i.test(object.name || '')) return;
      all.push(object);
    });

    // Tripo names its generated model roots tripo_node_*. Prefer those when
    // present so scene decorations are not mixed into the extracted model.
    const namedRoots = [];
    scene.traverse((object) => {
      if (/tripo_node/i.test(object.name || '')) namedRoots.push(object);
    });
    if (namedRoots.length) {
      const selected = new Set();
      for (const root of namedRoots) root.traverse((object) => { if (all.includes(object)) selected.add(object); });
      if (selected.size) return [...selected];
    }
    return all;
  }

  function textureSource(texture) {
    return texture?.image || texture?.source?.data || null;
  }

  async function texturePng(texture) {
    const image = textureSource(texture);
    if (!image || Array.isArray(image)) return null;
    const width = image.width || image.videoWidth || image.naturalWidth || 0;
    const height = image.height || image.videoHeight || image.naturalHeight || 0;
    if (!(width > 0 && height > 0)) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: false });
    if (!context) return null;
    if (image.data && ArrayBuffer.isView(image.data) && image.data.length >= width * height * 4) {
      context.putImageData(new ImageData(new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, width * height * 4), width, height), 0, 0);
    } else {
      context.drawImage(image, 0, 0, width, height);
    }
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Texture encoding failed')), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }

  function align4(length) { return (length + 3) & ~3; }

  async function serializeScene(scene) {
    const meshes = collectMeshes(scene);
    if (!meshes.length) throw new Error('Could not find 3D geometry in the viewer. Open a model and wait for it to finish loading.');

    const binaryParts = [];
    let binaryLength = 0;
    const bufferViews = [];
    const accessors = [];
    const materials = [];
    const materialMap = new Map();
    const images = [];
    const textures = [];
    const textureMap = new Map();
    const samplers = [];
    const nodes = [];
    const gltfMeshes = [];
    const textureWarnings = [];

    function appendData(bytes, target) {
      binaryLength = align4(binaryLength);
      const offset = binaryLength;
      binaryParts.push(bytes);
      binaryLength += bytes.byteLength;
      const view = { buffer: 0, byteOffset: offset, byteLength: bytes.byteLength };
      if (target) view.target = target;
      bufferViews.push(view);
      return bufferViews.length - 1;
    }

    function addAccessor(view, componentType, count, type, min, max) {
      const accessor = { bufferView: view, componentType, count, type };
      if (min) accessor.min = min;
      if (max) accessor.max = max;
      accessors.push(accessor);
      return accessors.length - 1;
    }

    async function addTexture(texture) {
      if (!texture) return undefined;
      if (textureMap.has(texture)) return textureMap.get(texture);
      try {
        const png = await texturePng(texture);
        if (!png) return undefined;
        const imageView = appendData(png);
        images.push({ bufferView: imageView, mimeType: 'image/png', name: texture.name || `Texture ${images.length + 1}` });
        const wrap = (value) => value === 1001 ? 33071 : value === 1002 ? 33648 : 10497;
        const sampler = {
          magFilter: texture.magFilter === 1003 ? 9728 : 9729,
          minFilter: texture.minFilter === 1003 ? 9728 : texture.minFilter === 1006 ? 9729 : texture.minFilter === 1004 ? 9984 : texture.minFilter === 1005 ? 9986 : texture.minFilter === 1007 ? 9985 : 9987,
          wrapS: wrap(texture.wrapS),
          wrapT: wrap(texture.wrapT)
        };
        samplers.push(sampler);
        textures.push({ sampler: samplers.length - 1, source: images.length - 1, name: texture.name || undefined });
        const index = textures.length - 1;
        textureMap.set(texture, index);
        return index;
      } catch (error) {
        textureWarnings.push(error?.message || 'a texture could not be read');
        return undefined;
      }
    }

    async function addMaterial(material) {
      if (!material) material = {};
      if (materialMap.has(material)) return materialMap.get(material);
      const color = material.color ? [material.color.r, material.color.g, material.color.b, Number.isFinite(material.opacity) ? material.opacity : 1] : [1, 1, 1, Number.isFinite(material.opacity) ? material.opacity : 1];
      const pbr = { baseColorFactor: color, metallicFactor: Number.isFinite(material.metalness) ? material.metalness : 0, roughnessFactor: Number.isFinite(material.roughness) ? material.roughness : 1 };
      const baseColorTexture = await addTexture(material.map);
      if (baseColorTexture !== undefined) {
        const info = { index: baseColorTexture };
        const texture = material.map;
        const offset = texture.offset || { x: 0, y: 0 };
        const repeat = texture.repeat || { x: 1, y: 1 };
        const rotation = texture.rotation || 0;
        if (offset.x || offset.y || repeat.x !== 1 || repeat.y !== 1 || rotation) {
          info.extensions = { KHR_texture_transform: { offset: [offset.x, offset.y], scale: [repeat.x, repeat.y], rotation } };
          jsonExtensionsUsed.add('KHR_texture_transform');
        }
        pbr.baseColorTexture = info;
      }
      const gltfMaterial = { name: material.name || `Material ${materials.length + 1}`, pbrMetallicRoughness: pbr, doubleSided: material.side === 2 };
      if (material.emissive) gltfMaterial.emissiveFactor = [material.emissive.r || 0, material.emissive.g || 0, material.emissive.b || 0];
      if (material.transparent || (Number.isFinite(material.opacity) && material.opacity < 1)) gltfMaterial.alphaMode = 'BLEND';
      else if (Number.isFinite(material.alphaTest) && material.alphaTest > 0) { gltfMaterial.alphaMode = 'MASK'; gltfMaterial.alphaCutoff = material.alphaTest; }
      materials.push(gltfMaterial);
      materialMap.set(material, materials.length - 1);
      return materials.length - 1;
    }

    function readAttribute(attribute, index, component) {
      if (typeof attribute.getX === 'function') return component === 0 ? attribute.getX(index) : component === 1 ? attribute.getY(index) : component === 2 ? attribute.getZ(index) : attribute.getW(index);
      const stride = attribute.itemSize || 3;
      return attribute.array[index * stride + component];
    }

    const jsonExtensionsUsed = new Set();
    for (const object of meshes) {
      const geometry = object.geometry;
      const position = geometry.attributes.position;
      const world = object.matrixWorld?.elements || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const worldDeterminant = world[0] * (world[5] * world[10] - world[9] * world[6]) - world[4] * (world[1] * world[10] - world[9] * world[2]) + world[8] * (world[1] * world[6] - world[5] * world[2]);
      const vertices = new Float32Array(position.count * 3);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < position.count; i++) {
        const x = readAttribute(position, i, 0), y = readAttribute(position, i, 1), z = readAttribute(position, i, 2);
        const point = [world[0] * x + world[4] * y + world[8] * z + world[12], world[1] * x + world[5] * y + world[9] * z + world[13], world[2] * x + world[6] * y + world[10] * z + world[14]];
        for (let axis = 0; axis < 3; axis++) { vertices[i * 3 + axis] = point[axis]; min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]); }
      }
      const positionView = appendData(new Uint8Array(vertices.buffer), 34962);
      const attributes = { POSITION: addAccessor(positionView, 5126, position.count, 'VEC3', min, max) };

      const normal = geometry.attributes.normal;
      if (normal && normal.count === position.count) {
        const normals = new Float32Array(normal.count * 3);
        const e = world;
        const a = e[0], b = e[4], c = e[8], d = e[1], f = e[5], g = e[9], h = e[2], j = e[6], k = e[10];
        const det = a * (f * k - g * j) - b * (d * k - g * h) + c * (d * j - f * h);
        if (Math.abs(det) > 1e-20) {
          const inv = 1 / det;
          const m = [(f * k - g * j) * inv, (g * h - d * k) * inv, (d * j - f * h) * inv, (c * j - b * k) * inv, (a * k - c * h) * inv, (b * h - a * j) * inv, (b * g - c * f) * inv, (c * d - a * g) * inv, (a * f - b * d) * inv];
          for (let i = 0; i < normal.count; i++) {
            const x = readAttribute(normal, i, 0), y = readAttribute(normal, i, 1), z = readAttribute(normal, i, 2);
            let nx = m[0] * x + m[1] * y + m[2] * z, ny = m[3] * x + m[4] * y + m[5] * z, nz = m[6] * x + m[7] * y + m[8] * z;
            const length = Math.hypot(nx, ny, nz) || 1;
            normals.set([nx / length, ny / length, nz / length], i * 3);
          }
          const normalView = appendData(new Uint8Array(normals.buffer), 34962);
          attributes.NORMAL = addAccessor(normalView, 5126, normal.count, 'VEC3');
        }
      }

      const uv = geometry.attributes.uv;
      if (uv && uv.count === position.count) {
        const uvs = new Float32Array(uv.count * 2);
        for (let i = 0; i < uv.count; i++) uvs.set([readAttribute(uv, i, 0), readAttribute(uv, i, 1)], i * 2);
        const uvView = appendData(new Uint8Array(uvs.buffer), 34962);
        attributes.TEXCOORD_0 = addAccessor(uvView, 5126, uv.count, 'VEC2');
      }
      const color = geometry.attributes.color;
      if (color && color.count === position.count && (color.itemSize === 3 || color.itemSize === 4)) {
        const colors = new Float32Array(color.count * color.itemSize);
        for (let i = 0; i < color.count; i++) for (let component = 0; component < color.itemSize; component++) {
          let value = readAttribute(color, i, component);
          if (color.normalized && color.array instanceof Uint8Array) value /= 255;
          else if (color.normalized && color.array instanceof Uint16Array) value /= 65535;
          colors[i * color.itemSize + component] = value;
        }
        const colorView = appendData(new Uint8Array(colors.buffer), 34962);
        attributes.COLOR_0 = addAccessor(colorView, 5126, color.count, color.itemSize === 4 ? 'VEC4' : 'VEC3');
      }

      const sourceIndex = geometry.index;
      const sourceCount = sourceIndex ? sourceIndex.count : position.count;
      const drawStart = Math.max(0, geometry.drawRange?.start || 0);
      const drawEnd = Math.min(sourceCount, Number.isFinite(geometry.drawRange?.count) ? drawStart + geometry.drawRange.count : sourceCount);
      const groups = geometry.groups?.length ? geometry.groups : [{ start: 0, count: sourceCount, materialIndex: 0 }];
      const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
      const primitives = [];
      for (const group of groups) {
        const start = Math.max(drawStart, group.start || 0);
        const end = Math.min(drawEnd, (group.start || 0) + (Number.isFinite(group.count) ? group.count : sourceCount));
        const indexValues = [];
        for (let i = start; i + 2 < end; i += 3) {
          const a = sourceIndex ? sourceIndex.getX(i) : i;
          const b = sourceIndex ? sourceIndex.getX(i + 1) : i + 1;
          const c = sourceIndex ? sourceIndex.getX(i + 2) : i + 2;
          if (worldDeterminant < 0) indexValues.push(a, c, b);
          else indexValues.push(a, b, c);
        }
        if (!indexValues.length) continue;
        const indices = new Uint32Array(indexValues);
        const indexView = appendData(new Uint8Array(indices.buffer), 34963);
        const material = sourceMaterials[group.materialIndex || 0];
        const materialIndex = await addMaterial(material);
        primitives.push({ attributes: { ...attributes }, indices: addAccessor(indexView, 5125, indices.length, 'SCALAR'), material: materialIndex, mode: 4 });
      }
      if (!primitives.length) continue;
      gltfMeshes.push({ name: object.name || `Part ${gltfMeshes.length + 1}`, primitives });
      nodes.push({ name: object.name || `Part ${nodes.length + 1}`, mesh: gltfMeshes.length - 1 });
    }
    if (!nodes.length) throw new Error('The viewer does not contain exportable triangles.');

    const total = align4(binaryLength);
    const bin = new Uint8Array(total);
    let writeAt = 0;
    for (const part of binaryParts) { bin.set(part, writeAt); writeAt = align4(writeAt + part.byteLength); }
    const json = {
      asset: { version: '2.0', generator: 'PolyPort 3D' },
      scene: 0,
      scenes: [{ nodes: nodes.map((_, index) => index) }],
      nodes,
      meshes: gltfMeshes,
      materials,
      textures,
      images,
      samplers,
      accessors,
      bufferViews,
      buffers: [{ byteLength: binaryLength }]
    };
    if (jsonExtensionsUsed.size) json.extensionsUsed = [...jsonExtensionsUsed];
    for (const key of ['materials', 'textures', 'images', 'samplers']) if (!json[key].length) delete json[key];
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonLength = align4(jsonBytes.byteLength);
    const totalLength = 12 + 8 + jsonLength + 8 + total;
    const output = new ArrayBuffer(totalLength);
    const view = new DataView(output);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, totalLength, true);
    view.setUint32(12, jsonLength, true);
    view.setUint32(16, 0x4e4f534a, true);
    new Uint8Array(output, 20, jsonBytes.byteLength).set(jsonBytes);
    new Uint8Array(output, 20 + jsonBytes.byteLength, jsonLength - jsonBytes.byteLength).fill(0x20);
    const binaryHeader = 20 + jsonLength;
    view.setUint32(binaryHeader, total, true);
    view.setUint32(binaryHeader + 4, 0x004e4942, true);
    new Uint8Array(output, binaryHeader + 8, total).set(bin);
    return { buffer: output, textureWarnings };
  }

  async function captureViewerScene() {
    if (scanning) return;
    scanning = true;
    try {
      let scene = null;
      const deadline = Date.now() + 12_000;
      while (!scene && Date.now() < deadline) {
        scene = findTresScene();
        if (!scene) await new Promise((resolve) => setTimeout(resolve, 750));
      }
      if (!scene) throw new Error('Could not locate Tripo’s 3D scene. Wait for the viewer to load and try again.');
      const result = await serializeScene(scene);
      const name = scene.name ? `${scene.name}.glb` : 'tripo_viewer.glb';
      publishBuffer('viewer://scene.glb', result.buffer, 'model/gltf-binary', name, 'viewer');
      window.postMessage({ source: MARKER, type: 'VIEWER_SCAN_DONE', textureWarnings: result.textureWarnings }, location.origin);
    } catch (error) {
      window.postMessage({ source: MARKER, type: 'VIEWER_SCAN_FAILED', error: error?.message || 'Could not extract the viewer scene.' }, location.origin);
    } finally {
      scanning = false;
    }
  }
})();
