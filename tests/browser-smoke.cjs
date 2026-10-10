'use strict';
// Optional integration smoke: node tests/browser-smoke.cjs
// Requires preinstalled Playwright and Chromium; no installation or network access.
// Runs the WHOLE userscript at document-start on a locally fulfilled fixture URL.
// Clipboard events are synthetic. UEditor and CodeMirror are API mocks, NOT real libraries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const source = fs.readFileSync(process.env.USERSCRIPT_PATH || path.join(__dirname, '..', 'fuck-educoder-paste.user.js'), 'utf8');
const fixture = '<!doctype html><meta charset="utf-8"><div id="a" contenteditable="true">before</div><div id="b" contenteditable="true">other</div><input id="plain">';
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-background-networking'] });
  let passed = 0;
  try {
    async function run(name, body) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', route => route.request().url() === 'https://example.chaoxing.com/'
        ? route.fulfill({ status: 200, contentType: 'text/html', body: fixture }) : route.abort());
      await context.addInitScript({ content: source });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto('https://example.chaoxing.com/');
        await page.waitForFunction(() => typeof window.__pasteText === 'function');
        await page.evaluate(() => {
          window.selectHost = (host, from = 0, to = host.textContent.length) => {
            host.focus();
            const doc = host.ownerDocument, selection = doc.defaultView.getSelection();
            const range = doc.createRange();
            range.setStart(host.firstChild || host, from);
            range.setEnd(host.firstChild || host, to);
            selection.removeAllRanges(); selection.addRange(range);
          };
          window.paste = (host, text) => {
            const win = host.ownerDocument.defaultView;
            const data = new win.DataTransfer(); data.setData('text/plain', text);
            const event = new win.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
            host.dispatchEvent(event);
            return event.defaultPrevented;
          };
        });
        await body(page);
        assert.deepEqual(errors, [], 'uncaught browser exceptions');
        console.log(`PASS ${name}`); passed++;
      } finally { await context.close(); }
    }
    await run('generic rich: escaped multiline text, selection replacement, native undo', async page => {
      const result = await page.evaluate(() => {
        const a = document.querySelector('#a'); selectHost(a);
        const cancelled = paste(a, '<b>&hello</b>\nsecond');
        const text = a.innerText, hasMarkup = !!a.querySelector('b');
        const undo = document.execCommand('undo');
        return { cancelled, text, hasMarkup, undo, restored: a.textContent };
      });
      assert.deepEqual(result, { cancelled: true, text: '<b>&hello</b>\nsecond', hasMarkup: false, undo: true, restored: 'before' });
    });
    await run('focus switching does not paste into stale rich selection', async page => {
      const result = await page.evaluate(() => {
        const a = document.querySelector('#a'), b = document.querySelector('#b');
        selectHost(a); selectHost(b); paste(b, 'new');
        document.querySelector('#plain').focus();
        const stale = window.__pasteText('wrong');
        return { a: a.textContent, b: b.textContent, plain: document.querySelector('#plain').value, stale };
      });
      assert.deepEqual(result, { a: 'before', b: 'new', plain: '', stale: false });
    });
    await run('dynamically mounted contenteditable receives paste', async page => {
      const result = await page.evaluate(() => {
        const host = document.createElement('div'); host.contentEditable = 'true'; host.textContent = 'dynamic'; document.body.append(host);
        selectHost(host); const cancelled = paste(host, 'mounted');
        return { cancelled, text: host.textContent };
      });
      assert.deepEqual(result, { cancelled: true, text: 'mounted' });
    });
    await run('same-origin iframe rich paste and native undo', async page => {
      await page.evaluate(() => { const frame = document.createElement('iframe'); frame.id = 'frame'; frame.srcdoc = '<div id="rich" contenteditable="true">frame old</div>'; document.body.append(frame); });
      await page.waitForFunction(() => document.querySelector('#frame').contentDocument.querySelector('#rich'));
      const result = await page.evaluate(() => {
        window.__pastePatchInstall();
        const doc = document.querySelector('#frame').contentDocument, host = doc.querySelector('#rich');
        selectHost(host); const cancelled = paste(host, 'frame\n<&>');
        const text = host.innerText; const undo = doc.execCommand('undo');
        return { cancelled, text, undo, restored: host.textContent, parent: document.querySelector('#a').textContent };
      });
      assert.deepEqual(result, { cancelled: true, text: 'frame\n<&>', undo: true, restored: 'frame old', parent: 'before' });
    });
    await run('mock UEditor: verified selection, command API, native undo integration', async page => {
      const result = await page.evaluate(() => {
        const host = document.querySelector('#a'); const commands = [], bounds = [], syncs = [];
        let range;
        window.UE = { instants: { fixture: {
          document, body: host,
          queryCommandState: () => 0,
          selection: { getRange: () => ({
            setStart(node, offset) { bounds.push(['start', node === host.firstChild, offset]); range = document.createRange(); range.setStart(node, offset); },
            setEnd(node, offset) { bounds.push(['end', node === host.firstChild, offset]); range.setEnd(node, offset); },
            select() { const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
          }) },
          execCommand(name, html) { commands.push([name, html]); return document.execCommand(name, false, html); },
          sync() { syncs.push(true); }
        } } };
        selectHost(host, 1, 4); const cancelled = paste(host, '<x>\nY');
        const text = host.innerText; const undo = document.execCommand('undo');
        return { cancelled, text, undo, restored: host.textContent, commands, bounds, syncs: syncs.length };
      });
      assert.equal(result.cancelled, true); assert.equal(result.text, 'b<x>\nYre');
      assert.equal(result.undo, true); assert.equal(result.restored, 'before');
      assert.equal(result.commands.length, 1); assert.equal(result.commands[0][0], 'insertHTML');
      assert.ok(result.commands[0][1].includes('&lt;x&gt;'));
      assert.deepEqual(result.bounds, [['start', true, 1], ['end', true, 4]]); assert.equal(result.syncs, 1);
    });
    await run('mock CodeMirror: model replacement and native event routing', async page => {
      const result = await page.evaluate(() => {
        const wrapper = document.createElement('div'); wrapper.className = 'CodeMirror';
        const input = document.createElement('textarea'); wrapper.append(input); document.body.append(wrapper);
        let value = 'old code', selected = true; const calls = [];
        const cm = { getOption: () => false, getValue: () => value, getDoc: () => cm,
          getWrapperElement: () => wrapper, getInputField: () => input,
          listSelections: () => [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: selected ? 8 : 0 } }],
          operation: fn => fn(), replaceSelection(text, collapse, origin) { calls.push({ text, collapse, origin }); value = text; selected = false; }, save() {} };
        wrapper.CodeMirror = cm; window.__pastePatchInstall(); input.focus();
        const cancelled = paste(input, 'a\n  b');
        document.querySelector('#plain').focus(); const stale = window.__pasteText('wrong');
        return { cancelled, value, calls, stale };
      });
      assert.deepEqual(result, { cancelled: true, value: 'a\n  b', calls: [{ text: 'a\n  b', collapse: 'end', origin: 'paste' }], stale: false });
    });
    console.log(`${passed} local browser smoke checks passed. Mock editor APIs; no live-site or real-library claim.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
