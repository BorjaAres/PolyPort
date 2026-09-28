// popup.js

document.getElementById('loadTasks').addEventListener('click', loadTasks);
const beforeDownload = document.getElementById('beforeDownload');
const tasksContainer = document.getElementById('tasksContainer');
tasksContainer.addEventListener('scroll', () => {
  if (tasksContainer.scrollTop > 8) beforeDownload.open = false;
}, { passive: true });

const downloadDialog = document.getElementById('downloadDialog');
const dialogFilename = document.getElementById('dialogFilename');
const dialogFormat = document.getElementById('dialogFormat');
const dialogHeight = document.getElementById('dialogHeight');
const dialogHeightPreset = document.getElementById('dialogHeightPreset');
const customHeightWrap = document.getElementById('customHeightWrap');
const dialogHeightLabel = document.getElementById('dialogHeightLabel');
const imagePreviewDialog = document.getElementById('imagePreviewDialog');
const imagePreview = document.getElementById('imagePreview');
const imagePreviewTitle = document.getElementById('imagePreviewTitle');
let pendingDownload = null;

dialogFormat.addEventListener('change', updateDialogForFormat);
dialogHeightPreset.addEventListener('change', updateHeightPreset);
document.getElementById('confirmDownload').addEventListener('click', confirmDialogDownload);
document.getElementById('cancelDownload').addEventListener('click', closeDownloadDialog);
document.getElementById('closeImagePreview').addEventListener('click', closeImagePreview);
imagePreviewDialog.addEventListener('click', (event) => {
  if (event.target === imagePreviewDialog) closeImagePreview();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeImagePreview();
    closeDownloadDialog();
  }
});

function closeDownloadDialog() {
  downloadDialog.hidden = true;
  pendingDownload = null;
}

function openImagePreview(url, title) {
  imagePreviewTitle.textContent = title;
  imagePreview.src = url;
  imagePreviewDialog.hidden = false;
}

function closeImagePreview() {
  imagePreviewDialog.hidden = true;
  imagePreview.removeAttribute('src');
}

function updateDialogForFormat() {
  const isStl = dialogFormat.value === 'stl';
  dialogHeightLabel.hidden = !isStl;
  dialogHeightPreset.disabled = !isStl;
  dialogHeight.disabled = !isStl;
}

function updateHeightPreset() {
  const isCustom = dialogHeightPreset.value === 'custom';
  customHeightWrap.hidden = !isCustom;
  if (isCustom) {
    dialogHeight.focus();
    dialogHeight.select();
  } else {
    dialogHeight.value = dialogHeightPreset.value;
  }
}

function openDownloadDialog(download) {
  beforeDownload.open = false;
  pendingDownload = download;
  document.getElementById('dialogModelName').textContent = download.modelName;
  dialogFilename.value = download.modelName;
  dialogFormat.value = 'glb';
  dialogHeightPreset.value = '40';
  dialogHeight.value = '40';
  updateHeightPreset();
  updateDialogForFormat();
  downloadDialog.hidden = false;
  dialogFilename.focus();
  dialogFilename.select();
}

function safeFilename(value, fallback) {
  let name = String(value || '').trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = fallback;
  return name;
}

function confirmDialogDownload() {
  if (!pendingDownload) return;
  const format = dialogFormat.value;
  const requestedName = dialogFilename.value.trim();
  if (!requestedName) {
    dialogFilename.reportValidity();
    return;
  }
  const targetHeightMm = Number(dialogHeight.value);
  if (format === 'stl' && (!Number.isFinite(targetHeightMm) || targetHeightMm < 0.1 || targetHeightMm > 100000)) {
    dialogHeight.reportValidity();
    return;
  }

  const { btn, taskId, modelUrl, filename, statusDiv } = pendingDownload;
  const finalFilename = safeFilename(requestedName, filename);
  downloadDialog.hidden = true;
  pendingDownload = null;
  btn.innerHTML = '<span class="download-icon">⏳</span><span class="download-text">Starting...</span>';
  btn.disabled = true;

  chrome.runtime.sendMessage({
    action: 'downloadModel', taskId, modelUrl,
    filename: `${finalFilename}.${format}`,
    format,
    targetHeightMm: format === 'stl' ? targetHeightMm : null
  }, (response) => {
    if (chrome.runtime.lastError || !response?.success) {
      const error = chrome.runtime.lastError?.message || response?.error || 'Unknown download error';
      btn.innerHTML = '<span class="download-icon">❌</span><span class="download-text">Error</span>';
      btn.title = error;
      btn.disabled = false;
      statusDiv.innerHTML = `<span class="status-icon">❌</span><span class="status-text">${escapeHtml(error)}</span>`;
      statusDiv.className = 'status-box error';
    }
  });
}

// Listen for decrypt status updates from content script
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'decryptStatus') {
    const btn = document.querySelector(`.btn-download[data-id="${request.requestId}"]`);
    if (!btn) return;

    if (request.status === 'fetching') {
      btn.innerHTML = '<span class="download-icon">📥</span><span class="download-text">Fetching...</span>';
    } else if (request.status === 'decrypting') {
      btn.innerHTML = '<span class="download-icon">🔓</span><span class="download-text">Decrypting...</span>';
    } else if (request.status === 'done') {
      btn.innerHTML = '<span class="download-icon">✅</span><span class="download-text">Done!</span>';
    } else if (request.status === 'error') {
      btn.innerHTML = '<span class="download-icon">❌</span><span class="download-text">Error</span>';
      btn.title = request.error;
      btn.disabled = false;
    }
  }
});

