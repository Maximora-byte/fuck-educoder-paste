'use strict';

// Isolated tests for the actual userscript helpers; no page or network access.
// SCRIPT_PATH (or USERSCRIPT_PATH) can check the unmodified release as a baseline.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(process.env.SCRIPT_PATH || process.env.USERSCRIPT_PATH || path.join(__dirname, '..', 'fuck-educoder-paste.user.js'), 'utf8');
function extractFunction(name) {
  const pattern = new RegExp(`^( +)function ${name}\\(`, 'm');
  const match = pattern.exec(source);
  assert.ok(match, `Missing userscript helper: ${name}`);
  const start = match.index;
  const end = source.indexOf(`\n${match[1]}}`, start);
  assert.notEqual(end, -1, `Missing end of helper: ${name}`);
  return source.slice(start, end + match[1].length + 2);
}

function element(tag = 'div', attrs = {}, parentElement = null) {
  return {
    nodeType: 1, tagName: tag.toUpperCase(), className: attrs.class || '', id: attrs.id || '',
    isContentEditable: false, isConnected: true, parentElement, ownerDocument: parentElement?.ownerDocument || null,
    contains(node) { for (let cur = node; cur; cur = cur.parentElement) if (cur === this) return true; return false; },
    focus() { this.ownerDocument.activeElement = this; },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    closest() { return null; }
  };
}
function harness() {
  const sandbox = {
    state: { richDocs: new Set(), codeMirrors: new Set(), richRanges: new WeakMap(), lastTarget: null, lastTargetAt: 0, remember() {} },
    window: {}, patched: [], inserted: [],
    insertIntoRichEditor(route, text) { sandbox.inserted.push({ route, text }); return true; },
    insertIntoCodeMirror(cm, text) { sandbox.inserted.push({ cm, text }); return true; },
    patchRichDoc(doc) { sandbox.patched.push(doc); },
    eventPath(e) { return e.path || [e.target]; },
    isPasteCatcherNode() { return false; },
    getFrameElement(win) { return win?.frameElement || null; },
    isTopWindow() { return true; },
    getWin(doc) { return doc.defaultView; }
  };
  vm.createContext(sandbox);
  const names = ['lower', 'getDoc', 'toElement', 'isPlainInput', 'isEditableElement',
    'closestEditableHost', 'findCodeMirrorFromElement', 'findCodeMirrorFromEvent',
    'hasRichEditorMarks', 'looksLikeRichFrame', 'looksLikeRichDoc',
    'getDefaultRichHost', 'richRouteFromEvent', 'routeFromEvent',
    'isPasteKey', 'isPasteLikeEvent', 'shouldSuppressExternalPasteListener',
    'shouldNeutralizePasteBlocker', 'activeRoute', 'rangeBelongsToDoc', 'saveRichRange',
    'ensureRichRange', 'focusRichDoc', 'insertByRoute'];
  for (const name of ['isExplicitlyNonEditable', 'documentHasFocus', 'rangeBelongsToRichHost', 'isCurrentRoute', 'capturePasteRoute', 'matchesPasteRoute', 'shouldUseLastRichRoute']) {
    if (source.includes(`function ${name}(`)) names.push(name);
  }
  vm.runInContext(names.map(extractFunction).join('\n'), sandbox);
  return sandbox;
}
function makeDocument() {
  const doc = { nodeType: 9, designMode: 'off', focused: true, hasFocus() { return this.focused; },
    querySelector() { return null; }, defaultView: {}, createRange() { return makeRange(this.body); } }; 
  doc.body = element('body');
  doc.documentElement = element('html');
  doc.body.ownerDocument = doc;
  doc.documentElement.ownerDocument = doc;
  doc.body.parentElement = doc.documentElement;
  doc.activeElement = doc.body;
  doc.defaultView.document = doc;
  doc.defaultView.getSelection = () => doc.selection;
  doc.defaultView.focus = () => {};
  doc.selection = makeSelection();
  return doc;
}

