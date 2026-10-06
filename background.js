'use strict';

const DUPLICATE_NOTIFICATION_ID = 'chamber-queue-duplicate-warning';
const SCAN_ALARM = 'scan-chamber-queue';
const RELOAD_ALARM = 'reload-chamber-queue';
// Share the page configuration used for content-script injection.
const QUEUE_URL_PATTERNS = chrome.runtime.getManifest().content_scripts.flatMap((script) => script.matches);
const DUPLICATE_THRESHOLD = 2;
let scanInProgress = false;

async function getSettings() {
  return chrome.storage.local.get({
    monitoringEnabled: true,
    autoRemoveEnabled: false
  });
}

function ensureScanAlarm() {
  chrome.alarms.create(SCAN_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.create(RELOAD_ALARM, { periodInMinutes: 1 });
}

async function getQueueTabs() {
  const tabs = await chrome.tabs.query({ url: QUEUE_URL_PATTERNS });
  return tabs
    .filter((tab) => tab.id && tab.url)
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
}

function normalizeTitle(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function findDuplicates(titles) {
  const counts = new Map();
  for (const title of titles) {
    const clean = normalizeTitle(title);
    if (!clean) continue;
    const key = clean.toLocaleLowerCase();
    const current = counts.get(key) || { title: clean, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }

  return [...counts.values()]
    .filter((item) => item.count >= DUPLICATE_THRESHOLD)
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}

function makeSignature(duplicates) {
  return duplicates
    .map((item) => `${item.title.toLocaleLowerCase()}::${item.count}`)
    .join('|');
}

function buildMessage(duplicates) {
  return duplicates.map(({ title, count }) => `${title} — ${count} entries`).join('\n');
}

async function scanFreshQueueInsideTab(tab) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async () => {
      try {
        const response = await fetch(window.location.href, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'follow',
          headers: { 'Cache-Control': 'no-cache' }
        });

        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const table = doc.querySelector('#result_list');
        const titles = table
          ? [...table.querySelectorAll('tbody tr .field-title')]
              .map((cell) => (cell.textContent || '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
          : [];

        return {
          ok: response.ok,
          status: response.status,
          url: response.url,
          hasTable: Boolean(table),
          titles
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          url: window.location.href,
          hasTable: false,
          titles: [],
          error: error?.message || String(error)
        };
      }
    }
  });

  const result = results?.[0]?.result;
  if (!result) throw new Error('No scan result was returned from the queue tab.');
  if (!result.ok) throw new Error(result.error || `Queue page returned HTTP ${result.status}`);
  if (/\/admin\/login\//i.test(result.url || '')) throw new Error('Django admin login has expired.');
  if (!result.hasTable) throw new Error('Fresh queue page did not contain #result_list.');

  return { url: result.url || tab.url, titles: result.titles || [] };
}

async function executeAutoCleanupInTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async () => {
      if (window.__chamberQueueAutoRemoving) {
        return { clicked: false, reason: 'cleanup-already-running' };
      }

      const table = document.querySelector('#result_list');
      const removeButton = document.querySelector('#remove-selected-button');
      if (!table) return { clicked: false, reason: 'table-not-found' };
      if (!removeButton) return { clicked: false, reason: 'remove-button-not-found' };

      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const groups = new Map();

      for (const row of table.querySelectorAll('tbody tr')) {
        const title = normalize(row.querySelector('.field-title')?.textContent);
        const checkbox = row.querySelector('input.action-select[name="_selected_action"]');
        if (!title || !checkbox) continue;
        const key = title.toLocaleLowerCase();
        if (!groups.has(key)) groups.set(key, { title, rows: [] });
        groups.get(key).rows.push({ checkbox });
      }

      const duplicateGroups = [...groups.values()].filter((group) => group.rows.length >= 2);
      const targets = [];
      for (const group of duplicateGroups) {
        // Keep the first visible occurrence. Remove every later occurrence.
        for (let index = 1; index < group.rows.length; index += 1) {
          targets.push({ title: group.title, checkbox: group.rows[index].checkbox });
        }
      }

      if (!targets.length) return { clicked: false, reason: 'no-live-duplicates' };
      if (targets.some((target) => target.checkbox.disabled)) {
        return { clicked: false, reason: 'duplicate-checkbox-disabled' };
      }

      window.__chamberQueueAutoRemoving = true;
      const waitBeforeStep = () => new Promise((resolve) => setTimeout(resolve, 1000));

      try {
        const checkboxes = [...table.querySelectorAll('input.action-select[name="_selected_action"]')];
        const intended = new Set(targets.map((target) => target.checkbox));
        if (checkboxes.some((checkbox) => checkbox.checked && checkbox.disabled)) {
          return { clicked: false, reason: 'selected-checkbox-disabled' };
        }

        // Native click runs click, input, and change handlers, including the
        // Django admin selection handlers that assigning checked bypasses.
        for (const checkbox of checkboxes) {
          if (checkbox.checked) {
            await waitBeforeStep();
            if (!checkbox.isConnected || checkbox.disabled) {
              return { clicked: false, reason: 'selection-changed-before-submit' };
            }
            if (checkbox.checked) checkbox.click();
          }
        }
        for (const target of targets) {
          if (!target.checkbox.checked) {
            await waitBeforeStep();
            if (!target.checkbox.isConnected || target.checkbox.disabled) {
              return { clicked: false, reason: 'selection-changed-before-submit' };
            }
            if (!target.checkbox.checked) target.checkbox.click();
          }
        }

        await waitBeforeStep();
        const currentCheckboxes = [...table.querySelectorAll('input.action-select[name="_selected_action"]')];
        if (!table.isConnected || !removeButton.isConnected ||
            currentCheckboxes.length !== checkboxes.length ||
            currentCheckboxes.some((checkbox) => !checkboxes.includes(checkbox) || !checkbox.isConnected || checkbox.checked !== intended.has(checkbox))) {
          return { clicked: false, reason: 'selection-changed-before-submit' };
        }
        if (removeButton.disabled || removeButton.getAttribute('aria-disabled') === 'true') {
          return { clicked: false, reason: 'remove-button-disabled' };
        }

        // A native confirm dialog is outside the page DOM. Accept the first
        // removal confirmation synchronously raised by this automatic click,
        // then restore normal prompts before any other action can run.
        const originalConfirm = window.confirm;
        let confirmationAccepted = false;
        try {
          window.confirm = function (message) {
            if (!confirmationAccepted && /\b(remove|removal|delete|deletion)\b/i.test(String(message))) {
              confirmationAccepted = true;
              return true;
            }
            return originalConfirm.call(window, message);
          };
          removeButton.click();
        } finally {
          window.confirm = originalConfirm;
        }
        const ids = targets.map((target) => target.checkbox.value);
        return { clicked: true, ids, count: ids.length, confirmationAccepted };
      } catch (error) {
        return { clicked: false, reason: 'remove-click-failed', error: error?.message || String(error) };
      } finally {
        // Failed clicks and AJAX actions must not permanently block cleanup.
        window.__chamberQueueAutoRemoving = false;
      }
    }
  });

  return results?.[0]?.result || { clicked: false, reason: 'no-result' };
}

async function isAutoCleanupActiveInTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => window.__chamberQueueAutoRemoving === true
  });
  return results?.[0]?.result === true;
}

async function reloadQueueTabWhenIdle() {
  const settings = await getSettings();
  if (settings.monitoringEnabled === false || scanInProgress) return;

  const tabs = await getQueueTabs();
  if (!tabs.length) return;

  const queueTab = tabs[0];
  if (queueTab.status === 'loading') return;

  try {
    if (await isAutoCleanupActiveInTab(queueTab.id)) return;
    await chrome.tabs.reload(queueTab.id);
  } catch (error) {
    console.warn('Could not reload the Chamber Queue tab:', error);
  }
}

async function updateDuplicateState(duplicates) {
  const signature = makeSignature(duplicates);
  const session = await chrome.storage.session.get({ lastDuplicateSignature: '' });
  const previousSignature = session.lastDuplicateSignature || '';

  if (!signature) {
    await chrome.action.setBadgeText({ text: '' });
    if (previousSignature) {
      await chrome.storage.session.set({ lastDuplicateSignature: '' });
      await chrome.notifications.clear(DUPLICATE_NOTIFICATION_ID);
    }
    return;
  }

  const maxCount = Math.max(...duplicates.map((item) => item.count));
  await chrome.action.setBadgeText({ text: maxCount > 99 ? '99+' : String(maxCount) });
  await chrome.action.setBadgeBackgroundColor({ color: '#B00020' });

  if (signature === previousSignature) return;
  await chrome.storage.session.set({ lastDuplicateSignature: signature });

  await chrome.notifications.create(DUPLICATE_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: 'Duplicate profiles in Chamber Queue',
    message: buildMessage(duplicates),
    priority: 2
  });
}