async function loadTasks() {
  const statusDiv = document.getElementById('status');
  const tasksList = document.getElementById('tasksList');

  statusDiv.innerHTML = '<span class="status-icon">⏳</span><span class="status-text">Fetching your models...</span>';
  statusDiv.classList.add('loading');
  tasksList.innerHTML = '';

  chrome.runtime.sendMessage({ action: 'getTasks' }, async (response) => {
    statusDiv.classList.remove('loading');

    if (response.success && response.tasks.length > 0) {
      statusDiv.innerHTML = `<span class="status-icon">✓</span><span class="status-text">${response.tasks.length} model(s) found</span>`;
      statusDiv.classList.add('success');

      displayTasks(response.tasks, tasksList, statusDiv);

    } else {
      statusDiv.innerHTML = `<span class="status-icon">❌</span><span class="status-text">${response.error || 'No models found'}</span>`;
      statusDiv.classList.add('error');
    }
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function displayTasks(tasks, tasksList, statusDiv) {
  tasks.forEach((task) => {
    const taskEl = document.createElement('div');
    taskEl.className = 'task-card';

    const date = new Date(task.createdAt).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });

    const statusText = String(task.status || 'UNKNOWN');
    const statusClass = statusText.toLowerCase().replace(/[^a-z0-9_-]/g, '');

    const imageDisplay = task.imageUrl
      ? `<img src="${escapeHtml(task.imageUrl)}" alt="Preview of ${escapeHtml(task.title || task.prompt || 'model')}" class="task-image" role="button" tabindex="0" title="Open a larger preview" />`
      : '<div class="task-preview-placeholder" aria-hidden="true">3D</div>';

    const displayTitle = task.title || task.prompt || 'Untitled Model';
    const formatNumber = (num) => {
      const parsed = Number(num);
      return Number.isFinite(parsed) && parsed > 0 ? parsed.toLocaleString('en-US') : '';
    };

    const polyInfo = (task.faceCount || task.vertexCount || task.triangleCount)
      ? `<div class="meta-item">
          <span class="meta-label">Polygons:</span>
          <span class="meta-value">${formatNumber(task.faceCount) ? formatNumber(task.faceCount) + ' faces' : ''}${formatNumber(task.faceCount) && formatNumber(task.vertexCount) ? ', ' : ''}${formatNumber(task.vertexCount) ? formatNumber(task.vertexCount) + ' vertices' : ''}</span>
        </div>`
      : '';

    const downloadFilename = safeFilename(displayTitle, `meshy_${task.id}`);

    const textureCount = task.textures ? Object.values(task.textures).filter(u => u).length : 0;
    const hasTextures = textureCount > 0;

    taskEl.innerHTML = `
      <div class="task-header">
        ${imageDisplay}
        <div class="task-header-content">
          <div class="task-title">${escapeHtml(displayTitle)}</div>
          <span class="status-badge ${statusClass}">${escapeHtml(statusText)}</span>
        </div>
      </div>
      <div class="task-meta">
        ${polyInfo}
        <div class="meta-item">
          <span class="meta-label">ID:</span>
          <span class="meta-value">${escapeHtml(String(task.id || '').substring(0, 12))}...</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Date:</span>
          <span class="meta-value">${date}</span>
        </div>
      </div>
      <div class="task-actions">
        <button class="btn-download" data-id="${escapeHtml(task.id)}" data-url="${escapeHtml(task.modelUrl)}" data-filename="${escapeHtml(downloadFilename)}" data-modelname="${escapeHtml(displayTitle)}">
          <span class="download-icon">⬇️</span>
          <span class="download-text">Download...</span>
        </button>
        ${hasTextures ? `<button class="btn-download-texture" data-id="${escapeHtml(task.id)}" data-textures='${escapeHtml(JSON.stringify(task.textures))}' data-taskname="${escapeHtml(displayTitle)}">
          <span class="download-icon">🖼️</span>
          <span class="download-text">Download Textures (${textureCount})</span>
        </button>` : ''}
      </div>
    `;

    tasksList.appendChild(taskEl);
    const preview = taskEl.querySelector('.task-image');
    if (preview) {
      const showPreview = () => openImagePreview(preview.src, displayTitle);
      preview.addEventListener('click', showPreview);
      preview.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          showPreview();
        }
      });
    }
  });

  // Download model buttons
  document.querySelectorAll('.btn-download').forEach(btn => {
    btn.addEventListener('click', () => {
      openDownloadDialog({
        btn,
        taskId: btn.dataset.id,
        modelUrl: btn.dataset.url,
        filename: btn.dataset.filename,
        modelName: btn.dataset.modelname,
        statusDiv
      });
    });
  });

  // Download all textures buttons
  document.querySelectorAll('.btn-download-texture').forEach(btn => {
    btn.addEventListener('click', () => {
      const taskId = btn.dataset.id;
      const textures = JSON.parse(btn.dataset.textures);
      const taskName = btn.dataset.taskname;

      chrome.runtime.sendMessage({
        action: 'downloadAllTextures',
        taskId: taskId,
        textures: textures,
        taskName: taskName
      });

      btn.innerHTML = '<span class="download-icon">✓</span><span class="download-text">Downloading...</span>';
      btn.disabled = true;
    });
  });
}