test('a missing contenteditable attribute is not an empty editable attribute', () => {
  const h = harness();
  assert.equal(h.isEditableElement(element()), false);
  assert.equal(h.closestEditableHost(element()), null);
  assert.equal(h.isEditableElement(element('div', { contenteditable: '' })), true);
  assert.equal(h.isEditableElement(element('div', { contenteditable: 'true' })), true);
  assert.equal(h.isEditableElement(element('div', { contenteditable: 'plaintext-only' })), true);
  assert.equal(h.isEditableElement(element('div', { contenteditable: 'false' })), false);
  assert.equal(h.isEditableElement(element('div', { contenteditable: 'inherit' })), false);
  assert.equal(h.isEditableElement(element('div', { contenteditable: 'TRUE' })), true);
});

test('an ordinary descendant resolves to its actual editable ancestor', () => {
  const h = harness();
  const host = element('div', { contenteditable: '' });
  const child = element('span', {}, host);
  assert.equal(h.closestEditableHost(child), host);
});

test('explicit contenteditable=false stops host lookup, including editor-looking nodes', () => {
  const h = harness();
  const host = element('div', { contenteditable: 'true' });
  const blocked = element('div', { contenteditable: 'false', role: 'textbox', class: 'ql-editor' }, host);
  assert.equal(h.closestEditableHost(blocked), null);
  assert.equal(h.closestEditableHost(element('span', {}, blocked)), null);
  const reopened = element('div', { contenteditable: 'true' }, blocked);
  assert.equal(h.closestEditableHost(reopened), reopened);
});

test('plain form inputs are not rich editor hosts', () => {
  const h = harness();
  const host = element('div', { contenteditable: 'true' });
  for (const tag of ['input', 'textarea', 'select']) {
    assert.equal(h.closestEditableHost(element(tag, {}, host)), null);
  }
});

test('plain documents stay ordinary while designMode and editable bodies are recognized', () => {
  const h = harness();
  const doc = makeDocument();
  assert.equal(h.looksLikeRichDoc(doc), false);
  doc.designMode = 'on';
  assert.equal(h.looksLikeRichDoc(doc), true);
  doc.designMode = 'off';
  doc.body.isContentEditable = true;
  assert.equal(h.looksLikeRichDoc(doc), true);
});

test('paste in a plain textarea is not redirected to a recently used CodeMirror', () => {
  const h = harness();
  const doc = makeDocument();
  const textarea = element('textarea', {}, doc.body);
  doc.activeElement = textarea;
  h.state.lastTarget = { type: 'codemirror', cm: {} };
  h.state.lastTargetAt = Date.now();
  assert.equal(h.routeFromEvent({ type: 'paste', target: textarea }), null);
});

test('a CodeMirror textarea still takes its own editor route', () => {
  const h = harness();
  const doc = makeDocument();
  const cm = {};
  const textarea = element('textarea', {}, doc.body);
  textarea.closest = selector => selector === '.CodeMirror' ? { CodeMirror: cm } : null;
  const route = h.routeFromEvent({ type: 'paste', target: textarea });
  assert.equal(route.type, 'codemirror');
  assert.equal(route.cm, cm);
});

test('rich-document fallback cannot bypass an explicit noneditable boundary', () => {
  const h = harness();
  const doc = makeDocument();
  const host = element('div', { contenteditable: 'true' }, doc.body);
  const blocked = element('div', { contenteditable: 'false' }, host);
  const child = element('span', {}, blocked);
  doc.activeElement = host;
  h.state.richDocs.add(doc);
  assert.equal(h.routeFromEvent({ type: 'paste', target: child }), null);
});

test('noneditable descendants retain their own paste listeners and event controls', () => {
  const h = harness();
  const doc = makeDocument();
  doc.designMode = 'on';
  const blocked = element('div', { contenteditable: 'false' }, doc.body);
  const child = element('span', {}, blocked);
  h.state.richDocs.add(doc);
  h.state.activePasteSession = { startedAt: Date.now() };
  const event = { type: 'paste', target: child };
  assert.equal(h.shouldSuppressExternalPasteListener(event, 'paste'), false);
  assert.equal(h.shouldNeutralizePasteBlocker(event), false);
});

