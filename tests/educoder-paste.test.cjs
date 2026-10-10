'use strict';

// Dependency-free unit tests against the actual Educoder install function.
// The model double applies edits and computes inverse ranges. This checks the
// Monaco API contract; it is not a browser or deployed-platform integration test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(process.env.SCRIPT_PATH || path.join(__dirname, '../fuck-educoder-paste.user.js'), 'utf8');

class Selection {
  constructor(startLine, startColumn, endLine, endColumn) {
    this.selectionStartLineNumber = startLine;
    this.selectionStartColumn = startColumn;
    this.positionLineNumber = endLine;
    this.positionColumn = endColumn;
    const forward = startLine < endLine || (startLine === endLine && startColumn <= endColumn);
    this.startLineNumber = forward ? startLine : endLine;
    this.startColumn = forward ? startColumn : endColumn;
    this.endLineNumber = forward ? endLine : startLine;
    this.endColumn = forward ? endColumn : startColumn;
  }
  getPosition() { return { lineNumber: this.positionLineNumber, column: this.positionColumn }; }
  isEmpty() { return this.startLineNumber === this.endLineNumber && this.startColumn === this.endColumn; }
}
function offset(value, lineNumber, column) {
  return value.split('\n').slice(0, lineNumber - 1).reduce((sum, line) => sum + line.length + 1, 0) + column - 1;
}
function position(value, index) {
  const lines = value.slice(0, index).split('\n');
  return { lineNumber: lines.length, column: lines.at(-1).length + 1 };
}
function setup({ monaco = true, readonly = false, disabled = false, selected = false,
  textFocus = true, value = '    old', selections } = {}) {
  const handlers = {};
  const calls = { edits: [], undo: 0, commands: 0, reads: 0, order: [], warnings: [] };
  const doc = { nodeType: 9, readyState: 'loading', addEventListener() {},
    queryCommandSupported: () => true, execCommand(_command, _ui, text) {
      calls.commands++;
      target.setRangeText(text, target.selectionStart, target.selectionEnd);
      return true;
    } };
  class Input {}
  class Textarea extends Input {
    setRangeText(text, start, end) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      this.selectionStart = this.selectionEnd = start + text.length;
    }
  }
  const root = { ownerDocument: doc, contains: el => el === target };
  const target = Object.assign(new Textarea(), { nodeType: 1, tagName: 'TEXTAREA', ownerDocument: doc,
    value, selectionStart: 4, selectionEnd: selected ? 7 : 4,
    readOnly: !monaco && readonly, disabled,
    closest: () => monaco ? root : null, focus() { doc.activeElement = this; } });
  doc.activeElement = target;
  let current = selections || [new Selection(1, 5, 1, selected ? 8 : 5)];
  const model = { value, version: 1, getValue() { return this.value; }, getVersionId() { return this.version; }, getLineContent(lineNumber) { return this.value.split('\n')[lineNumber - 1]; } };
  const history = [];
  const editor = { getDomNode: () => root, hasTextFocus: () => textFocus,
    getModel: () => model, getSelections: () => current, getRawOptions: () => ({ readOnly: readonly }),
    pushUndoStop() { calls.undo++; calls.order.push('undo-stop'); },
    executeEdits(_source, edits, endCursorState) {
      calls.order.push('edit');
      assert.equal(readonly, false, 'read-only editor must not receive an edit');
      calls.edits.push(...edits);
      const before = model.value;
      history.push({ value: before, selections: current });
      const ordered = edits.map(edit => ({ edit,
        start: offset(before, edit.range.startLineNumber, edit.range.startColumn),
        end: offset(before, edit.range.endLineNumber, edit.range.endColumn)
      })).sort((a, b) => a.start - b.start);
      for (let i = 1; i < ordered.length; i++) {
        assert.ok(ordered[i - 1].end <= ordered[i].start, 'Monaco rejects overlapping edits');
      }
      let output = '', previous = 0;
      const inverse = [];
      for (const { edit, start, end } of ordered) {
        output += before.slice(previous, start);
        const begin = position(output, output.length);
        output += edit.text.replace(/\r\n?/g, '\n');
        const finish = position(output, output.length);
        inverse.push({ identifier: edit.identifier, range: {
          startLineNumber: begin.lineNumber, startColumn: begin.column,
          endLineNumber: finish.lineNumber, endColumn: finish.column
        } });
        previous = end;
      }
      model.value = output + before.slice(previous);
      model.version++;
      // The real API accepts either a callback or a Selection array.
      current = typeof endCursorState === 'function'
        ? endCursorState(inverse.reverse()) : endCursorState;
      assert.ok(current.every(cursor => cursor instanceof Selection), 'end cursor state requires Selection instances');
      assert.ok(current.every(cursor => cursor.isEmpty()), 'paste ends with collapsed cursors');
      calls.cursor = current;
      return true;
    },
    undo() { const previous = history.pop(); model.value = previous.value; current = previous.selections; }
  };
  const win = { addEventListener(type, fn) { handlers[type] = fn; },
    monaco: { Selection, editor: { getEditors: () => [editor] } } };
  doc.defaultView = win;
  const context = { window: win, document: doc,
    console: { log() {}, warn(...args) { calls.warnings.push(args); }, error(...args) { calls.warnings.push(args); } },
    HTMLInputElement: Input, HTMLTextAreaElement: Textarea,
    lower: x => String(x ?? '').toLowerCase(), toElement: x => x, getDoc: x => x?.ownerDocument,
    getWin: x => x?.defaultView || win, getClipboardTextFromEvent: e => e.clipboardData.getData(),
    readClipboardText: async () => { calls.reads++; return 'late clipboard'; }, dispatchBasicEvents() {} };
  vm.createContext(context);
  const start = source.indexOf('  function installEducoderUnlock()');
  const end = source.indexOf('  function installChaoxingPasteEnhancer()');
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end) + '\ninstallEducoderUnlock();', context);
  function paste(text) {
    const event = { target, clipboardData: { getData: () => text }, stopped: false, prevented: false,
      stopImmediatePropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } };
    handlers.paste(event);
    return event;
  }
  return { calls, editor, model, win, target, paste };
}

