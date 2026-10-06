(() => {
  'use strict';

  const TABLE_SELECTOR = '#result_list';
  let observedTable = null;
  let observer = null;
  let debounceTimer = null;

  function requestFreshScan(delay = 200) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'requestFreshQueueScan' }).catch(() => {});
    }, delay);
  }

  function attachObserver() {
    const table = document.querySelector(TABLE_SELECTOR);
    if (table === observedTable) return;
    observer?.disconnect();
    observedTable = table;
    if (!table) return;

    observer = new MutationObserver(() => requestFreshScan(300));
    observer.observe(table, {
      childList: true,
      subtree: true,
      characterData: true
    });
    requestFreshScan(100);
  }

  attachObserver();
  requestFreshScan(100);

  const documentObserver = new MutationObserver(() => {
    attachObserver();
  });

  documentObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();