test('editable and plaintext-only hosts still get a rich paste route', () => {
  const h = harness();
  const doc = makeDocument();
  for (const value of ['', 'true', 'plaintext-only']) {
    const host = element('div', { contenteditable: value }, doc.body);
    const route = h.routeFromEvent({ type: 'paste', target: host });
    assert.equal(route.type, 'rich');
    assert.equal(route.el, host);
  }
});

function makeRange(start, end = start) {
  const ancestors = [];
  for (let cur = start; cur; cur = cur.parentElement) ancestors.push(cur);
  let common = end;
  while (common && !ancestors.includes(common)) common = common.parentElement;
  return { startContainer: start, startOffset: 0, endContainer: end, endOffset: 0, commonAncestorContainer: common,
    collapsed: start === end, cloneRange() { return makeRange(this.startContainer, this.endContainer); },
    selectNodeContents(host) { this.startContainer = this.endContainer = this.commonAncestorContainer = host; },
    collapse() { this.collapsed = true; } };
}
function makeSelection(...ranges) {
  return { ranges, get rangeCount() { return this.ranges.length; }, getRangeAt(i) { return this.ranges[i]; },
    removeAllRanges() { this.ranges = []; }, addRange(range) { this.ranges.push(range); } };
}
function setupRich() {
  const h = harness();
  const doc = makeDocument();
  const a = element('div', { contenteditable: 'true' }, doc.body);
  const b = element('div', { contenteditable: 'true' }, doc.body);
  const chrome = element('button', {}, doc.body);
  doc.activeElement = a;
  doc.selection = makeSelection(makeRange(a));
  h.state.richDocs.add(doc);
  h.state.lastTarget = { type: 'rich', doc, el: a };
  h.state.lastTargetAt = Date.now();
  return { h, doc, a, b, chrome };
}

test('an ordinary sibling cannot inherit a rich-document route or stale selection', () => {
  const { h, doc, a, chrome } = setupRich();
  doc.selection = makeSelection(makeRange(a));
  h.state.richRanges.set(doc, makeRange(a));
  const event = { type: 'paste', target: chrome, path: [chrome, doc, a] };
  assert.equal(h.routeFromEvent(event), null);
  assert.equal(h.getDefaultRichHost(doc, chrome), null);
  assert.equal(h.getDefaultRichHost(doc, doc.body), null);
  assert.equal(h.shouldSuppressExternalPasteListener(event, 'paste'), false);
  assert.equal(h.shouldNeutralizePasteBlocker(event), false);
});

test('editor-like classes, IDs and roles alone never authorize insertion', () => {
  const h = harness();
  const doc = makeDocument();
  const chrome = element('div', { role: 'textbox', class: 'edui-body-container ql-editor', id: 'ueditor' }, doc.body);
  assert.equal(h.closestEditableHost(chrome), null);
  assert.equal(h.getDefaultRichHost(doc, chrome), null);
});

test('document/window events require a currently focused editable host', () => {
  const { h, doc, a, chrome } = setupRich();
  assert.equal(h.routeFromEvent({ type: 'paste', target: doc }).el, a);
  assert.equal(h.routeFromEvent({ type: 'paste', target: doc.defaultView }).el, a);
  doc.activeElement = chrome;
  assert.equal(h.routeFromEvent({ type: 'paste', target: doc }), null);
  doc.activeElement = a;
  doc.focused = false;
  assert.equal(h.routeFromEvent({ type: 'paste', target: doc }), null);
  assert.equal(h.activeRoute(), null);
});

test('activeRoute ignores stale editor selection after focus moves to chrome', () => {
  const { h, doc, a, chrome } = setupRich();
  doc.selection = makeSelection(makeRange(a));
  doc.activeElement = chrome;
  assert.equal(h.activeRoute(), null);
});

test('stale CodeMirror focus and lastTarget cannot steal a sibling paste', () => {
  const h = harness();
  const doc = makeDocument();
  const wrapper = element('div', {}, doc.body);
  const input = element('textarea', {}, wrapper);
  const cm = { getWrapperElement: () => wrapper, getInputField: () => input };
  h.state.codeMirrors.add(cm);
  h.state.lastTarget = { type: 'codemirror', cm };
  h.state.lastTargetAt = Date.now();
  doc.activeElement = input;
  doc.focused = false;
  const elsewhere = element('button', {}, makeDocument().body);
  assert.equal(h.routeFromEvent({ type: 'paste', target: elsewhere }), null);
  assert.equal(h.activeRoute(), null);
});