test('Monaco multiline paste preserves indentation in the model and is one undo operation', () => {
  const h = setup();
  const text = 'if (ok) {\n  work();\n}';
  const event = h.paste(text);
  assert.equal(h.model.value, text + 'old');
  assert.equal(h.calls.edits.length, 1);
  assert.equal(h.calls.edits[0].text, text);
  assert.equal(h.calls.edits[0].range.startColumn, 1);
  assert.equal(h.calls.commands, 0);
  assert.deepEqual(h.calls.order, ['undo-stop', 'edit', 'undo-stop']);
  assert.equal(h.target.value, '    old');
  assert.deepEqual(h.calls.cursor[0].getPosition(), { lineNumber: 3, column: 2 });
  assert.equal(event.prevented, true);
  h.editor.undo();
  assert.equal(h.model.value, '    old');
  assert.equal(h.editor.getSelections()[0].startColumn, 5);
});
test('forward and reversed Monaco selections replace the selected text only', () => {
  for (const selection of [new Selection(1, 5, 1, 8), new Selection(1, 8, 1, 5)]) {
    const h = setup({ selections: [selection] }); h.paste('replacement');
    assert.equal(h.model.value, '    replacement');
    assert.equal(h.calls.edits[0].range.startColumn, 5);
    assert.equal(h.calls.edits[0].range.endColumn, 8);
    assert.deepEqual(h.calls.cursor[0].getPosition(), { lineNumber: 1, column: 16 });
  }
});
test('multiple cursors preserve the native event and model, including same-line cursors', () => {
  for (const selections of [
    [new Selection(2, 3, 2, 3), new Selection(1, 3, 1, 3)],
    [new Selection(1, 2, 1, 2), new Selection(1, 3, 1, 3)]
  ]) {
    const h = setup({ value: '  one\n  two', selections });
    const e = h.paste('a\n b');
    assert.equal(h.model.value, '  one\n  two');
    assert.equal(e.prevented, false); assert.equal(e.stopped, false);
    assert.equal(h.calls.edits.length, 0); assert.equal(h.calls.commands, 0);
    assert.equal(h.calls.warnings.length, 0);
  }
});
test('multiline selection replacement computes the end cursor in the updated model', () => {
  const h = setup({ value: 'pre old\nmiddle\nend tail', selections: [new Selection(1, 5, 3, 4)] });
  h.paste('new\n  body');
  assert.equal(h.model.value, 'pre new\n  body tail');
  assert.deepEqual(h.calls.cursor[0].getPosition(), { lineNumber: 2, column: 7 });
});
test('CRLF clipboard data is passed unchanged and follows the model line endings', () => {
  const h = setup(); h.paste('a\r\n  b');
  assert.equal(h.calls.edits[0].text, 'a\r\n  b');
  assert.equal(h.model.value, 'a\n  bold');
  assert.deepEqual(h.calls.cursor[0].getPosition(), { lineNumber: 2, column: 4 });
});
test('a cursor after code retains its existing prefix', () => {
  const h = setup({ value: 'code old' }); h.paste('X');
  assert.equal(h.model.value, 'codeX old');
  assert.equal(h.calls.edits[0].range.startColumn, 5);
});
test('Monaco read-only model is not written or routed through its textarea', () => {
  const h = setup({ readonly: true }); h.paste('text');
  assert.equal(h.model.value, '    old');
  assert.equal(h.calls.edits.length, 0); assert.equal(h.calls.commands, 0);
});
test('unexposed or incomplete Monaco API preserves the native paste event', () => {
  for (const hide of [h => { delete h.win.monaco; }, h => { delete h.win.monaco.Selection; },
    h => { delete h.win.monaco.editor.getEditors; }]) {
    const h = setup(); hide(h); const e = h.paste('text');
    assert.equal(e.stopped, false); assert.equal(e.prevented, false);
    assert.equal(h.calls.commands, 0); assert.equal(h.model.value, '    old');
  }
});
test('Monaco find/replace input does not receive a document-model paste', () => {
  const h = setup({ textFocus: false }); const e = h.paste('search term');
  assert.equal(e.prevented, false); assert.equal(e.stopped, false);
  assert.equal(h.calls.edits.length, 0); assert.equal(h.calls.commands, 0);
});
test('missing Monaco clipboard text uses native paste without an asynchronous read', () => {
  const h = setup(); const e = h.paste('');
  assert.equal(e.prevented, false); assert.equal(e.stopped, false);
  assert.equal(h.calls.reads, 0); assert.equal(h.calls.edits.length, 0);
});
test('a detached Monaco model keeps the native path', () => {
  const h = setup(); h.editor.getModel = () => null; const e = h.paste('text');
  assert.equal(e.prevented, false); assert.equal(h.calls.edits.length, 0);
});
test('plain textarea selection survives indentation cleanup', () => {
  const h = setup({ monaco: false, selected: true }); h.paste('new');
  assert.equal(h.target.value, '    new'); assert.equal(h.calls.commands, 1);
});
test('blank indentation is removed for a collapsed plain textarea cursor', () => {
  const h = setup({ monaco: false }); h.paste('text');
  assert.equal(h.target.value, 'textold'); assert.equal(h.target.selectionStart, 4);
});
test('readonly and disabled textareas stay unchanged', () => {
  for (const options of [{ readonly: true }, { disabled: true }]) {
    const h = setup({ monaco: false, ...options }); const e = h.paste('text');
    assert.equal(h.target.value, '    old'); assert.equal(h.calls.commands, 0);
    assert.equal(e.prevented, false);
  }
});

