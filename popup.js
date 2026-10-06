'use strict';

const monitorToggle = document.getElementById('monitorToggle');
const removeToggle = document.getElementById('removeToggle');
const monitorStatus = document.getElementById('monitorStatus');
const removeStatus = document.getElementById('removeStatus');
const scanStatus = document.getElementById('scanStatus');

function renderScanStatus(state) {
  if (state.monitoringEnabled === false) {
    scanStatus.textContent = 'Monitoring is off.';
  } else if (!state.lastScanAt) {
    scanStatus.textContent = 'Waiting for a queue scan.';
  } else if (state.lastScanOk === false) {
    scanStatus.textContent = `Scan failed: ${state.lastScanError}`;
  } else {
    const cleanupReasons = {
      'table-not-found': 'Queue table #result_list was not found.',
      'remove-button-not-found': 'Remove button #remove-selected-button was not found.',
      'remove-button-disabled': 'Remove button is disabled.',
      'duplicate-checkbox-disabled': 'A duplicate checkbox is disabled.',
      'selected-checkbox-disabled': 'A checked row is disabled; cleanup was stopped.',
      'selection-changed-before-submit': 'The page changed before removal; cleanup will retry.',
      'no-live-duplicates': 'Refreshing the queue to load duplicates.',
      'remove-click-failed': 'Could not click the remove button.'
    };
    const cleanup = state.autoRemoveEnabled && state.lastCleanupStatus
      ? ` ${cleanupReasons[state.lastCleanupStatus] || state.lastCleanupStatus}` : '';
    scanStatus.textContent = `Scanned ${state.lastTitleCount ?? 0} profiles.${cleanup}${state.lastCleanupError ? ` ${state.lastCleanupError}` : ''}`;
  }
}

function render(monitoringEnabled, autoRemoveEnabled) {
  monitorToggle.checked = monitoringEnabled;
  removeToggle.checked = autoRemoveEnabled;
  removeToggle.disabled = !monitoringEnabled;
  monitorStatus.textContent = monitoringEnabled ? 'On' : 'Off';
  removeStatus.textContent = autoRemoveEnabled ? 'On' : 'Off';
}

async function loadState() {
  const state = await chrome.storage.local.get({
    monitoringEnabled: true,
    autoRemoveEnabled: false,
    lastScanAt: null,
    lastScanOk: null,
    lastScanError: '',
    lastTitleCount: null,
    lastCleanupStatus: '',
    lastCleanupError: ''
  });
  render(state.monitoringEnabled !== false, state.autoRemoveEnabled === true);
  renderScanStatus(state);
}

monitorToggle.addEventListener('change', async () => {
  const enabled = monitorToggle.checked;

  if (!enabled) {
    render(false, false);
    await chrome.storage.local.set({
      monitoringEnabled: false,
      autoRemoveEnabled: false
    });
    return;
  }

  const current = await chrome.storage.local.get({ autoRemoveEnabled: false });
  render(true, current.autoRemoveEnabled === true);
  await chrome.storage.local.set({ monitoringEnabled: true });
});

removeToggle.addEventListener('change', async () => {
  const enabled = removeToggle.checked;
  const current = await chrome.storage.local.get({ monitoringEnabled: true });
  render(current.monitoringEnabled !== false, enabled);
  await chrome.storage.local.set({ autoRemoveEnabled: enabled });
  if (enabled && current.monitoringEnabled !== false) {
    // Close the extension panel before the delayed page actions begin.
    window.close();
  }
});

chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === 'local') loadState().catch(console.warn);
});

loadState().catch(console.warn);