test('iframe active routes require focused ancestry while designMode remains usable', () => {
  const { h, doc, a } = setupRich();
  const outer = makeDocument();
  const frame = element('iframe', {}, outer.body);
  doc.defaultView.frameElement = frame;
  outer.activeElement = outer.body;
  assert.equal(h.activeRoute(), null);
  outer.activeElement = frame;
  assert.equal(h.activeRoute().el, a);
  doc.designMode = 'on';
  doc.activeElement = doc.body;
  assert.equal(h.activeRoute().el, doc.body);
  assert.equal(h.routeFromEvent({ type: 'paste', target: doc.body }).el, doc.body);
});

test('editable-body events preserve the body as their editing root', () => {
  const h = harness();
  const doc = makeDocument();
  doc.body.isContentEditable = true;
  const child = element('p', {}, doc.body);
  child.isContentEditable = true;
  assert.equal(h.routeFromEvent({ type: 'paste', target: child }).el, doc.body);
});

test('inherited editability resolves one stable host across sibling paragraphs', () => {
  const { h, doc, a } = setupRich();
  const one = element('p', {}, a);
  const two = element('p', {}, a);
  one.isContentEditable = two.isContentEditable = true;
  assert.equal(h.closestEditableHost(one), a);
  doc.selection = makeSelection(makeRange(one, two));
  const range = h.ensureRichRange(doc, a);
  assert.equal(range.startContainer, one);
  assert.equal(range.endContainer, two);
});

test('saved range in editor A never overrides a current range in editor B', () => {
  const { h, doc, a, b } = setupRich();
  h.state.richRanges.set(doc, makeRange(a));
  doc.activeElement = b;
  const current = makeRange(b);
  doc.selection = makeSelection(current);
  assert.equal(h.ensureRichRange(doc, b), current);
});

test('cross-host and outside-editor ranges cannot become insertion ranges', () => {
  const { h, doc, a, b, chrome } = setupRich();
  h.state.richRanges.set(doc, makeRange(a));
  doc.selection = makeSelection(makeRange(a, b));
  assert.equal(h.ensureRichRange(doc, b), null);
  doc.activeElement = b;
  doc.selection = makeSelection(makeRange(chrome));
  assert.equal(h.saveRichRange(doc), false);
});

test('a current caret in the same host takes precedence over an older saved caret', () => {
  const { h, doc, a } = setupRich();
  const one = element('p', {}, a);
  const two = element('p', {}, a);
  one.isContentEditable = two.isContentEditable = true;
  h.state.richRanges.set(doc, makeRange(one));
  const current = makeRange(two);
  doc.selection = makeSelection(current);
  assert.equal(h.ensureRichRange(doc, a), current);
});

test('detached and no-longer-current hosts fail closed at insertion dispatch', () => {
  const { h, doc, a, b } = setupRich();
  const old = { type: 'rich', doc, el: a };
  doc.activeElement = b;
  assert.equal(h.insertByRoute(old, 'text'), false);
  assert.equal(h.inserted.length, 0);
  a.isConnected = false;
  assert.equal(h.getDefaultRichHost(doc, a), null);
});

test('a pending catcher cannot neutralize paste handlers on unrelated chrome', () => {
  const { h, chrome } = setupRich();
  h.state.activePasteSession = { startedAt: Date.now(), catcher: {} };
  assert.equal(h.shouldNeutralizePasteBlocker({ type: 'paste', target: chrome }), false);
});

function installClipboardHelper(h) {
  const start = source.indexOf('    window.__pasteFromClipboard = async () => {');
  const end = source.indexOf('\n    };', start) + 7;
  vm.runInContext(source.slice(start, end), h);
}

test('explicit asynchronous clipboard helper refuses to follow a changed rich host', async () => {
  const { h, doc, b } = setupRich();
  let resolve;
  h.readClipboardText = () => new Promise(done => { resolve = done; });
  h.window.__pasteText = text => h.insertByRoute(h.activeRoute(), text);
  installClipboardHelper(h);
  const pending = h.window.__pasteFromClipboard();
  doc.activeElement = b;
  resolve('text');
  assert.equal(await pending, false);
  assert.equal(h.inserted.length, 0);
});

