const statusBox = document.getElementById('status');
const statusText = document.getElementById('statusText');
const modelsRoot = document.getElementById('models');
const emptyState = document.getElementById('emptyState');
const modelsTitle = document.getElementById('modelsTitle');
const steps = document.getElementById('steps');
const scanViewerButton = document.getElementById('scanViewer');
const hint = document.querySelector('.hint');
const dialog = document.getElementById('dialog');
const previewDialog = document.getElementById('previewDialog');
const previewImage = document.getElementById('previewImage');
const previewMessage = document.getElementById('previewMessage');
const inlinePreview = document.getElementById('inlinePreview');
const inlinePreviewImage = document.getElementById('inlinePreviewImage');
const inlinePreviewMessage = document.getElementById('inlinePreviewMessage');
const formatSelect = document.getElementById('format');
const stlOptions = document.getElementById('stlOptions');
const heightPreset = document.getElementById('heightPreset');
const customHeightWrap = document.getElementById('customHeightWrap');
const customHeight = document.getElementById('customHeight');
const partWrap = document.getElementById('partWrap');
const partSelect = document.getElementById('partSelect');
let activeTabId = null;
let capturedModels = [];
let selectedModel = null;
let inlinePreviewInFlight = false;
let inlinePreviewReady = false;
let viewerPreviewData = '';
let isTripoTab = false;