async function recordScanStatus(ok, details = {}) {
  await chrome.storage.local.set({
    lastScanAt: Date.now(),
    lastScanOk: ok,
    lastScanError: ok ? '' : String(details.error || 'Unknown error'),
    lastScannedUrl: details.url || '',
    lastTitleCount: details.titleCount ?? null
  });
}

async function scanFreshQueuePage() {
  if (scanInProgress) return;
  scanInProgress = true;
  try {
    await runQueueScan();
  } finally {
    scanInProgress = false;
  }
}

async function runQueueScan() {
  const settings = await getSettings();
  if (settings.monitoringEnabled === false) return;

  const tabs = await getQueueTabs();
  if (!tabs.length) {
    await recordScanStatus(false, { error: 'Queue tab is not open.' });
    return;
  }

  const queueTab = tabs[0];

  try {
    const fresh = await scanFreshQueueInsideTab(queueTab);
    const duplicates = findDuplicates(fresh.titles);

    await recordScanStatus(true, {
      url: fresh.url,
      titleCount: fresh.titles.length
    });
    if (!duplicates.length) {
      await chrome.storage.local.set({ lastCleanupStatus: '', lastCleanupError: '' });
    }

    await updateDuplicateState(duplicates);

    const latestSettings = await getSettings();
    if (latestSettings.monitoringEnabled !== false && latestSettings.autoRemoveEnabled === true && duplicates.length) {
      // First try against the currently loaded DOM. If it is stale, reload the
      // background tab; the content script requests a new scan on load.
      const result = await executeAutoCleanupInTab(queueTab.id);
      await chrome.storage.local.set({
        lastCleanupStatus: result.clicked ? `Submitted ${result.count} duplicate${result.count === 1 ? '' : 's'} for removal.` : result.reason,
        lastCleanupError: result.error || ''
      });
      if (!result.clicked && result.reason === 'no-live-duplicates') {
        await chrome.tabs.reload(queueTab.id);
      }
    }
  } catch (error) {
    console.warn('Chamber Queue scan failed:', error);
    await recordScanStatus(false, {
      url: queueTab.url,
      error: error?.message || String(error)
    });
  }
}

async function clearIndicators() {
  await chrome.notifications.clear(DUPLICATE_NOTIFICATION_ID);
  await chrome.action.setBadgeText({ text: '' });
  await chrome.storage.session.set({ lastDuplicateSignature: '' });
}

async function applyMonitoringState(enabled) {
  if (!enabled) {
    await clearIndicators();
    await chrome.action.setBadgeText({ text: 'OFF' });
    await chrome.action.setBadgeBackgroundColor({ color: '#6B7280' });
    return;
  }

  await chrome.action.setBadgeText({ text: '' });
  await chrome.storage.session.set({ lastDuplicateSignature: '' });
  await scanFreshQueuePage();
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(['monitoringEnabled', 'autoRemoveEnabled']);
  const defaults = {};
  if (typeof current.monitoringEnabled !== 'boolean') defaults.monitoringEnabled = true;
  if (typeof current.autoRemoveEnabled !== 'boolean') defaults.autoRemoveEnabled = false;
  if (Object.keys(defaults).length) await chrome.storage.local.set(defaults);

  ensureScanAlarm();
  const settings = await getSettings();
  await applyMonitoringState(settings.monitoringEnabled !== false);
});

chrome.runtime.onStartup.addListener(async () => {
  ensureScanAlarm();
  const settings = await getSettings();
  await applyMonitoringState(settings.monitoringEnabled !== false);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if (changes.monitoringEnabled) {
    applyMonitoringState(changes.monitoringEnabled.newValue !== false).catch(console.warn);
  }

  if (changes.autoRemoveEnabled?.newValue === true) {
    scanFreshQueuePage().catch(console.warn);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SCAN_ALARM) scanFreshQueuePage().catch(console.warn);
  if (alarm.name === RELOAD_ALARM) reloadQueueTabWhenIdle().catch(console.warn);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  if (!QUEUE_URL_PATTERNS.some((pattern) => tab.url.startsWith(pattern.replace(/\*$/, '')))) return;
  scanFreshQueuePage().catch(console.warn);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'requestFreshQueueScan') {
    scanFreshQueuePage()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

});

ensureScanAlarm();
getSettings()
  .then((settings) => applyMonitoringState(settings.monitoringEnabled !== false))
  .catch((error) => console.warn('Could not initialize Chamber Queue monitor:', error));