test('explicit asynchronous clipboard helper rejects a changed CodeMirror model', async () => {
  const h = harness();
  const doc = makeDocument();
  const wrapper = element('div', {}, doc.body);
  const input = element('textarea', {}, wrapper);
  let model = {};
  const cm = { getWrapperElement: () => wrapper, getInputField: () => input, getDoc: () => model, listSelections: () => [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } }] };
  h.state.codeMirrors.add(cm);
  doc.activeElement = input;
  let resolve;
  h.readClipboardText = () => new Promise(done => { resolve = done; });
  h.window.__pasteText = text => h.insertByRoute(h.activeRoute(), text);
  installClipboardHelper(h);
  const pending = h.window.__pasteFromClipboard();
  model = {};
  resolve('text');
  assert.equal(await pending, false);
  assert.equal(h.inserted.length, 0);
});

function catcherFixture(autostart = true) {
  const { h, doc, a, b } = setupRich();
  const callbacks = [];
  const restored = [];
  h.setTimeout = callback => { callbacks.push(callback); return callbacks.length; };
  h.state.addTimer = value => value;
  h.focusRichDoc = (_doc, host) => { restored.push(host); doc.activeElement = host; };
  h.isRecentDuplicate = () => false;
  h.getClipboardTextFromEvent = event => event.text || '';
  h.hardCancel = () => {};
  h.stopOnly = () => {};
  doc.createElement = tag => {
    const node = element(tag);
    node.ownerDocument = doc;
    node.listeners = {};
    node.style = {};
    node.setAttribute = () => {};
    node.addEventListener = (type, listener) => { node.listeners[type] = listener; };
    node.removeEventListener = type => { delete node.listeners[type]; };
    node.select = () => {};
    node.remove = () => { node.isConnected = false; if (doc.activeElement === node) doc.activeElement = doc.body; };
    return node;
  };
  doc.body.appendChild = node => { node.parentElement = doc.body; return node; };
  vm.runInContext(extractFunction('createPasteCatcher'), h);
  const route = { type: 'rich', doc, el: a };
  const session = autostart ? h.createPasteCatcher(route) : null;
  return { h, doc, a, b, session, callbacks, restored };
}

test('catcher completion does not restore focus or insert after the user moves elsewhere', () => {
  const { h, doc, b, session, restored } = catcherFixture();
  const paste = session.catcher.listeners.paste;
  doc.activeElement = b;
  paste({ text: 'text' });
  assert.equal(doc.activeElement, b);
  assert.equal(restored.length, 0);
  assert.equal(h.inserted.length, 0);
});

test('catcher timeout with no text does not restore focus after the user moves elsewhere', async () => {
  const { h, doc, b, callbacks, restored } = catcherFixture();
  h.readClipboardText = async () => { throw new Error('automatic clipboard reads are forbidden'); };
  doc.activeElement = b;
  await callbacks[0]();
  assert.equal(doc.activeElement, b);
  assert.equal(restored.length, 0);
  assert.equal(h.inserted.length, 0);
});

test('focused native catcher restores its editor and inserts exactly once', () => {
  const { h, doc, a, session } = catcherFixture();
  const paste = session.catcher.listeners.paste;
  paste({ text: 'text' });
  paste({ text: 'text' });
  assert.equal(doc.activeElement, a);
  assert.equal(h.inserted.length, 1);
  assert.equal(h.inserted[0].text, 'text');
});

test('paste events with no readable text keep native defaults and never read asynchronously', () => {
  const { h, a } = setupRich();
  let cancelled = false;
  let clipboardReads = 0;
  h.getClipboardTextFromEvent = () => '';
  h.hardCancel = () => { cancelled = true; };
  h.stopOnly = () => {};
  h.readClipboardText = async () => { clipboardReads += 1; return ''; };
  h.isRecentDuplicate = () => false;
  vm.runInContext(extractFunction('handlePasteEvent'), h);
  h.handlePasteEvent({ type: 'paste', target: a });
  assert.equal(cancelled, false);
  assert.equal(clipboardReads, 0);
  assert.equal(h.inserted.length, 0);
});