function setStatus(message, kind = '') {
  statusText.textContent = message;
  statusBox.className = `status ${kind}`.trim();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

async function getActiveTab() {
  const tabs = await new Promise((resolve) => chrome.tabs.query({ active: true, currentWindow: true }, resolve));
  return tabs[0] || null;
}

async function loadModels(refreshPreview = false) {
  const tab = await getActiveTab();
  activeTabId = tab?.id ?? null;
  if (!tab || !/^https:\/\/studio\.tripo3d\.ai\//i.test(tab.url || '')) {
    isTripoTab = false;
    capturedModels = [];
    renderModels();
    setStatus('Open a model in Tripo Studio');
    return;
  }

  isTripoTab = true;
  void captureInlinePreview(refreshPreview);

  try {
    const response = await sendToTab(tab.id, { type: 'TRIPO_GET_MODELS' });
    capturedModels = response?.models || [];
    renderModels();
    if (capturedModels.length) setStatus(`${capturedModels.length} file(s) available`, 'ready');
    else if (response?.notice) setStatus(response.notice, 'error');
    else setStatus('Waiting for a model in the viewer');
  } catch (_) {
    capturedModels = [];
    renderModels();
    setStatus('Reload the Tripo Studio tab to activate PolyPort');
  }
}

async function captureInlinePreview(force = false) {
  if (activeTabId === null || inlinePreviewInFlight || (inlinePreviewReady && !force)) return;
  inlinePreviewInFlight = true;
  inlinePreviewMessage.textContent = 'Capturing the current viewer…';
  inlinePreviewMessage.hidden = false;
  inlinePreviewImage.hidden = true;
  try {
    const response = await sendToTab(activeTabId, { type: 'TRIPO_CAPTURE_PREVIEW' });
    if (!response?.ok || !response.image) throw new Error(response?.error || 'The viewer did not return an image.');
    viewerPreviewData = response.image;
    inlinePreviewImage.src = response.image;
    inlinePreviewImage.hidden = false;
    inlinePreviewMessage.hidden = true;
    inlinePreviewReady = true;
    if (capturedModels.length) renderModels();
  } catch (error) {
    viewerPreviewData = '';
    inlinePreviewMessage.textContent = error.message || 'The preview is not available yet.';
    inlinePreviewReady = false;
  } finally {
    inlinePreviewInFlight = false;
  }
}

function displayName(filename) {
  return String(filename || 'tripo_model').replace(/\.[a-z0-9]{2,5}$/i, '');
}

function renderModels() {
  modelsRoot.replaceChildren();
  const hasModels = capturedModels.length > 0;
  const ready = isTripoTab && hasModels;
  modelsTitle.textContent = ready ? 'Ready to download' : 'Detected models';
  steps.hidden = ready;
  scanViewerButton.hidden = ready;
  hint.hidden = ready;
  inlinePreview.hidden = !isTripoTab || ready;
  emptyState.hidden = hasModels;
  for (const model of capturedModels) {
    const card = document.createElement('article');
    card.className = 'model-card';
    const size = `${(model.size / (1024 * 1024)).toFixed(model.size < 1024 * 1024 ? 3 : 1)} MB`;
    const when = new Date(model.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const preview = document.createElement('div');
    preview.className = 'model-card-preview';
    if (viewerPreviewData) {
      const image = document.createElement('img');
      image.src = viewerPreviewData;
      image.alt = `Preview of ${model.filename}`;
      preview.appendChild(image);
    } else {
      preview.innerHTML = '<span class="preview-placeholder-icon" aria-hidden="true">◈</span><span class="preview-placeholder-label">Preview loading</span>';
    }
    const details = document.createElement('div');
    details.className = 'model-card-details';
    details.innerHTML = `
      <div class="model-top">
        <div class="model-identification">
          <div class="model-name" title="${escapeHtml(model.filename)}">${escapeHtml(model.filename)}</div>
          <div class="model-meta">${size} · ${when}${model.source === 'viewer' ? ' · viewer capture' : ' · loaded resource'}${model.parts?.length ? ` · ${model.parts.length} parts` : ''}</div>
        </div>
        <span class="format-pill">${escapeHtml(model.format).toUpperCase()}</span>
      </div>
      <div class="model-actions">
        <button type="button" data-action="preview">Preview</button>
        <button class="download-action" type="button" data-action="download">Download</button>
      </div>`;
    card.append(preview, details);
    card.querySelector('[data-action="preview"]').addEventListener('click', () => void showPreview(model));
    card.querySelector('[data-action="download"]').addEventListener('click', () => openDialog(model));
    modelsRoot.appendChild(card);
  }
}

async function showPreview(model) {
  document.getElementById('previewModelName').textContent = model.filename;
  previewImage.hidden = true;
  previewImage.removeAttribute('src');
  previewMessage.textContent = 'Capturing the current view…';
  previewMessage.hidden = false;
  previewDialog.hidden = false;
  try {
    const response = await sendToTab(activeTabId, { type: 'TRIPO_CAPTURE_PREVIEW' });
    if (!response?.ok || !response.image) throw new Error(response?.error || 'The viewer did not return an image.');
    viewerPreviewData = response.image;
    previewImage.src = response.image;
    previewImage.hidden = false;
    previewMessage.hidden = true;
    if (capturedModels.length) renderModels();
  } catch (error) {
    previewMessage.textContent = error.message || 'Could not capture the preview.';
  }
}

function openDialog(model) {
  selectedModel = model;
  document.getElementById('filename').value = displayName(model.filename);
  document.getElementById('modelSummary').textContent = `${model.filename} · ${(model.size / (1024 * 1024)).toFixed(1)} MB`;
  formatSelect.value = 'original';
  const stlOption = formatSelect.querySelector('option[value="stl"]');
  stlOption.disabled = model.format !== 'glb';
  if (stlOption.disabled) formatSelect.value = 'original';

  partSelect.replaceChildren(new Option('Full model', 'all'));
  for (const part of model.parts || []) partSelect.add(new Option(part.label, part.id));
  partWrap.hidden = !(model.format === 'glb' && (model.parts?.length || 0) > 1);
  heightPreset.value = '40';
  customHeight.value = '40';
  updateFormatFields();
  document.getElementById('dialogError').hidden = true;
  dialog.hidden = false;
  document.getElementById('filename').focus();
  document.getElementById('filename').select();
}

function updateFormatFields() {
  const isStl = formatSelect.value === 'stl';
  stlOptions.hidden = !isStl;
  partWrap.hidden = !isStl || !selectedModel || (selectedModel.parts?.length || 0) < 2;
  customHeightWrap.hidden = heightPreset.value !== 'custom';
}

async function prepareDownload() {
  if (!selectedModel || activeTabId === null) return;
  const filename = document.getElementById('filename').value.trim();
  const errorBox = document.getElementById('dialogError');
  if (!filename) {
    errorBox.textContent = 'Enter a file name.';
    errorBox.hidden = false;
    return;
  }
  const height = heightPreset.value === 'custom' ? Number(customHeight.value) : Number(heightPreset.value);
  if (formatSelect.value === 'stl' && (!Number.isFinite(height) || height < 0.1 || height > 100000)) {
    errorBox.textContent = 'Enter a height between 0.1 and 100,000 mm.';
    errorBox.hidden = false;
    return;
  }

  const downloadButton = document.getElementById('download');
  downloadButton.disabled = true;
  downloadButton.textContent = formatSelect.value === 'stl' ? 'Preparing STL…' : 'Starting download…';
  errorBox.hidden = true;
  try {
    const response = await sendToTab(activeTabId, {
      type: 'TRIPO_DOWNLOAD',
      id: selectedModel.id,
      filename,
      format: formatSelect.value === 'stl' ? 'stl' : 'original',
      heightMm: height,
      partId: partSelect.value
    });
    if (!response?.ok) throw new Error(response?.error || 'Could not start the download.');
    dialog.hidden = true;
    setStatus(`Download started: ${response.filename}`, 'ready');
  } catch (error) {
    errorBox.textContent = error.message || 'Could not start the download.';
    errorBox.hidden = false;
  } finally {
    downloadButton.disabled = false;
    downloadButton.textContent = 'Download';
  }
}

document.getElementById('scanViewer').addEventListener('click', async () => {
  const button = document.getElementById('scanViewer');
  button.disabled = true;
  try {
    const tab = await getActiveTab();
    if (!tab || !/^https:\/\/studio\.tripo3d\.ai\//i.test(tab.url || '')) throw new Error('Open a model at studio.tripo3d.ai, then select this button again.');
    activeTabId = tab.id;
    const response = await sendToTab(tab.id, { type: 'TRIPO_SCAN_VIEWER' });
    if (!response?.ok) throw new Error('Could not start scanning the viewer. Reload Tripo Studio and try again.');
    setStatus('Looking for model geometry and textures in the viewer…', 'ready');
  } catch (error) {
    setStatus(error.message || 'Could not start capture.', 'error');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('refresh').addEventListener('click', () => void loadModels(true));
document.getElementById('closePreview').addEventListener('click', () => { previewDialog.hidden = true; });
previewDialog.addEventListener('click', (event) => { if (event.target === previewDialog) previewDialog.hidden = true; });
document.getElementById('closeDialog').addEventListener('click', () => { dialog.hidden = true; });
document.getElementById('cancel').addEventListener('click', () => { dialog.hidden = true; });
document.getElementById('download').addEventListener('click', prepareDownload);
formatSelect.addEventListener('change', updateFormatFields);
heightPreset.addEventListener('change', updateFormatFields);
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'TRIPO_MODEL_CAPTURED') void loadModels(true);
  if (message?.type === 'TRIPO_STL_VIEWER_FALLBACK') setStatus('Preparing the STL from geometry loaded in the viewer…', 'ready');
  if (message?.type === 'TRIPO_VIEWER_SCAN_DONE') {
    void loadModels(true);
    if (message.notice) setStatus(message.notice, 'error');
  }
  if (message?.type === 'TRIPO_CAPTURE_FAILED') void loadModels();
});

void loadModels();
