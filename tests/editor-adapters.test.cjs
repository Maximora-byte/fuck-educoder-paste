'use strict';

// Test actual userscript adapters without loading a page or creating editors.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(process.env.SCRIPT_PATH || process.env.USERSCRIPT_PATH || path.join(__dirname, '..', 'fuck-educoder-paste.user.js'), 'utf8');

function extractFunction(name) {
  const match = new RegExp(`^( +)function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `Missing userscript helper: ${name}`);
  const end = source.indexOf(`\n${match[1]}}`, match.index);
  assert.notEqual(end, -1, `Missing end of helper: ${name}`);
  return source.slice(match.index, end + match[1].length + 2);
}
function harness(names, overrides = {}) {
  const sandbox = {
    window: {}, parent: {}, top: {},
    state: { markInserted() {}, richRanges: new WeakMap() },
    getWin: doc => doc.defaultView,
    getFrameElement: win => win.frameElement || null,
    dispatchBasicEvents() {},
    ...overrides
  };
  vm.createContext(sandbox);
  vm.runInContext(names.map(extractFunction).join('\n'), sandbox);
  return sandbox;
}
function codeMirrorHarness() {
  const names = ['replaceInCodeMirror', 'insertIntoCodeMirror'];
  // Include old wrappers so the baseline fails for its behavior, not missing dependencies.
  for (const name of ['withTemporaryReadWrite', 'withMutedCodeMirrorBeforeChange']) {
    if (source.includes(`function ${name}(`)) names.push(name);
  }
  return harness(names);
}
function makeCodeMirror({ value = 'hello world', from = 0, to = 5, readOnly = false, cancel = false, fallback = false } = {}) {
  let content = value;
  let start = { line: 0, ch: from };
  let end = { line: 0, ch: to };
  let option = readOnly;
  const changes = [], options = [], handlers = [], cursorRequests = [];
  const cm = {};
  const doc = {
    getValue: () => content,
    getCursor(which) { cursorRequests.push(which); return { ...(which === 'from' || which === 'anchor' ? start : end) }; },
    listSelections: () => [{ anchor: { ...start }, head: { ...end } }],
    getSelection: () => content.slice(start.ch, end.ch),
    replaceRange(text, a, b, origin) {
      changes.push({ text, from: { ...a }, to: { ...b }, origin });
      const change = { cancelled: false, cancel() { this.cancelled = true; } };
      for (const object of [cm, doc]) for (const handler of object._handlers.beforeChange) handler(cm, change);
      if (change.cancelled) return;
      content = content.slice(0, a.ch) + text + content.slice(b.ch);
      start = end = { line: 0, ch: a.ch + text.length };
    }
  };
  for (const [object, label] of [[cm, 'cm'], [doc, 'doc']]) {
    let beforeChange = cancel ? [(_cm, change) => change.cancel()] : [];
    object._handlers = {};
    Object.defineProperty(object._handlers, 'beforeChange', {
      get: () => beforeChange,
      set(next) { handlers.push(label); beforeChange = next; }
    });
  }
  Object.assign(cm, {
    doc, getDoc: () => doc, getOption: () => option,
    setOption(name, next) { options.push({ name, next }); option = next; },
    getValue: doc.getValue, getCursor: doc.getCursor, listSelections: doc.listSelections,
    getSelection: doc.getSelection, operation: fn => fn(), focus() {}, save() {}, refresh() {}
  });
  if (!fallback) cm.replaceSelection = (text, _collapse, origin) => doc.replaceRange(text, start, end, origin);
  return { cm, doc, changes, options, handlers, cursorRequests };
}

for (const helper of ['replaceInCodeMirror', 'insertIntoCodeMirror']) {
  for (const readOnly of [true, 'nocursor']) {
    test(`${helper} respects readOnly=${readOnly} without changing editor options`, () => {
      const h = codeMirrorHarness();
      const fixture = makeCodeMirror({ readOnly });
      assert.equal(h[helper](fixture.cm, 'new'), false);
      assert.equal(fixture.doc.getValue(), 'hello world');
      assert.deepEqual(fixture.changes, []);
      assert.deepEqual(fixture.options, []);
      assert.deepEqual(fixture.handlers, []);
    });
  }
  test(`${helper} reports a same-text selected replacement as success`, () => {
    const h = codeMirrorHarness();
    const fixture = makeCodeMirror();
    assert.equal(h[helper](fixture.cm, 'hello'), true);
    assert.equal(fixture.doc.getValue(), 'hello world');
    assert.deepEqual(fixture.doc.getCursor('from'), { line: 0, ch: 5 });
    assert.equal(fixture.changes.length, 1, 'same-text replacement must not be retried');
    assert.deepEqual(fixture.options, []);
    assert.deepEqual(fixture.handlers, []);
  });
  test(`${helper} respects cancelled beforeChange without mutating handlers or options`, () => {
    const h = codeMirrorHarness();
    const fixture = makeCodeMirror({ cancel: true });
    assert.equal(h[helper](fixture.cm, 'new'), false);
    assert.equal(fixture.doc.getValue(), 'hello world');
    assert.deepEqual(fixture.doc.getCursor('from'), { line: 0, ch: 0 });
    assert.deepEqual(fixture.doc.getCursor('to'), { line: 0, ch: 5 });
    assert.deepEqual(fixture.handlers, []);
    assert.deepEqual(fixture.options, []);
    assert.equal(fixture.changes.length, 1, 'a cancelled edit must not be retried');
  });
}

test('CodeMirror replaceRange fallback replaces the selected from/to span', () => {
  const h = codeMirrorHarness();
  const fixture = makeCodeMirror({ from: 1, to: 4, fallback: true });
  assert.equal(h.replaceInCodeMirror(fixture.cm, 'X'), true);
  assert.equal(fixture.doc.getValue(), 'hXo world');
  assert.deepEqual(fixture.changes[0].from, { line: 0, ch: 1 });
  assert.deepEqual(fixture.changes[0].to, { line: 0, ch: 4 });
  assert.ok(fixture.cursorRequests.includes('from'));
  assert.ok(fixture.cursorRequests.includes('to'));
});

function makeRichDocument() {
  const doc = { nodeType: 9, defaultView: {}, body: { nodeType: 1, isConnected: true } };
  doc.body.ownerDocument = doc;
  doc.defaultView.document = doc;
  doc.defaultView.frameElement = { id: 'ueditor_answer_iframe', name: 'answer_iframe', contentDocument: doc, contentWindow: doc.defaultView };
  return doc;
}
for (const identity of ['document', 'body', 'iframe', '_iframe']) {
  test(`UEditor discovery matches ${identity} identity without invoking getEditor`, () => {
    const doc = makeRichDocument();
    const editor = identity === 'document' ? { document: doc } : identity === 'body' ? { body: doc.body } : { [identity]: doc.defaultView.frameElement };
    const unrelated = { document: makeRichDocument() };
    const calls = [];
    const UE = { instances: { unrelated, actual: editor }, getEditor(id) { calls.push(id); return unrelated; } };
    const h = harness(['findUEditorByDoc'], { window: { UE } });
    assert.equal(h.findUEditorByDoc(doc), editor);
    assert.deepEqual(calls, [], 'discovery must never create an editor by guessed ID');
  });
}

test('UEditor discovery rejects an ID-shaped frame with no matching instance', () => {
  const doc = makeRichDocument();
  let calls = 0;
  const UE = { instants: { other: { document: makeRichDocument() } }, getEditor() { calls++; return {}; } };
  const h = harness(['findUEditorByDoc'], { window: { UE } });
  assert.equal(h.findUEditorByDoc(doc), null);
  assert.equal(calls, 0);
});

test('UEditor discovery searches all instance registries rather than stopping at an empty registry', () => {
  const doc = makeRichDocument();
  const editor = { document: doc };
  const h = harness(['findUEditorByDoc'], { window: { UE: { instants: {}, instances: { actual: editor } } } });
  assert.equal(h.findUEditorByDoc(doc), editor);
});

function ueditorHarness({ current = true, validRange = true, disabled = false, command = true } = {}) {
  const doc = makeRichDocument();
  doc.body.innerHTML = 'before';
  const range = { startContainer: doc.body, startOffset: 0, endContainer: doc.body, endOffset: 1, collapsed: false };
  const calls = [];
  const nativeRange = {
    setStart(node, offset) { calls.push(['setStart', node, offset]); return this; },
    setEnd(node, offset) { calls.push(['setEnd', node, offset]); return this; },
    select() { calls.push(['select']); return this; }
  };
  const editor = {
    document: doc, body: doc.body,
    selection: { getRange: () => nativeRange },
    queryCommandState(name) { calls.push(['queryCommandState', name]); return disabled ? -1 : 0; },
    execCommand: command ? function (name, html) { calls.push(['execCommand', name, html]); doc.body.innerHTML = html; } : undefined
  };
  const route = { type: 'rich', doc, el: doc.body };
  const h = harness(['insertIntoUEditor'], {
    findUEditorByDoc: candidate => candidate === doc ? editor : null,
    isCurrentRoute: () => current,
    ensureRichRange: () => range,
    rangeBelongsToRichHost: () => validRange,
    focusRichDoc() {}, syncRichEditor() {}, saveRichRange() {},
    getRichSelection: () => null
  });
  return { h, route, doc, range, editor, calls };
}

test('UEditor insertion restores the matched route range and uses insertHTML command', () => {
  const fixture = ueditorHarness();
  assert.equal(fixture.h.insertIntoUEditor(fixture.route, '<b>new</b>'), true);
  assert.equal(fixture.doc.body.innerHTML, '<b>new</b>');
  const relevant = fixture.calls.filter(call => ['setStart', 'setEnd', 'select', 'execCommand'].includes(call[0]));
  assert.deepEqual(relevant, [
    ['setStart', fixture.doc.body, 0], ['setEnd', fixture.doc.body, 1], ['select'], ['execCommand', 'insertHTML', '<b>new</b>']
  ]);
  assert.ok(fixture.calls.some(call => call[0] === 'queryCommandState' && call[1] === 'insertHTML'));
});
for (const [description, options] of [
  ['stale route', { current: false }],
  ['range outside the target host', { validRange: false }],
  ['disabled insertHTML command', { disabled: true }],
  ['missing command API', { command: false }]
]) {
  test(`UEditor insertion rejects ${description} without invoking an edit`, () => {
    const fixture = ueditorHarness(options);
    assert.equal(fixture.h.insertIntoUEditor(fixture.route, 'new'), false);
    assert.equal(fixture.doc.body.innerHTML, 'before');
    assert.equal(fixture.calls.some(call => call[0] === 'execCommand'), false);
  });
}

test('UEditor insertion preserves content when the command cancels without a change', () => {
  const fixture = ueditorHarness();
  fixture.editor.execCommand = () => false;
  assert.equal(fixture.h.insertIntoUEditor(fixture.route, 'new'), false);
  assert.equal(fixture.doc.body.innerHTML, 'before');
});

test('UEditor insertion refuses to use a stale internal selection when its range API is absent', () => {
  const fixture = ueditorHarness();
  delete fixture.editor.selection;
  assert.equal(fixture.h.insertIntoUEditor(fixture.route, 'new'), false);
  assert.equal(fixture.calls.some(call => call[0] === 'execCommand'), false);
});

test('UEditor insertion rechecks route after restoring editor selection', () => {
  const fixture = ueditorHarness();
  let checks = 0;
  fixture.h.isCurrentRoute = () => ++checks === 1;
  assert.equal(fixture.h.insertIntoUEditor(fixture.route, 'new'), false);
  assert.equal(fixture.calls.some(call => call[0] === 'execCommand'), false);
});

test('UEditor same-text replacement succeeds when the selected range collapses', () => {
  const fixture = ueditorHarness();
  fixture.editor.execCommand = () => {
    fixture.doc.defaultView.getSelection = () => ({
      rangeCount: 1,
      getRangeAt: () => ({ ...fixture.range, startOffset: 1, endOffset: 1, collapsed: true })
    });
  };
  assert.equal(fixture.h.insertIntoUEditor(fixture.route, 'before'), true);
  assert.equal(fixture.doc.body.innerHTML, 'before');
});

test('UEditor discovery can find a matching instance on the frame parent', () => {
  const doc = makeRichDocument();
  const editor = { document: doc };
  doc.defaultView.parent = { UE: { _instances: { actual: editor } } };
  const h = harness(['findUEditorByDoc']);
  assert.equal(h.findUEditorByDoc(doc), editor);
});

for (const helper of ['replaceInCodeMirror', 'insertIntoCodeMirror']) {
  test(`${helper} preserves success when operation throws after changing the model`, () => {
    const fixture = makeCodeMirror();
    fixture.cm.operation = fn => { fn(); throw new Error('post-edit operation callback'); };
    const h = codeMirrorHarness();
    assert.equal(h[helper](fixture.cm, 'new'), true);
    assert.equal(fixture.doc.getValue(), 'new world');
    assert.equal(fixture.changes.length, 1, 'an already applied edit must not be retried');
  });
  test(`${helper} preserves success when change-listener cleanup throws`, () => {
    const fixture = makeCodeMirror();
    fixture.cm.on = () => {};
    fixture.cm.off = () => { throw new Error('listener cleanup'); };
    const h = codeMirrorHarness();
    assert.equal(h[helper](fixture.cm, 'new'), true);
    assert.equal(fixture.doc.getValue(), 'new world');
    assert.equal(fixture.changes.length, 1);
  });
  test(`${helper} reports failure when operation throws without a model or selection change`, () => {
    const fixture = makeCodeMirror();
    fixture.cm.operation = () => { throw new Error('before edit'); };
    const h = codeMirrorHarness();
    assert.equal(h[helper](fixture.cm, 'new'), false);
    assert.equal(fixture.doc.getValue(), 'hello world');
    assert.deepEqual(fixture.doc.getCursor('from'), { line: 0, ch: 0 });
    assert.deepEqual(fixture.doc.getCursor('to'), { line: 0, ch: 5 });
    assert.deepEqual(fixture.handlers, []);
    assert.deepEqual(fixture.options, []);
  });
}

test('UEditor insertion preserves success when its command throws after changing HTML', () => {
  const fixture = ueditorHarness();
  fixture.editor.execCommand = (_name, html) => {
    fixture.doc.body.innerHTML = html;
    throw new Error('post-edit command callback');
  };
  assert.equal(fixture.h.insertIntoUEditor(fixture.route, '<b>new</b>'), true);
  assert.equal(fixture.doc.body.innerHTML, '<b>new</b>');
});

test('UEditor insertion reports failure when its command throws without a change', () => {
  const fixture = ueditorHarness();
  fixture.editor.execCommand = () => { throw new Error('before edit'); };
  assert.equal(fixture.h.insertIntoUEditor(fixture.route, '<b>new</b>'), false);
  assert.equal(fixture.doc.body.innerHTML, 'before');
});

test('inline UEditors sharing a document are matched to the exact editable host', () => {
  const doc = makeRichDocument();
  const a = { ownerDocument: doc }, b = { ownerDocument: doc };
  const first = { document: doc, body: a }, second = { document: doc, body: b };
  const h = harness(['findUEditorByDoc'], { window: { UE: { instances: { first, second } } } });
  assert.equal(h.findUEditorByDoc(doc, b), second);
  assert.equal(h.findUEditorByDoc(doc, {}), null);
});

test('CodeMirror replaceRange fallback collapses cursor at multiline paste endpoint', () => {
  const h = codeMirrorHarness();
  const fixture = makeCodeMirror({ from: 1, to: 4, fallback: true });
  let cursor;
  fixture.doc.setCursor = value => { cursor = value; };
  let listener;
  fixture.cm.on = (_event, fn) => { listener = fn; };
  fixture.cm.off = () => {};
  const replace = fixture.doc.replaceRange;
  fixture.doc.replaceRange = (text, from, to, origin) => {
    replace(text, from, to, origin);
    listener(fixture.cm, { from, text: text.split('\n') });
  };
  assert.equal(h.replaceInCodeMirror(fixture.cm, 'X\nYZ'), true);
  assert.equal(cursor.line, 1);
  assert.equal(cursor.ch, 2);
});

test('CodeMirror fallback endpoint follows validated text, not requested clipboard text', () => {
  const h = codeMirrorHarness();
  const fixture = makeCodeMirror({ from: 1, to: 1, fallback: true });
  let cursor, listener;
  fixture.doc.setCursor = value => { cursor = value; };
  fixture.cm.on = (_event, fn) => { listener = fn; };
  fixture.cm.off = () => {};
  const replace = fixture.doc.replaceRange;
  fixture.doc.replaceRange = (_text, from, to, origin) => {
    replace('X', from, to, origin);
    listener(fixture.cm, { from, text: ['X'] });
  };
  assert.equal(h.replaceInCodeMirror(fixture.cm, 'abcdef'), true);
  assert.equal(fixture.doc.getValue(), 'hXello world');
  assert.equal(cursor.line, 0);
  assert.equal(cursor.ch, 2);
});

test('CodeMirror fallback without observed change data retains native cursor mapping', () => {
  const h = codeMirrorHarness();
  const fixture = makeCodeMirror({ from: 1, to: 1, fallback: true });
  let cursor;
  fixture.doc.setCursor = value => { cursor = value; };
  assert.equal(h.replaceInCodeMirror(fixture.cm, 'X'), true);
  assert.equal(cursor, undefined);
});