test('an event-local newly mounted CodeMirror can insert before registration scan', () => {
  const h = harness();
  const doc = makeDocument();
  const wrapper = element('div', {}, doc.body);
  const input = element('textarea', {}, wrapper);
  const cm = { getWrapperElement: () => wrapper, getInputField: () => input };
  input.closest = selector => selector === '.CodeMirror' ? { CodeMirror: cm } : null;
  doc.activeElement = input;
  let cancelled = false;
  h.hardCancel = () => { cancelled = true; };
  h.getClipboardTextFromEvent = () => 'new editor text';
  h.isRecentDuplicate = () => false;
  vm.runInContext(extractFunction('handlePasteEvent'), h);
  h.handlePasteEvent({ type: 'paste', target: input });
  assert.equal(cancelled, true);
  assert.equal(h.state.codeMirrors.size, 0);
  assert.equal(h.inserted.length, 1);
  assert.equal(h.inserted[0].cm, cm);
});

test('empty catcher event allows native input, then inserts that native text once', () => {
  const { h, session } = catcherFixture();
  let cancelled = false;
  let stopped = false;
  h.hardCancel = () => { cancelled = true; };
  h.stopOnly = () => { stopped = true; };
  session.catcher.listeners.paste({ text: '' });
  assert.equal(cancelled, false);
  assert.equal(stopped, true);
  session.catcher.value = 'native text';
  session.catcher.listeners.input();
  assert.equal(h.inserted.length, 1);
  assert.equal(h.inserted[0].text, 'native text');
});

test('async clipboard helper rejects same-host caret changes', async () => {
  const { h, doc, a } = setupRich();
  let resolve;
  h.readClipboardText = () => new Promise(done => { resolve = done; });
  h.window.__pasteText = text => h.insertByRoute(h.activeRoute(), text);
  installClipboardHelper(h);
  const pending = h.window.__pasteFromClipboard();
  const moved = makeRange(a);
  moved.startOffset = moved.endOffset = 1;
  doc.selection = makeSelection(moved);
  resolve('text');
  assert.equal(await pending, false);
  assert.equal(h.inserted.length, 0);
});

test('async clipboard helper rejects CodeMirror cursor changes', async () => {
  const h = harness();
  const doc = makeDocument();
  const wrapper = element('div', {}, doc.body);
  const input = element('textarea', {}, wrapper);
  const model = {};
  let ch = 0;
  const cm = { getWrapperElement: () => wrapper, getInputField: () => input, getDoc: () => model,
    listSelections: () => [{ anchor: { line: 0, ch }, head: { line: 0, ch } }] };
  h.state.codeMirrors.add(cm);
  doc.activeElement = input;
  let resolve;
  h.readClipboardText = () => new Promise(done => { resolve = done; });
  h.window.__pasteText = text => h.insertByRoute(h.activeRoute(), text);
  installClipboardHelper(h);
  const pending = h.window.__pasteFromClipboard();
  ch = 5;
  resolve('text');
  assert.equal(await pending, false);
  assert.equal(h.inserted.length, 0);
});


test('designMode inherited editability never chooses HTML or head as the host', () => {
  const h = harness();
  const doc = makeDocument();
  doc.designMode = 'on';
  doc.documentElement.isContentEditable = doc.body.isContentEditable = true;
  const child = element('p', {}, doc.body);
  child.isContentEditable = true;
  assert.equal(h.routeFromEvent({ type: 'paste', target: child }).el, doc.body);
  assert.equal(h.getDefaultRichHost(doc, doc.documentElement), null);
});

test('a current selection in another host aborts instead of restoring a saved caret', () => {
  const { h, doc, a, b } = setupRich();
  doc.selection = makeSelection(makeRange(a));
  h.state.richRanges.set(doc, makeRange(b));
  assert.equal(h.ensureRichRange(doc, b), null);
  assert.equal(doc.selection.getRangeAt(0).startContainer, a);
});

