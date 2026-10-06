Chamber Queue Duplicate Monitor - v1.5.0
========================================

Target page
-----------
http://10.0.61.174/admin/memex/chamberqueueitem/

Duplicate rule
--------------
A duplicate exists when the same Program Title appears 2 or more times in #result_list.
Program Titles are compared case-insensitively after whitespace is normalized.

Auto Remove behavior
--------------------
When Auto Remove is ON:
1. Rows are processed in the exact order shown in the table.
2. For each duplicated Program Title, the FIRST occurrence is kept.
3. Every later occurrence of that exact title is selected.
4. All unrelated checkbox selections are cleared first as a safety guard.
5. The extension clicks #remove-selected-button.
6. A native JavaScript OK/Cancel removal confirmation raised during that click
   is automatically accepted. Normal confirmations are restored immediately.

There is a one-second wait before each checkbox click (clearing or selecting)
and before clicking Remove Selected. Native confirm() must return synchronously,
so its OK response remains immediate during the remove-button click.

This matches the queue behavior where the oldest item is first and newer items are appended later.

Popup
-----
Queue Monitor: turns all monitoring on/off. Turning Queue Monitor OFF also turns Auto Remove OFF.
Auto Remove: enables automatic duplicate cleanup. Auto Remove is OFF by default.
The extension popup closes when Auto Remove is enabled with monitoring on.
Scan status: shows how many profiles were scanned and explains a missing table,
missing/disabled remove button, or another reason cleanup could not proceed.

Background operation
--------------------
The extension performs a fresh server-side queue check approximately every 30 seconds while the queue tab remains open.
It can continue while another tab is selected or Chrome is minimized.

When monitoring is enabled, the queue tab is also automatically reloaded every
minute. A reload is skipped while a background scan is running, while the tab
is already loading, or while automatic cleanup is actively selecting/submitting
duplicates.

If the fresh server response contains duplicates but the background tab's DOM is stale, the extension reloads that queue tab.
After the reload, it keeps the first occurrence and removes the later duplicates.

Safety notes
------------
- Keep the Chamber Queue page open and logged in.
- Auto Remove is intentionally OFF after first installation.
- The extension clears all existing row selections immediately before selecting duplicates, preventing unrelated checked rows from being submitted.
- The first/oldest occurrence is never intentionally selected by the cleanup algorithm.
- Only the first native removal/deletion confirmation during the automatic
  button click is accepted. Manual actions still show their normal prompts.
- Custom HTML dialogs or confirmations raised asynchronously require separate handling.

Install / update
----------------
1. Extract the ZIP.
2. Open chrome://extensions/
3. Turn on Developer mode.
4. Replace the older extension's files and click Reload on chrome://extensions/.
5. Choose Load unpacked and select the chamber-queue-duplicate-monitor folder.
6. Open the extension popup.
7. Leave Queue Monitor ON.
8. Turn Auto Remove ON only when you want automatic cleanup enabled.
9. Reload the queue page too, so the updated content script is loaded.

Fixes in 1.4.4
--------------
- Removes the cleanup success notification; the popup scan status still reports submitted duplicates.
- Closes the extension popup after enabling Auto Remove so it stays out of the way.
- One-second action delays and the native removal confirmation handler remain enabled.

Fixes in 1.5.0
--------------
- Reloads the queue tab automatically every minute when monitoring is enabled.
- Skips the timed reload while cleanup or another scan is active.

Fixes in 1.4.3
--------------
- Waits one second before every checkbox click and the remove-button click.

Fixes in 1.4.2
--------------
- Automatically accepts the native removal confirmation for the cleanup click.
- Uses the dev queue host configured in the manifest (10.0.61.174).

Fixes in 1.4.1
--------------
- Background scans use the same queue URL as the manifest.
- One background cleanup routine handles notification, selection, and submission.
- Checkboxes are clicked so the site's selection handlers run before removal.
- Failed clicks release the cleanup lock so later scans can retry.
- Monitoring follows queue tables that are replaced dynamically.
- Automatic checks: node --test tests/*.test.cjs
