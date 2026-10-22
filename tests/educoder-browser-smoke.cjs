'use strict';
// Optional whole-script browser fixture. No requests reach a course platform.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const source = fs.readFileSync(path.join(__dirname, '..', 'fuck-educoder-paste.user.js'), 'utf8');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => route.request().url() === 'https://example.educoder.net/'
      ? route.fulfill({ contentType: 'text/html', body: '<textarea id="a">    old</textarea><input id="b"><div class="ant-message">saved</div><iframe srcdoc="<textarea>frame</textarea>"></iframe>' })
      : route.abort());
    await context.addInitScript({ content: source });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://example.educoder.net/');
    await page.waitForFunction(() => window.__pastePatchStatus?.().documentCount >= 2);
    const result = await page.evaluate(async () => {
      const a = document.querySelector('#a'), b = document.querySelector('#b');
      let reads = 0, blockers = 0;
      Object.defineProperty(navigator.clipboard, 'readText', { configurable: true, value: async () => { reads++; return 'late'; } });
      document.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
          blockers++; event.preventDefault();
        }
      });
      a.focus(); a.setSelectionRange(4, 4);
      const data = new DataTransfer(); data.setData('text/plain', 'text');
      const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
      a.dispatchEvent(paste);
      const native = { value: a.value, start: a.selectionStart, end: a.selectionEnd, prevented: paste.defaultPrevented };
      a.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }));
      b.focus(); await Promise.resolve();
      const async = { reads, value: a.value, focus: document.activeElement.id };
      a.focus();
      window.getBlockers = () => blockers;
      return { native, async, notificationDisplay: getComputedStyle(document.querySelector('.ant-message')).display,
        frames: window.__pastePatchStatus().documentCount };
    });
    assert.deepEqual(result.native, { value: '    old', start: 0, end: 4, prevented: false });
    assert.deepEqual(result.async, { reads: 0, value: '    old', focus: 'b' });
    assert.notEqual(result.notificationDisplay, 'none');
    assert.ok(result.frames >= 2, 'parent and loaded same-origin frame must both be installed');
    await page.keyboard.press('Control+A');
    assert.deepEqual(await page.evaluate(() => ({ blockers: getBlockers(), start: document.querySelector('#a').selectionStart,
      end: document.querySelector('#a').selectionEnd })), { blockers: 0, start: 0, end: 7 });
    assert.deepEqual(errors, []);
    console.log('5 Educoder browser checks passed: native range, no delayed paste, notifications, iframe install, shortcut capture.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