test('cross-host selection aborts the full paste handler before DOM writes', () => {
  const { h, doc, a, b } = setupRich();
  doc.activeElement = b;
  const selection = makeRange(a, b);
  doc.selection = makeSelection(selection);
  h.getClipboardTextFromEvent = () => 'text';
  h.hardCancel = () => {};
  h.isRecentDuplicate = () => false;
  let writes = 0;
  doc.createElement = () => { writes += 1; throw new Error('must not create insertion nodes'); };
  vm.runInContext(['escapeHTML', 'escapeRichLine', 'plainTextToRichHTML', 'insertIntoRichEditor',
    'insertHTMLByRange', 'handlePasteEvent'].map(extractFunction).join('\n'), h);
  h.handlePasteEvent({ type: 'paste', target: b });
  assert.equal(writes, 0);
  assert.equal(doc.selection.getRangeAt(0), selection);
});

test('missing clipboard text preserves contenteditable CodeMirror event handlers', () => {
  const h = harness();
  const doc = makeDocument();
  const wrapper = element('div', {}, doc.body);
  const input = element('div', { contenteditable: 'true' }, wrapper);
  const cm = { getWrapperElement: () => wrapper, getInputField: () => input };
  input.closest = selector => selector === '.CodeMirror' ? { CodeMirror: cm } : null;
  doc.activeElement = input;
  h.getClipboardTextFromEvent = () => '';
  h.hardCancel = h.stopOnly = () => { throw new Error('must preserve native event'); };
  vm.runInContext(extractFunction('handlePasteEvent'), h);
  const event = { type: 'paste', target: input };
  h.handlePasteEvent(event);
  assert.equal(h.shouldSuppressExternalPasteListener(event, 'paste'), false);
  assert.equal(h.shouldNeutralizePasteBlocker(event), false);
});

test('explicit clipboard helper inserts when the rich host and selection stay unchanged', async () => {
  const { h } = setupRich();
  h.readClipboardText = async () => 'text';
  h.window.__pasteText = text => h.insertByRoute(h.activeRoute(), text);
  installClipboardHelper(h);
  assert.equal(await h.window.__pasteFromClipboard(), true);
  assert.equal(h.inserted.length, 1);
});

test('explicit clipboard helper inserts when the CodeMirror model and cursor stay unchanged', async () => {
  const h = harness();
  const doc = makeDocument();
  const wrapper = element('div', {}, doc.body);
  const input = element('textarea', {}, wrapper);
  const model = {};
  const cm = { getWrapperElement: () => wrapper, getInputField: () => input, getDoc: () => model,
    listSelections: () => [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } }] };
  h.state.codeMirrors.add(cm);
  doc.activeElement = input;
  h.readClipboardText = async () => 'text';
  h.window.__pasteText = text => h.insertByRoute(h.activeRoute(), text);
  installClipboardHelper(h);
  assert.equal(await h.window.__pasteFromClipboard(), true);
  assert.equal(h.inserted.length, 1);
});


test('paste key refuses a cross-host selection despite saved caret, then completes a valid catcher', () => {
  const { h, doc, a, b, callbacks, restored } = catcherFixture(false);
  doc.activeElement = b;
  const invalid = makeRange(a, b);
  doc.selection = makeSelection(invalid);
  h.state.richRanges.set(doc, makeRange(b));
  vm.runInContext(extractFunction('handleKeyDownEvent'), h);
  h.handleKeyDownEvent({ type: 'keydown', key: 'v', ctrlKey: true, target: b });
  assert.equal(h.state.activePasteSession, undefined);
  assert.equal(callbacks.length, 0);
  assert.equal(restored.length, 0);
  assert.equal(h.inserted.length, 0);
  assert.equal(doc.activeElement, b);
  assert.equal(doc.selection.getRangeAt(0), invalid);

  doc.selection = makeSelection(makeRange(b));
  h.handleKeyDownEvent({ type: 'keydown', key: 'v', ctrlKey: true, target: b });
  const session = h.state.activePasteSession;
  assert.ok(session?.catcher);
  session.catcher.listeners.paste({ text: 'valid text' });
  assert.equal(h.inserted.length, 1);
  assert.equal(h.inserted[0].route.el, b);
  assert.equal(doc.activeElement, b);
});
