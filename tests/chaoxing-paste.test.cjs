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
    isContentEditable: false, parentElement, ownerDocument: parentElement?.ownerDocument || null,
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    closest() { return null; }
  };
}
function harness() {
  const sandbox = {
    state: { richDocs: new Set(), codeMirrors: new Set(), lastTarget: null, lastTargetAt: 0 },
    window: {}, patched: [],
    patchRichDoc(doc) { sandbox.patched.push(doc); },
    eventPath(e) { return e.path || [e.target]; },
    isPasteCatcherNode() { return false; },
    getFrameElement() { return null; },
    isTopWindow() { return true; },
    getWin(doc) { return doc.defaultView; }
  };
  vm.createContext(sandbox);
  const names = ['lower', 'getDoc', 'toElement', 'isPlainInput', 'isEditableElement',
    'closestEditableHost', 'findCodeMirrorFromElement', 'findCodeMirrorFromEvent',
    'hasRichEditorMarks', 'looksLikeRichFrame', 'looksLikeRichDoc',
    'getDefaultRichHost', 'richRouteFromEvent', 'shouldUseLastRichRoute', 'routeFromEvent',
    'isPasteKey', 'isPasteLikeEvent', 'shouldSuppressExternalPasteListener',
    'shouldNeutralizePasteBlocker'];
  if (source.includes('function isExplicitlyNonEditable(')) names.push('isExplicitlyNonEditable');
  vm.runInContext(names.map(extractFunction).join('\n'), sandbox);
  return sandbox;
}
function makeDocument() {
  const doc = { nodeType: 9, designMode: 'off', querySelector() { return null; }, defaultView: {} };
  doc.body = element('body');
  doc.documentElement = element('html');
  doc.body.ownerDocument = doc;
  doc.documentElement.ownerDocument = doc;
  doc.body.parentElement = doc.documentElement;
  doc.activeElement = doc.body;
  doc.defaultView.document = doc;
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
