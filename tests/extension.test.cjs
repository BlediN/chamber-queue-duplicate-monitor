const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const checkboxSelector = 'input.action-select[name="_selected_action"]';
const queueUrl = manifest.content_scripts[0].matches[0].replace(/\*$/, '');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Chrome and DOM fixtures run the actual serialized injected functions in a
// separate page context. No extension logic is copied into the test harness.
async function setup(titles = [], options = {}) {
  const log = [];
  const rows = titles.map((title, index) => {
    const checkbox = {
      value: String(index + 1), checked: !!options.checked?.includes(index),
      disabled: !!options.disabled?.includes(index), isConnected: true,
      click() {
        if (this.disabled) return;
        this.checked = !this.checked;
        log.push(`checkbox:${this.value}:${this.checked}`);
        options.onCheckboxClick?.(this, rows);
      }
    };
    return {
      title, checkbox,
      querySelector(selector) {
        if (selector === '.field-title') return { textContent: this.title };
        if (selector === checkboxSelector) return this.checkbox;
        throw new Error(`Unexpected row selector ${selector}`);
      }
    };
  });
  const table = {
    isConnected: true,
    querySelectorAll(selector) {
      if (selector === 'tbody tr') return rows;
      if (selector === checkboxSelector) return rows.map((row) => row.checkbox);
      if (selector === 'tbody tr .field-title') return rows.map((row) => ({ textContent: row.title }));
      throw new Error(`Unexpected table selector ${selector}`);
    }
  };
  const button = {
    disabled: !!options.buttonDisabled, isConnected: true,
    getAttribute: () => null,
    click() {
      options.onRemoveClick?.(page.window);
      if (options.throwOnClick) throw new Error('Click failed');
      log.push('remove');
    }
  };
  const freshTitles = options.freshTitles || titles;
  const freshTable = {
    querySelectorAll: () => freshTitles.map((title) => ({ textContent: title }))
  };
  const page = vm.createContext({
    window: {
      location: { href: queueUrl },
      confirm(message) { log.push(`manual-confirm:${message}`); return false; }
    },
    document: { querySelector: (selector) => selector === '#result_list'
      ? (options.missingLiveTable ? null : table) : (options.missingButton ? null : button) },
    fetch: async () => ({ ok: true, status: 200, url: queueUrl, text: async () => '<html></html>' }),
    DOMParser: class {
      parseFromString() { return { querySelector: () => options.missingFreshTable ? null : freshTable }; }
    },
    setTimeout: (callback, delay) => {
      log.push(`wait:${delay}`);
      return setTimeout(() => { options.beforeSubmit?.(table, rows); callback(); }, 0);
    }
  });
  const local = { monitoringEnabled: false, autoRemoveEnabled: false };
  const session = {};
  function storage(data) {
    return {
      async get(defaults) {
        if (Array.isArray(defaults)) return Object.fromEntries(defaults.map((key) => [key, data[key]]));
        return { ...defaults, ...data };
      },
      async set(values) { Object.assign(data, values); }
    };
  }
  const chrome = {
    runtime: { getManifest: () => manifest, onInstalled: event(), onStartup: event(), onMessage: event() },
    storage: { local: storage(local), session: storage(session), onChanged: event() },
    action: {
      async setBadgeText({ text }) { log.push(`badge:${text}`); },
      async setBadgeBackgroundColor() {}
    },
    notifications: {
      async clear() {},
      async create(id) { log.push(`notification:${id}`); options.onNotification?.(id, local); }
    },
    alarms: { create() {}, onAlarm: event() },
    tabs: {
      onUpdated: event(),
      async query({ url }) {
        log.push('query');
        return url.includes(`${queueUrl}*`) && !options.noTab ? [{ id: 7, url: queueUrl }] : [];
      },
      async reload(id) { log.push(`reload:${id}`); }
    },
    scripting: {
      async executeScript({ func, world, target }) {
        assert.equal(world, 'MAIN');
        assert.equal(target.tabId, 7);
        const result = await vm.runInContext(`(${func.toString()})()`, page);
        return [{ result }];
      }
    }
  };
  const context = vm.createContext({ chrome, console: { warn() {} }, setTimeout });
  vm.runInContext(background, context);
  await settle();
  log.length = 0;
  Object.assign(local, { monitoringEnabled: true, autoRemoveEnabled: true });
  return {
    log, rows, local, page, button, chrome,
    scan: () => vm.runInContext('scanFreshQueuePage()', context),
    cleanup: () => vm.runInContext('executeAutoCleanupInTab(7)', context)
  };
}

