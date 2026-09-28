chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const activeUrl = tabs[0]?.url || '';
  let destination = 'home.html';

  try {
    const { hostname, protocol } = new URL(activeUrl);
    if (protocol === 'https:' && (hostname === 'meshy.ai' || hostname === 'www.meshy.ai')) {
      destination = 'meshy-popup.html';
    } else if (protocol === 'https:' && hostname === 'studio.tripo3d.ai') {
      destination = 'tripo-popup.html';
    }
  } catch (_) {
    // Restricted browser pages and empty tabs use the welcome screen.
  }

  location.replace(chrome.runtime.getURL(destination));
});
