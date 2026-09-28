// background.js

let wasmAuth = null;
const MESHY_URLS = ['https://meshy.ai/*', 'https://www.meshy.ai/*'];

function isMeshyPage(url = '') {
  return /^https:\/\/(?:www\.)?meshy\.ai\//i.test(url);
}

async function preferredMeshyTabs() {
  const tabs = await chrome.tabs.query({ url: MESHY_URLS });
  const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeId = active.find(tab => isMeshyPage(tab.url))?.id;
  return tabs.sort((a, b) =>
    Number(b.id === activeId) - Number(a.id === activeId) ||
    Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0)
  );
}

async function reconnectMeshyTab(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['main_world.js'], world: 'MAIN' });
}

async function reconnectOpenMeshyTabs() {
  const tabs = await preferredMeshyTabs();
  await Promise.allSettled(tabs.map(tab => reconnectMeshyTab(tab.id)));
}

chrome.runtime.onInstalled.addListener(() => reconnectOpenMeshyTabs());
chrome.runtime.onStartup.addListener(() => reconnectOpenMeshyTabs());

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'saveToken') {
    chrome.storage.session.set({ meshy_token: request.token });
  }

  if (request.action === 'saveWasmAuth') {
    wasmAuth = request.auth;
    chrome.storage.session.set({ meshy_wasm_auth: request.auth });
    console.log('✓ WASM auth credentials stored');
  }

  if (request.action === 'getTasks') {
    getTasks().then(tasks => {
      sendResponse({ success: true, tasks: tasks });
    }).catch(error => {
      console.error('Failed to fetch tasks:', error);
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }

  if (request.action === 'downloadModel') {
    downloadModel(request.taskId, request.modelUrl, request.filename, request.format, request.targetHeightMm)
      .then(() => sendResponse({ success: true }))
      .catch(error => {
        console.error('[Meshy] Download failed:', error);
        chrome.runtime.sendMessage({
          action: 'decryptStatus',
          requestId: request.taskId,
          status: 'error',
          error: error.message
        }).catch(() => {});
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (request.action === 'downloadTexture') {
    downloadTexture(request.taskId, request.textureUrl, request.filename);
  }

  if (request.action === 'downloadAllTextures') {
    downloadAllTextures(request.taskId, request.textures, request.taskName);
  }
});

async function getFreshTokenFromMeshyTabs() {
  const tabs = await preferredMeshyTabs();

  for (const tab of tabs) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getFreshToken' });
      if (response?.success && response.token) {
        await chrome.storage.session.set({ meshy_token: response.token });
        return response.token;
      }
    } catch (_) {
      // Ignore tabs where the content script is not available and try the next one.
    }
  }

  return null;
}

async function getTasks() {
  return new Promise((resolve, reject) => {
    chrome.storage.session.get('meshy_token', async (result) => {
      let token = await getFreshTokenFromMeshyTabs() || result.meshy_token;

      if (!token) {
        reject(new Error('Open one of your models in Meshy, wait until the 3D viewer is interactive, then press Fetch Models again.'));
        return;
      }

      const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      };

      const fetchWithAuthRetry = async (url) => {
        let response = await fetch(url, { method: 'GET', headers });

        if (response.status === 401) {
          const refreshedToken = await getFreshTokenFromMeshyTabs();
          if (refreshedToken) {
            token = refreshedToken;
            headers.Authorization = `Bearer ${token}`;
            response = await fetch(url, { method: 'GET', headers });
          }
        }

        if (response.status === 401) {
          await chrome.storage.session.remove('meshy_token');
          throw new Error('Meshy session expired. Sign out and back in to Meshy, then press Fetch Models again.');
        }

        return response;
      };

      try {
        // Step 1: Fetch root tasks (all pages)
        let allRootTasks = [];
        let pageNum = 1;
        const pageSize = 50;
        let hasMore = true;

        while (hasMore) {
          const url = `https://api.meshy.ai/web/v2/tasks/?sortBy=-created_at&pageNum=${pageNum}&pageSize=${pageSize}`;
          const response = await fetchWithAuthRetry(url);

          if (!response.ok) {
            throw new Error(`API error: ${response.status} - ${response.statusText}`);
          }

          const data = await response.json();
          let tasksList = extractTasksList(data);

          if (tasksList.length === 0) {
            hasMore = false;
          } else {
            allRootTasks = allRootTasks.concat(tasksList);
            hasMore = tasksList.length >= pageSize;
            pageNum++;
          }
        }

        // Filter to only keep root tasks (avoid duplicates with children)
        allRootTasks = allRootTasks.filter(t => !t.rootId || t.rootId === t.id);

        console.log(`[Meshy] Found ${allRootTasks.length} root tasks`);

        // Step 2: For each root task, fetch related tasks to find the best (textured) version
        const finalTasks = await Promise.all(allRootTasks.map(async (rootTask) => {
          try {
            const relatedUrl = `https://api.meshy.ai/web/v2/tasks/${rootTask.id}/related?sortBy=-created_at&pageNum=1&pageSize=20`;
            const relRes = await fetchWithAuthRetry(relatedUrl);

            if (relRes.ok) {
              const relData = await relRes.json();
              const relatedTasks = extractTasksList(relData);

              if (relatedTasks.length > 0) {
                // Pick the best task: prefer texture > generate > draft phase, and SUCCEEDED status
                const bestTask = relatedTasks.find(t => t.phase === 'texture' && t.status === 'SUCCEEDED')
                  || relatedTasks.find(t => t.phase === 'generate' && t.status === 'SUCCEEDED')
                  || relatedTasks.find(t => t.status === 'SUCCEEDED')
                  || relatedTasks[0];

                return mapTask(bestTask, rootTask);
              }
            }
          } catch (e) {
            console.warn(`[Meshy] Failed to fetch related for ${rootTask.id}:`, e.message);
          }

          // Fallback: use the root task itself
          return mapTask(rootTask);
        }));

        const filteredTasks = finalTasks.filter(task => task.modelUrl)
          .sort((a, b) => {
            const dateA = new Date(a.createdAt).getTime();
            const dateB = new Date(b.createdAt).getTime();
            return dateB - dateA;
          });

        console.log(`[Meshy] ${filteredTasks.length} downloadable models found`);
        resolve(filteredTasks);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function extractTasksList(data) {
  if (Array.isArray(data)) return data;
  if (data.result && Array.isArray(data.result)) return data.result;
  if (data.data && Array.isArray(data.data)) return data.data;
  if (data.tasks && Array.isArray(data.tasks)) return data.tasks;
  return [];
}

function mapTask(task, rootTask) {
  const prompt = task.args?.draft?.prompt || task.args?.texture?.prompt || task.prompt || rootTask?.args?.draft?.prompt || '';
  const texSet = task.result?.texture?.textureUrls?.[0] || {};
  const directModelUrl = findDirectGlbUrl(task) || findDirectGlbUrl(rootTask);
  return {
    id: task.id,
    title: task.name || prompt || 'Untitled',
    status: task.status,
    modelUrl: directModelUrl || task.result?.texture?.modelUrl || task.result?.generate?.modelUrl || task.result?.draft?.modelUrl || task.result?.stylize?.modelUrl || task.model_url || task.modelUrl || '',
    createdAt: task.created_at || task.createdAt,
    prompt: prompt,
    imageUrl: task.result?.previewUrl || rootTask?.result?.previewUrl || '',
    textures: {
      colorMapUrl: texSet.colorMapUrl || '',
      metallicMapUrl: texSet.metallicMapUrl || '',
      roughnessMapUrl: texSet.roughnessMapUrl || '',
      normalMapUrl: texSet.normalMapUrl || ''
    },
    quadJsonUrl: task.result?.texture?.quadJsonUrl || task.result?.generate?.quadJsonUrl || '',
    triangleCount: task.triangleCount || task.faceCount || 0,
    vertexCount: task.vertexCount || 0,
    faceCount: task.faceCount || 0
  };
}

function findDirectGlbUrl(task) {
  if (!task || typeof task !== 'object') return '';

  const containers = [
    task.model_urls, task.modelUrls,
    task.result?.model_urls, task.result?.modelUrls,
    task.result?.texture?.model_urls, task.result?.texture?.modelUrls,
    task.result?.generate?.model_urls, task.result?.generate?.modelUrls,
    task.result?.draft?.model_urls, task.result?.draft?.modelUrls,
    task.result?.stylize?.model_urls, task.result?.stylize?.modelUrls
  ];
  for (const urls of containers) {
    const candidate = urls?.glb || urls?.GLB;
    if (typeof candidate === 'string' && candidate && !isEncryptedModelUrl(candidate)) return candidate;
  }

  const directCandidates = [task.glb_url, task.glbUrl, task.output?.glb, task.result?.glb];
  return directCandidates.find(url => typeof url === 'string' && url.includes('.glb')) || '';
}

function isEncryptedModelUrl(value) {
  try {
    return new URL(value).pathname.toLowerCase().endsWith('.meshy');
  } catch (_) {
    return /\.meshy(?:[?#]|$)/i.test(String(value));
  }
}

async function ensureMeshyContentScript(tabId) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await chrome.tabs.sendMessage(tabId, { action: 'meshyDownloaderPing' });
    } catch (error) {
      lastError = error;
    }
    if (!chrome.scripting?.executeScript) break;
    try {
      await reconnectMeshyTab(tabId);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
  }
  throw lastError || new Error('Meshy Downloader could not connect to this tab.');
}

async function downloadModel(taskId, modelUrl, filename, format = 'glb', targetHeightMm = null) {
  // Check if it's an encrypted .meshy file
  if (isEncryptedModelUrl(modelUrl) || format === 'stl') {
    // Prefer the active Meshy tab, but probe every candidate so a stale tab
    // can never cause "Receiving end does not exist".
    const tabs = await preferredMeshyTabs();
    if (tabs.length === 0) {
      throw new Error('Open meshy.ai in a tab before downloading.');
    }

    const storedAuth = await chrome.storage.session.get(['meshy_wasm_auth', 'meshy_token']);
    const currentWasmAuth = wasmAuth || storedAuth.meshy_wasm_auth || null;
    let lastError = null;
    for (const tab of tabs) {
      try {
        await ensureMeshyContentScript(tab.id);
        const response = await chrome.tabs.sendMessage(tab.id, {
          action: 'processAndDownload',
          modelUrl,
          filename,
          format,
          targetHeightMm,
          requestId: taskId,
          wasmAuth: currentWasmAuth,
          bearerToken: storedAuth.meshy_token || null
        });
        if (!response?.success) {
          throw new Error(response?.error || 'The Meshy tab rejected the download.');
        }
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(
      lastError?.message?.includes('Receiving end')
        ? 'Open a Meshy model and wait for the 3D viewer to become interactive, then try the download again.'
        : lastError?.message?.includes('Cannot access contents of the page')
          ? 'Allow this extension on www.meshy.ai in Brave/Chromium, open a model, wait for the 3D viewer, and try again.'
          : (lastError?.message || 'No usable Meshy tab was found.')
    );
  } else {
    // Direct download for non-encrypted files
    await chrome.downloads.download({
      url: modelUrl,
      filename: `meshy_models/${filename}`,
      saveAs: true
    });
  }
}

function downloadTexture(taskId, textureUrl, filename) {
  chrome.downloads.download({
    url: textureUrl,
    filename: `meshy_models/${filename || taskId}_texture.png`,
    saveAs: true
  });
}

function downloadAllTextures(taskId, textures, taskName) {
  const safeName = (taskName || taskId).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
  const maps = [
    { url: textures.colorMapUrl, suffix: 'color' },
    { url: textures.metallicMapUrl, suffix: 'metallic' },
    { url: textures.roughnessMapUrl, suffix: 'roughness' },
    { url: textures.normalMapUrl, suffix: 'normal' }
  ];

  maps.forEach(({ url, suffix }) => {
    if (url) {
      chrome.downloads.download({
        url: url,
        filename: `meshy_models/${safeName}_${suffix}.png`,
        saveAs: false
      });
    }
  });
}