test('configured queue URL is scanned and submitted without a cleanup notification', async () => {
  const app = await setup(['Profile A', 'Profile A']);
  await app.scan();
  assert.equal(app.local.lastScanOk, true);
  assert.equal(app.local.lastTitleCount, 2);
  assert.deepEqual(app.rows.map((row) => row.checkbox.checked), [false, true]);
  assert.equal(app.log.filter((entry) => entry === 'remove').length, 1);
  const warning = app.log.indexOf('notification:chamber-queue-duplicate-warning');
  const removal = app.log.indexOf('remove');
  const submitted = app.log.indexOf('notification:chamber-queue-cleanup-submitted');
  assert.ok(warning >= 0 && warning < removal);
  assert.equal(submitted, -1);
});

test('each normalized profile keeps one unchecked and unrelated selections are cleared', async () => {
  const app = await setup(['  Alpha   Name ', 'Unique', 'alpha name', 'ALPHA NAME', 'Beta', ' beta '], { checked: [0, 1, 4] });
  await app.scan();
  assert.deepEqual(app.rows.map((row) => row.checkbox.checked), [false, false, true, true, false, true]);
  assert.equal(app.local.lastCleanupStatus, 'Submitted 3 duplicates for removal.');
  assert.ok(app.log.includes('checkbox:1:false'));
  assert.ok(app.log.includes('checkbox:3:true'));
});

test('every checkbox action and removal waits one second first', async () => {
  const app = await setup(['A', 'A', 'A', 'Unique'], { checked: [0, 3] });
  await app.cleanup();
  assert.deepEqual(app.log, [
    'wait:1000', 'checkbox:1:false',
    'wait:1000', 'checkbox:4:false',
    'wait:1000', 'checkbox:2:true',
    'wait:1000', 'checkbox:3:true',
    'wait:1000', 'remove'
  ]);
});

test('checkbox clicks allow the site to enable its remove button', async () => {
  let app;
  app = await setup(['A', 'A'], {
    buttonDisabled: true,
    onCheckboxClick(_checkbox, rows) { app.button.disabled = !rows.some((row) => row.checkbox.checked); }
  });
  await app.scan();
  assert.ok(app.log.includes('remove'));
});

test('unique profiles do not trigger selection or removal', async () => {
  const app = await setup(['A', 'B']);
  await app.scan();
  assert.ok(!app.log.includes('remove'));
  assert.ok(!app.log.some((entry) => entry.startsWith('checkbox:')));
});

test('Auto Remove off still detects duplicates without selecting them', async () => {
  const app = await setup(['A', 'A']);
  app.local.autoRemoveEnabled = false;
  await app.scan();
  assert.ok(app.log.includes('notification:chamber-queue-duplicate-warning'));
  assert.ok(!app.log.includes('remove'));
  assert.deepEqual(app.rows.map((row) => row.checkbox.checked), [false, false]);
});

test('monitoring off performs no queue scan', async () => {
  const app = await setup(['A', 'A']);
  app.local.monitoringEnabled = false;
  await app.scan();
  assert.deepEqual(app.log, []);
});

test('missing and disabled buttons report why submission did not happen', async () => {
  for (const options of [{ missingButton: true }, { buttonDisabled: true }]) {
    const app = await setup(['A', 'A'], options);
    await app.scan();
    assert.equal(app.local.lastCleanupStatus, options.missingButton ? 'remove-button-not-found' : 'remove-button-disabled');
    assert.ok(!app.log.includes('remove'));
    assert.ok(!app.log.includes('notification:chamber-queue-cleanup-submitted'));
  }
});

test('failed clicks release the cleanup lock and a later scan retries', async () => {
  const options = { throwOnClick: true };
  const app = await setup(['A', 'A'], options);
  await app.scan();
  assert.equal(app.local.lastCleanupStatus, 'remove-click-failed');
  assert.equal(app.page.window.__chamberQueueAutoRemoving, false);
  options.throwOnClick = false;
  await app.scan();
  assert.ok(app.log.includes('remove'));
});

test('native removal confirmation is accepted and manual confirmation is restored', async () => {
  let accepted;
  const app = await setup(['A', 'A'], {
    onRemoveClick(window) { accepted = window.confirm('Do you want to remove this?'); }
  });
  const originalConfirm = app.page.window.confirm;
  const result = await app.cleanup();
  assert.equal(accepted, true);
  assert.equal(result.confirmationAccepted, true);
  assert.equal(app.page.window.confirm, originalConfirm);
  assert.equal(app.page.window.confirm('Do you want to remove this?'), false);
});

test('unrelated confirmations during the remove click keep their normal behavior', async () => {
  let accepted;
  const app = await setup(['A', 'A'], {
    onRemoveClick(window) { accepted = window.confirm('Do you want to leave this page?'); }
  });
  const result = await app.cleanup();
  assert.equal(accepted, false);
  assert.equal(result.confirmationAccepted, false);
  assert.ok(app.log.includes('manual-confirm:Do you want to leave this page?'));
});