for (const method of ['getModel', 'getSelections', 'getRawOptions', 'pushUndoStop', 'executeEdits']) {
  test(`missing Monaco ${method} preserves native paste without a write`, () => {
    const h = setup(); delete h.editor[method]; const e = h.paste('text');
    assert.equal(e.prevented, false); assert.equal(e.stopped, false);
    assert.equal(h.calls.edits.length, 0); assert.equal(h.model.value, '    old');
  });
  test(`Monaco ${method} throwing before mutation preserves native paste`, () => {
    const h = setup(); h.editor[method] = () => { throw Error('before mutation'); };
    const e = h.paste('text');
    assert.equal(e.prevented, false); assert.equal(e.stopped, false);
    assert.equal(h.calls.edits.length, 0); assert.equal(h.model.value, '    old');
  });
}
for (const method of ['getValue', 'getVersionId', 'getLineContent']) {
  test(`missing Monaco model ${method} preserves native paste`, () => {
    const h = setup(); delete h.model[method]; const e = h.paste('text');
    assert.equal(e.prevented, false); assert.equal(h.calls.edits.length, 0);
  });
}
test('Monaco executeEdits throwing after mutation cancels once and retains undo', () => {
  const h = setup(); const edit = h.editor.executeEdits;
  h.editor.executeEdits = (...args) => { edit(...args); throw Error('after mutation'); };
  const e = h.paste('text');
  assert.equal(e.prevented, true); assert.equal(e.stopped, true);
  assert.equal(h.model.value, 'textold'); assert.equal(h.calls.edits.length, 1);
  assert.equal(h.calls.undo, 2);
  h.editor.undo(); assert.equal(h.model.value, '    old');
});
test('Monaco final undo stop throwing after mutation does not duplicate paste', () => {
  const h = setup(); const stop = h.editor.pushUndoStop;
  h.editor.pushUndoStop = () => { stop(); if (h.calls.undo === 2) throw Error('after edit'); };
  const e = h.paste('text');
  assert.equal(e.prevented, true); assert.equal(h.calls.edits.length, 1);
});
test('same-text Monaco replacement throwing after mutation is detected by version', () => {
  const h = setup({ selected: true }); const edit = h.editor.executeEdits;
  h.editor.executeEdits = (...args) => { edit(...args); throw Error('same text written'); };
  const e = h.paste('old');
  assert.equal(h.model.value, '    old'); assert.equal(h.model.version, 2);
  assert.equal(e.prevented, true); assert.equal(h.calls.edits.length, 1);
});
test('Monaco rejected no-op preserves native paste', () => {
  const h = setup(); h.editor.executeEdits = () => false;
  const e = h.paste('text');
  assert.equal(e.prevented, false); assert.equal(e.stopped, false);
});
test('same-text Monaco no-op throwing before mutation preserves native paste', () => {
  const h = setup({ selected: true });
  h.editor.executeEdits = () => { throw Error('no write'); };
  const e = h.paste('old');
  assert.equal(h.model.value, '    old'); assert.equal(h.model.version, 1);
  assert.equal(e.prevented, false); assert.equal(e.stopped, false);
});
for (const method of ['getValue', 'getVersionId', 'getLineContent']) {
  test(`Monaco model ${method} throwing before mutation preserves native paste`, () => {
    const h = setup(); h.model[method] = () => { throw Error('unreadable model'); };
    const e = h.paste('text');
    assert.equal(e.prevented, false); assert.equal(e.stopped, false);
    assert.equal(h.calls.edits.length, 0);
  });
}
test('Monaco Selection constructor throwing preserves native paste', () => {
  const h = setup(); h.win.monaco.Selection = function () { throw Error('selection'); };
  const e = h.paste('text');
  assert.equal(e.prevented, false); assert.equal(h.calls.edits.length, 0);
});
for (const unreadable of ['getValue', 'getVersionId']) {
  test(`Monaco post-write failure uses remaining evidence when ${unreadable} throws`, () => {
    const h = setup(); const edit = h.editor.executeEdits;
    h.editor.executeEdits = (...args) => {
      edit(...args); h.model[unreadable] = () => { throw Error('unreadable after write'); };
      throw Error('after write');
    };
    const e = h.paste('text');
    assert.equal(e.prevented, true); assert.equal(h.model.value, 'textold');
  });
}
test('Monaco mutation followed by false return is not natively duplicated', () => {
  const h = setup(); const edit = h.editor.executeEdits;
  h.editor.executeEdits = (...args) => { edit(...args); return false; };
  assert.equal(h.paste('text').prevented, true);
  assert.equal(h.calls.edits.length, 1);
});
test('Monaco same-text successful replacement collapses selection and stays handled', () => {
  const h = setup({ selected: true });
  assert.equal(h.paste('old').prevented, true);
  assert.equal(h.model.value, '    old'); assert.equal(h.calls.edits.length, 1);
  assert.equal(h.editor.getSelections()[0].isEmpty(), true);
});
test('Monaco exception checks the original model after a callback replaces the editor model', () => {
  const h = setup({ selected: true }); const edit = h.editor.executeEdits;
  h.editor.executeEdits = (...args) => {
    edit(...args);
    h.editor.getModel = () => ({ getValue: () => '    old', getVersionId: () => 1 });
    throw Error('model replaced after same-text edit');
  };
  const e = h.paste('old');
  assert.equal(e.prevented, true); assert.equal(e.stopped, true);
  assert.equal(h.model.version, 2); assert.equal(h.calls.edits.length, 1);
});