test('only one removal confirmation per automatic click is accepted', async () => {
  const answers = [];
  const app = await setup(['A', 'A'], {
    onRemoveClick(window) {
      answers.push(window.confirm('Delete selected items?'));
      answers.push(window.confirm('Delete something else?'));
    }
  });
  await app.cleanup();
  assert.deepEqual(answers, [true, false]);
});

test('normal confirmations are restored even when the button click fails', async () => {
  const app = await setup(['A', 'A'], {
    throwOnClick: true,
    onRemoveClick(window) { assert.equal(window.confirm('Remove selected items?'), true); }
  });
  const originalConfirm = app.page.window.confirm;
  const result = await app.cleanup();
  assert.equal(result.reason, 'remove-click-failed');
  assert.equal(app.page.window.confirm, originalConfirm);
  assert.equal(app.page.window.__chamberQueueAutoRemoving, false);
});

test('changed selections stop removal', async () => {
  const app = await setup(['A', 'A'], { beforeSubmit(_table, rows) { rows[0].checkbox.checked = true; } });
  await app.scan();
  assert.equal(app.local.lastCleanupStatus, 'selection-changed-before-submit');
  assert.ok(!app.log.includes('remove'));
});

test('disabled checked unrelated rows stop cleanup', async () => {
  const app = await setup(['A', 'A', 'Unique'], { checked: [2], disabled: [2] });
  await app.scan();
  assert.equal(app.local.lastCleanupStatus, 'selected-checkbox-disabled');
  assert.ok(!app.log.includes('remove'));
});

test('stale live queue reloads when fresh server results have duplicates', async () => {
  const app = await setup(['A'], { freshTitles: ['A', 'A'] });
  await app.scan();
  assert.ok(app.log.includes('reload:7'));
  assert.ok(!app.log.includes('remove'));
});

test('overlapping scan requests submit only once', async () => {
  const app = await setup(['A', 'A']);
  await Promise.all([app.scan(), app.scan(), app.scan()]);
  assert.equal(app.log.filter((entry) => entry === 'remove').length, 1);
});

test('turning Auto Remove off while detection runs prevents cleanup', async () => {
  const app = await setup(['A', 'A'], { onNotification(_id, local) { local.autoRemoveEnabled = false; } });
  await app.scan();
  assert.ok(!app.log.includes('remove'));
});

test('unavailable tab and missing server table produce scan errors', async () => {
  for (const options of [{ noTab: true }, { missingFreshTable: true }]) {
    const app = await setup(['A', 'A'], options);
    await app.scan();
    assert.equal(app.local.lastScanOk, false);
    assert.match(app.local.lastScanError, options.noTab ? /tab is not open/ : /#result_list/);
    assert.ok(!app.log.includes('remove'));
  }
});

test('content observer reattaches when the queue table is replaced', () => {
  const observers = [];
  const timers = new Map();
  let timerId = 0;
  let table = {};
  const messages = [];
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  }
  const context = vm.createContext({
    document: { documentElement: {}, querySelector: () => table }, MutationObserver,
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    chrome: { runtime: { sendMessage(message) { messages.push(message.type); return Promise.resolve(); } } }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'content.js'), 'utf8'), context);
  const oldObserver = observers[0];
  const documentObserver = observers[1];
  table = {};
  documentObserver.callback();
  assert.equal(oldObserver.disconnected, true);
  assert.equal(observers[2].target, table);
  for (const callback of timers.values()) callback();
  assert.deepEqual(messages, ['requestFreshQueueScan']);
  assert.equal(documentObserver.disconnected, undefined);
});

test('enabling Auto Remove saves the setting before closing the popup', async () => {
  const elements = new Map();
  const calls = [];
  const state = { monitoringEnabled: true, autoRemoveEnabled: false };
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          checked: false, textContent: '', listeners: {},
          addEventListener(type, callback) { this.listeners[type] = callback; }
        });
      }
      return elements.get(id);
    }
  };
  const context = vm.createContext({
    document, console,
    window: { close() { calls.push('close'); } },
    chrome: {
      storage: {
        local: {
          async get(defaults) { return { ...defaults, ...state }; },
          async set(values) { Object.assign(state, values); calls.push(`saved:${values.autoRemoveEnabled}`); }
        },
        onChanged: event()
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'popup.js'), 'utf8'), context);
  await settle();
  const removeToggle = elements.get('removeToggle');
  removeToggle.checked = true;
  await removeToggle.listeners.change();
  assert.deepEqual(calls, ['saved:true', 'close']);
  assert.equal(state.autoRemoveEnabled, true);

  calls.length = 0;
  removeToggle.checked = false;
  await removeToggle.listeners.change();
  assert.deepEqual(calls, ['saved:false']);
});
