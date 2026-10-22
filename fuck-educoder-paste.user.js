// ==UserScript==
// @name         ✨2026最新可用 - 完美解决【头歌/学习通】禁复制/粘贴问题
// @namespace    https://github.com/ystemsrx/fuck-educoder-paste
// @version      3.2.2
// @description  1）阻止网页脚本拦截复制/粘贴/全选等快捷键；2）禁止网页往剪贴板写入“全空白”内容；3）在代码编辑器中粘贴前，如果光标前一段是纯空格/Tab，则先清掉这些缩进，再原样粘贴内容。
// @author       ystemsrx
// @match        https://www.educoder.net/*
// @match        https://educoder.net/*
// @match        https://*.educoder.net/*
// @match        *://*.chaoxing.com/*
// @match        *://chaoxing.com/*
// @match        *://*.xueyinonline.com/*
// @match        *://xueyinonline.com/*
// @match        *://*.chaoxingerya.com/*
// @match        *://chaoxingerya.com/*
// @run-at       document-start
// @sandbox      raw
// @license      MIT
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const HOST = String(location.hostname || "");

  const IS_EDUCODER = /(^|\.)educoder\.net$/i.test(HOST);
  const IS_CHAOXING_FAMILY =
    /(^|\.)chaoxing\.com$/i.test(HOST) ||
    /(^|\.)xueyinonline\.com$/i.test(HOST) ||
    /(^|\.)chaoxingerya\.com$/i.test(HOST);

  function lower(value) {
    return String(value ?? "").toLowerCase();
  }

  function getDoc(node) {
    try {
      if (!node) return null;
      if (node.nodeType === 9) return node;
      if (node.ownerDocument) return node.ownerDocument;
      if (node.document?.nodeType === 9) return node.document;
    } catch (_) {}
    return null;
  }

  function getWin(doc) {
    try {
      return doc?.defaultView || window;
    } catch (_) {
      return window;
    }
  }

  function getTargetWin(target) {
    try {
      if (!target) return window;
      if (target.window === target) return target;
      if (target.defaultView && target.nodeType === 9) return target.defaultView;
      const doc = getDoc(target);
      return doc?.defaultView || window;
    } catch (_) {
      return window;
    }
  }

  function toElement(node) {
    try {
      if (!node) return null;
      if (node.nodeType === 1) return node;
      if (node.nodeType === 3) return node.parentElement;
      if (node.nodeType === 9) {
        return node.activeElement || node.body || node.documentElement;
      }
      if (node.document?.activeElement) return node.document.activeElement;
    } catch (_) {}
    return null;
  }

  function dispatchBasicEvents(el, win) {
    if (!el || !win) return;

    for (const type of ["input", "change"]) {
      try {
        el.dispatchEvent(
          new win.Event(type, {
            bubbles: true,
            cancelable: true
          })
        );
      } catch (_) {}
    }
  }

  function getClipboardTextFromEvent(e) {
    return (
      e?.clipboardData?.getData("text/plain") ||
      e?.clipboardData?.getData("text") ||
      e?.dataTransfer?.getData("text/plain") ||
      e?.dataTransfer?.getData("text") ||
      window.clipboardData?.getData("Text") ||
      ""
    );
  }

  async function readClipboardText(win = window) {
    const candidates = [
      win?.navigator?.clipboard,
      window.navigator?.clipboard,
      navigator?.clipboard
    ];

    for (const clipboard of candidates) {
      try {
        if (clipboard?.readText) {
          const text = await clipboard.readText();
          if (text) return text;
        }
      } catch (_) {}
    }

    return "";
  }

  // ============================================================
  // 全局通用：阻止网页把剪贴板写成“全空白”
  // ============================================================
  function patchClipboardWrite() {
    try {
      const clip = navigator.clipboard;
      if (!clip) return;
      if (clip.__mergedPasteClipboardWritePatched) return;

      const origWriteText =
        typeof clip.writeText === "function" ? clip.writeText.bind(clip) : null;
      const origWrite =
        typeof clip.write === "function" ? clip.write.bind(clip) : null;

      if (origWriteText) {
        clip.writeText = function (text) {
          try {
            if (typeof text === "string" && text.trim() === "") {
              console.warn(
                "[pasteUnlock] blocked clipboard.writeText() whitespace-only"
              );
              return Promise.resolve();
            }
          } catch (err) {
            console.warn("[pasteUnlock] writeText check error:", err);
          }

          return origWriteText(text);
        };
      }

      if (origWrite) {
        clip.write = async function (data) {
          try {
            const items = Array.from(data || []);
            let allWhitespace = items.length > 0;

            for (const item of items) {
              if (!item || !item.types) {
                allWhitespace = false;
                break;
              }

              if (item.types.includes("text/plain")) {
                const blob = await item.getType("text/plain").catch(() => null);
                if (!blob) {
                  allWhitespace = false;
                  break;
                }

                const txt = await blob.text().catch(() => "");
                if (txt.trim() !== "") {
                  allWhitespace = false;
                  break;
                }
              } else {
                allWhitespace = false;
                break;
              }
            }

            if (allWhitespace) {
              console.warn(
                "[pasteUnlock] blocked clipboard.write() whitespace-only payload"
              );
              return;
            }
          } catch (err) {
            console.warn("[pasteUnlock] clipboard.write analysis failed:", err);
          }

          return origWrite(data);
        };
      }

      Object.defineProperty(clip, "__mergedPasteClipboardWritePatched", {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false
      });
    } catch (err) {
      console.error("[pasteUnlock] patchClipboardWrite error:", err);
    }
  }

  patchClipboardWrite();

  // ============================================================
  // 头歌平台：复制 / 粘贴 / 全选解锁 + 编辑器粘贴缩进处理
  // ============================================================
  function installEducoderUnlock() {
    const VERSION = "3.2.2";
    const DOC_MARK = "__educoderPasteUnlock322__";
    const docs = new WeakSet();
    const frames = new WeakSet();
    const monacoEditors = new Set();
    const trackedEditors = new WeakSet();
    const editorByRoot = new WeakMap();
    let documentCount = 0;
    let lastRoute = "native";

    function editorRoot(el) {
      return el?.closest?.(".CodeMirror,.monaco-editor,.ace_editor,.cm-editor");
    }

    function rememberEditor(editor) {
      if (!editor || typeof editor.getDomNode !== "function" ||
          typeof editor.getModel !== "function" ||
          typeof editor.executeEdits !== "function" ||
          typeof editor.getSelections !== "function") return false;
      try {
        const root = editor.getDomNode();
        if (!root?.classList?.contains("monaco-editor")) return false;
        monacoEditors.add(editor);
        editorByRoot.set(root, editor);
        if (!trackedEditors.has(editor)) {
          trackedEditors.add(editor);
          editor.onDidDispose?.(() => {
            monacoEditors.delete(editor);
            if (editorByRoot.get(root) === editor) editorByRoot.delete(root);
          });
        }
        return true;
      } catch (_) { return false; }
    }

    function rememberMonaco(api) {
      try {
        for (const editor of api?.editor?.getEditors?.() || []) {
          rememberEditor(editor);
        }
        // Older Monaco versions expose creation events instead of getEditors().
        if (api?.editor?.onDidCreateEditor && !api.editor[DOC_MARK]) {
          api.editor.onDidCreateEditor(rememberEditor);
          Object.defineProperty(api.editor, DOC_MARK, { value: true });
        }
      } catch (_) {}
    }

    function findMonaco(root, win) {
      const cached = editorByRoot.get(root);
      try {
        if (cached?.getDomNode() === root && cached.getModel()) return cached;
      } catch (_) {}
      editorByRoot.delete(root);
      rememberMonaco(win.monaco || win.Monaco);
      for (const editor of monacoEditors) {
        try {
          if (editor.getDomNode() === root && editor.getModel()) return editor;
        } catch (_) { monacoEditors.delete(editor); }
      }

      // ESM Monaco builds do not publish window.monaco. React wrappers keep
      // the real editor in a class field, forwarded ref, or useRef hook instead.
      // Inspect only nearby component refs; never guess a model by its order,
      // mutate React props, or write the editor's hidden textarea directly.
      const seen = new WeakSet();
      let budget = 600;
      function inspect(value, depth = 0) {
        if (!value || (typeof value !== "object" && typeof value !== "function") ||
            seen.has(value) || depth > 5 || --budget < 0) return null;
        seen.add(value);
        if (rememberEditor(value)) {
          try { if (value.getDomNode() === root && value.getModel()) return value; }
          catch (_) {}
          return null;
        }
        // Read data properties only, so discovery cannot trigger app getters.
        let descriptors;
        try { descriptors = Object.getOwnPropertyDescriptors(value); }
        catch (_) { return null; }
        for (const key of Object.keys(descriptors)) {
          if (!/^(current|instance|memoizedState)$|editor|monaco|ref/i.test(key)) continue;
          const descriptor = descriptors[key];
          if (!("value" in descriptor)) continue;
          const found = inspect(descriptor.value, depth + 1);
          if (found) return found;
        }
        return null;
      }
      const fibers = new Set();
      for (let node = root, level = 0; node && level < 16; node = node.parentElement, level++) {
        for (const key of Object.keys(node)) {
          if (!/^__react(?:Fiber\$|InternalInstance\$)/.test(key)) continue;
          for (let fiber = node[key], count = 0;
               fiber && !fibers.has(fiber) && count < 80;
               fiber = fiber.return, count++) {
            fibers.add(fiber);
            for (const candidate of [fiber.stateNode, fiber.ref]) {
              const found = inspect(candidate);
              if (found) return found;
            }
            // Function component hooks form a linked list, not an object tree.
            const hooks = new Set();
            for (let hook = fiber.memoizedState, i = 0;
                 hook && !hooks.has(hook) && i < 100; hook = hook.next, i++) {
              hooks.add(hook);
              const found = inspect(hook.memoizedState);
              if (found) return found;
            }
          }
        }
      }
      return null;
    }

    function routeFor(target, win) {
      const el = toElement(target);
      const root = editorRoot(el);
      if (!root) return { type: "native", el };
      if (root.classList.contains("CodeMirror") && root.CodeMirror) {
        return { type: "codemirror", el, editor: root.CodeMirror };
      }
      if (root.classList.contains("ace_editor")) {
        const editor = root.env?.editor;
        if (editor) return { type: "ace", el, editor };
      }
      if (root.classList.contains("cm-editor")) {
        // CodeMirror 6 publishes its view on the content view's DOM node.
        const content = root.querySelector(".cm-content");
        const view = content?.cmView?.view || root.cmView?.view;
        if (view?.dispatch && view?.state?.replaceSelection) {
          return { type: "codemirror6", el, editor: view };
        }
      }
      if (root.classList.contains("monaco-editor")) {
        const editor = findMonaco(root, win);
        if (editor?.hasTextFocus?.()) return { type: "monaco", el, editor, api: win.monaco || win.Monaco };
      }
      // Never write directly into an unknown editor's hidden textarea: its
      // displayed value and document model can otherwise diverge.
      return { type: "unresolved", el };
    }

    function writable(route) {
      const { el, editor, type } = route;
      if (el?.disabled || el?.readOnly) return false;
      if (type === "codemirror") return !editor.getOption("readOnly");
      if (type === "ace") return !editor.getReadOnly();
      if (type === "codemirror6") return !editor.state.readOnly;
      if (type === "monaco") {
        const option = route.api?.editor?.EditorOption?.readOnly;
        if (option !== undefined && editor.getOption?.(option)) return false;
        if (editor.getRawOptions?.().readOnly) return false;
      }
      return true;
    }

    function prepareNativePaste(el) {
      if (lower(el?.tagName) !== "textarea" || el.disabled || el.readOnly ||
          typeof el.selectionStart !== "number" || el.selectionStart !== el.selectionEnd) return;
      const start = el.selectionStart;
      const lineStart = el.value.lastIndexOf("\n", start - 1) + 1;
      const prefix = el.value.slice(lineStart, start);
      if (prefix && /^[\t ]+$/.test(prefix)) {
        // Let the browser replace the indentation together with the selection.
        // Keeping the value untouched preserves native input events and undo.
        el.setSelectionRange(lineStart, el.selectionEnd, el.selectionDirection);
      }
    }

    function insertIntoMonaco(editor, text, Selection, cleanIndent = false) {
      // An incomplete exposed API must leave the original paste untouched.
      if (typeof Selection !== "function" ||
          ["getModel", "getSelections", "getRawOptions", "pushUndoStop", "executeEdits"]
            .some(name => typeof editor?.[name] !== "function")) return false;
      const model = editor.getModel();
      if (!model || ["getValue", "getVersionId", "getLineContent"]
          .some(name => typeof model[name] !== "function")) return false;
      const selections = editor.getSelections();
      // Preserve Monaco's native multicursor semantics rather than guessing
      // how clipboard content should be distributed among several selections.
      if (!model || selections?.length !== 1 || editor.getRawOptions().readOnly) {
        return false;
      }

      const selection = selections[0];
      const range = {
        startLineNumber: selection.startLineNumber,
        startColumn: selection.startColumn,
        endLineNumber: selection.endLineNumber,
        endColumn: selection.endColumn
      };
      const empty = range.startLineNumber === range.endLineNumber &&
        range.startColumn === range.endColumn;
      const prefix = model.getLineContent(range.startLineNumber)
        .slice(0, range.startColumn - 1);
      // Never collapse an existing selection or erase selected code first.
      if (cleanIndent && empty && /^[\t ]+$/.test(prefix)) range.startColumn = 1;

      // executeEdits requires real Selection instances for its end state.
      // Compute the single replacement's endpoint without internal edit IDs;
      // Monaco may include unrelated whitespace cleanup in its inverse edits.
      const lines = text.split(/\r\n|\r|\n/);
      const endLine = range.startLineNumber + lines.length - 1;
      const endColumn = lines.length === 1
        ? range.startColumn + text.length
        : lines[lines.length - 1].length + 1;
      const endSelections = [new Selection(endLine, endColumn, endLine, endColumn)];

      // Keep the exact model, not a later model returned after a callback.
      // A version change also detects a same-text replacement whose content
      // comparison alone cannot distinguish from a rejected/no-op edit.
      const beforeValue = model.getValue();
      const beforeVersion = model.getVersionId();
      const didMutate = () => {
        try { if (model.getVersionId() !== beforeVersion) return true; } catch (_) {}
        try { if (model.getValue() !== beforeValue) return true; } catch (_) {}
        return false;
      };
      editor.pushUndoStop();
      let inserted = false;
      try {
        inserted = editor.executeEdits("pasteUnlock",
          [{ range, text, forceMoveMarkers: true }], endSelections) === true;
      } catch (err) {
        console.warn("[pasteUnlock] Monaco edit failed:", err);
      } finally {
        // Close the undo group even if an editor callback throws after writing.
        // Failure here must not turn a completed edit into a native retry.
        try { editor.pushUndoStop(); } catch (err) {
          console.warn("[pasteUnlock] Monaco undo boundary failed:", err);
        }
      }
      return inserted || didMutate();
    }

    function insertEditor(route, text, { cleanIndent = false } = {}) {
      if (!writable(route)) return false;
      const { editor, type } = route;
      if (type === "codemirror") {
        editor.operation(() => {
          const ranges = editor.listSelections();
          // Expanding multiple ranges can merge cursors or create overlapping
          // edits. Preserve their original boundaries, including for cuts.
          if (cleanIndent && ranges.length === 1) {
            const { anchor: a, head: h } = ranges[0];
            const start = a.line < h.line || (a.line === h.line && a.ch <= h.ch) ? a : h;
            const end = start === a ? h : a;
            const prefix = editor.getLine(start.line).slice(0, start.ch);
            if (prefix && /^[\t ]+$/.test(prefix)) {
              editor.setSelection({ line: start.line, ch: 0 }, end);
            }
          }
          editor.replaceSelections(ranges.map(() => text), "end", "+input");
        });
      } else if (type === "monaco") {
        // Bundled Monaco keeps real Selection instances on the editor even
        // when React has not exposed a global Monaco namespace.
        const Selection = route.api ? route.api.Selection : editor.getSelections?.()?.[0]?.constructor;
        if (!insertIntoMonaco(editor, text, Selection, cleanIndent)) return false;
      } else if (type === "ace") {
        editor.insert(text);
      } else if (type === "codemirror6") {
        editor.dispatch(editor.state.replaceSelection(text), {
          scrollIntoView: true,
          userEvent: "input.paste"
        });
      } else {
        return false;
      }
      lastRoute = type;
      return true;
    }

    function selectedText(route) {
      const { type, editor } = route;
      if (type === "codemirror") return editor.getSelections().join("\n");
      if (type === "ace") return editor.getSelectedText();
      if (type === "codemirror6") {
        return editor.state.selection.ranges.map(r => editor.state.sliceDoc(r.from, r.to)).join("\n");
      }
      if (type === "monaco") {
        const model = editor.getModel();
        return model ? editor.getSelections().map(r => model.getValueInRange(r)).join("\n") : "";
      }
      return "";
    }

    function stopPageHandlers(event) {
      event.stopImmediatePropagation();
    }

    function installWindow(win) {
      let doc;
      try { doc = win.document; } catch (_) { return; }
      if (!doc || docs.has(doc) || doc[DOC_MARK]) return;
      // Reinstalling the userscript without refreshing would retain old
      // window-capture handlers. Refresh after updating from 3.1.x.
      docs.add(doc);
      Object.defineProperty(doc, DOC_MARK, { value: true });
      documentCount++;
      rememberMonaco(win.monaco || win.Monaco);

      // Window capture runs before document/React/inline handlers. Keep default
      // editing enabled so the browser generates real input events and undo.
      for (const type of ["keydown", "keyup"]) {
        win.addEventListener(type, event => {
          if (event.isComposing || event.altKey) return;
          const key = lower(event.key);
          const shortcut = ((event.ctrlKey || event.metaKey) && ["a", "c", "v", "x"].includes(key)) ||
            (event.shiftKey && key === "insert");
          const route = shortcut ? routeFor(event.target, win) : null;
          if (route && route.type !== "unresolved") {
            if (type === "keydown" && key === "a" && route.type !== "native") {
              const editor = route.editor;
              if (route.type === "codemirror") editor.execCommand("selectAll");
              if (route.type === "ace") editor.selectAll();
              if (route.type === "monaco" && editor.getModel()) {
                editor.setSelection(editor.getModel().getFullModelRange());
              }
              if (route.type === "codemirror6") {
                editor.dispatch({ selection: { anchor: 0, head: editor.state.doc.length } });
              }
              event.preventDefault();
            }
            stopPageHandlers(event);
          }
        }, true);
      }

      win.addEventListener("paste", event => {
        const route = routeFor(event.target, win);
        if (route.type === "unresolved") return;
        if (route.type === "native") {
          if (getClipboardTextFromEvent(event)) prepareNativePaste(route.el);
          stopPageHandlers(event);
          lastRoute = "native";
          return;
        }
        const text = getClipboardTextFromEvent(event);
        if (!text) return;
        try {
          if (!writable(route)) return;
          if (insertEditor(route, text, { cleanIndent: true })) {
            event.preventDefault();
            stopPageHandlers(event);
          }
        } catch (err) {
          console.warn("[pasteUnlock] editor insertion failed; preserving native paste", err);
        }
      }, true);

      for (const type of ["copy", "cut"]) {
        win.addEventListener(type, event => {
          const route = routeFor(event.target, win);
          if (route.type === "unresolved") return;
          if (route.type === "native") {
            stopPageHandlers(event);
            return;
          }
          try {
            const text = selectedText(route);
            if (!text || !event.clipboardData) return;
            if (type === "cut" && !writable(route)) return;
            event.clipboardData.setData("text/plain", text);
            if (type === "cut" && !insertEditor(route, "")) return;
            event.preventDefault();
            stopPageHandlers(event);
          } catch (err) { console.warn("[pasteUnlock] copy/cut failed", err); }
        }, true);
      }

      win.addEventListener("beforeinput", event => {
        if (lower(event.inputType) === "insertfrompaste" &&
            routeFor(event.target, win).type === "native") stopPageHandlers(event);
      }, true);
      for (const type of ["contextmenu", "selectstart"]) {
        win.addEventListener(type, event => {
          if (!editorRoot(toElement(event.target))) stopPageHandlers(event);
        }, true);
      }

      function patchFrame(frame) {
        if (!frames.has(frame)) {
          frames.add(frame);
          frame.addEventListener("load", () => {
            try { installWindow(frame.contentWindow); } catch (_) {}
          });
        }
        try { installWindow(frame.contentWindow); } catch (_) {}
      }

      function scan(root) {
        if (root?.matches?.("iframe,frame")) patchFrame(root);
        root?.querySelectorAll?.("iframe,frame").forEach(patchFrame);
      }

      function ready() {
        if (!doc.getElementById("__pasteUnlock_user_select__")) {
          const style = doc.createElement("style");
          style.id = "__pasteUnlock_user_select__";
          style.textContent = "html body,html body *{-webkit-user-select:text!important;user-select:text!important}";
          (doc.head || doc.documentElement).appendChild(style);
        }
        scan(doc);
        const observer = new win.MutationObserver(records => {
          for (const record of records) {
            for (const node of record.addedNodes) scan(node);
          }
        });
        observer.observe(doc.documentElement, { childList: true, subtree: true });
      }
      if (doc.documentElement) ready();
      else doc.addEventListener("DOMContentLoaded", ready, { once: true });
    }

    installWindow(window);
    window.__pastePatchInstall = () => {
      // Useful after a SPA route change; existing documents are not patched twice.
      const visit = win => {
        try {
          installWindow(win);
          rememberMonaco(win.monaco || win.Monaco);
          win.document.querySelectorAll("iframe,frame").forEach(frame => visit(frame.contentWindow));
        } catch (_) {}
      };
      visit(window);
    };
    window.__pastePatchStatus = () => ({
      version: VERSION, documentCount, lastRoute, monacoEditorCount: monacoEditors.size
    });
    console.info("[pasteUnlock] 头歌复制/粘贴兼容修复已启用", VERSION);
  }


  // ============================================================
  // 超星 / 学习通 / 学银 / 尔雅：CodeMirror / UEditor / 富文本粘贴增强
  // ============================================================
  function installChaoxingPasteEnhancer() {
    const INSTANCE_ID = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const WIN_MARK = "__ystPasteUnlockWindowPatched300__";
    const DOC_MARK = "__ystPasteUnlockDocumentPatched300__";
    const INTERNAL_HANDLER_MARK = "__ystPasteUnlockInternalHandler__";

    function getMark(obj, key) {
      try {
        return obj?.[key] || null;
      } catch (_) {
        return null;
      }
    }

    function markObject(obj, key) {
      if (!obj) return false;

      try {
        const mark = getMark(obj, key);
        if (mark?.owner && mark.owner !== INSTANCE_ID) return false;
        if (mark?.owner === INSTANCE_ID) return true;

        Object.defineProperty(obj, key, {
          value: {
            owner: INSTANCE_ID
          },
          configurable: true,
          enumerable: false,
          writable: false
        });
        return true;
      } catch (_) {
        try {
          const mark = getMark(obj, key);
          if (mark?.owner && mark.owner !== INSTANCE_ID) return false;
          obj[key] = {
            owner: INSTANCE_ID
          };
          return true;
        } catch (_) {
          return true;
        }
      }
    }

    function ownedByOther(obj, key) {
      const mark = getMark(obj, key);
      return !!(mark?.owner && mark.owner !== INSTANCE_ID);
    }

    if (ownedByOther(window, WIN_MARK)) return;
    markObject(window, WIN_MARK);

    const state = {
      listeners: [],
      observers: [],
      timers: [],
      protoRecords: [],
      domRecords: [],
      nativeByWin: new WeakMap(),
      eventTargetByWin: new WeakMap(),
      patchedDocs: new WeakSet(),
      patchedFrames: new WeakSet(),
      patchedCodeMirrors: new WeakSet(),
      patchedRichDocs: new WeakSet(),
      patchedDOMWindows: new WeakSet(),
      codeMirrors: new Set(),
      richDocs: new Set(),
      richRanges: new WeakMap(),
      lastTarget: null,
      lastTargetAt: 0,
      lastInsertAt: 0,
      lastText: "",
      activePasteSession: null,
      installing: false,
      scheduled: false,

      on(target, type, handler, options) {
        if (!target?.addEventListener) return;

        try {
          Object.defineProperty(handler, INTERNAL_HANDLER_MARK, {
            value: true,
            configurable: true,
            enumerable: false,
            writable: true
          });
        } catch (_) {
          try {
            handler[INTERNAL_HANDLER_MARK] = true;
          } catch (_) {}
        }

        try {
          const win = getTargetWin(target);
          const record = patchEventTargetPrototype(win);
          const add = record?.nativeAdd || target.addEventListener;
          add.call(target, type, handler, options);
          this.listeners.push([target, type, handler, options, add]);
        } catch (_) {
          try {
            target.addEventListener(type, handler, options);
            this.listeners.push([target, type, handler, options, null]);
          } catch (_) {}
        }
      },

      observe(target, options, callback) {
        if (!target || typeof MutationObserver === "undefined") return;

        try {
          const observer = new MutationObserver(callback);
          observer.observe(target, options);
          this.observers.push(observer);
        } catch (_) {}
      },

      addTimer(timer) {
        this.timers.push(timer);
        return timer;
      },

      remember(route) {
        if (!route) return;

        this.lastTarget = route;
        this.lastTargetAt = Date.now();

        if (route.type === "rich") {
          saveRichRange(route.doc);
        }
      },

      markInserted(route, text) {
        this.lastInsertAt = Date.now();
        this.lastText = String(text ?? "");
        this.remember(route);
      },

      cleanup() {
        for (const [target, type, handler, options, rawAdd] of this.listeners) {
          void rawAdd;

          try {
            const win = getTargetWin(target);
            const record = this.eventTargetByWin.get(win);
            const remove = record?.nativeRemove || target.removeEventListener;
            remove.call(target, type, handler, options);
          } catch (_) {
            try {
              target.removeEventListener(type, handler, options);
            } catch (_) {}
          }
        }

        for (const observer of this.observers) {
          try {
            observer.disconnect();
          } catch (_) {}
        }

        for (const timer of this.timers) {
          try {
            clearTimeout(timer);
            clearInterval(timer);
          } catch (_) {}
        }

        for (const record of this.protoRecords) {
          try {
            const proto = record.proto;

            if (proto.preventDefault === record.preventDefault) {
              proto.preventDefault = record.native.preventDefault;
            }

            if (proto.stopPropagation === record.stopPropagation) {
              proto.stopPropagation = record.native.stopPropagation;
            }

            if (
              proto.stopImmediatePropagation ===
              record.stopImmediatePropagation
            ) {
              proto.stopImmediatePropagation =
                record.native.stopImmediatePropagation;
            }
          } catch (_) {}
        }

        for (const record of this.domRecords) {
          try {
            if (
              record.kind === "method" &&
              record.proto[record.name] === record.wrapped
            ) {
              record.proto[record.name] = record.native;
            }

            if (record.kind === "accessor") {
              const now = Object.getOwnPropertyDescriptor(
                record.proto,
                record.name
              );

              if (
                now?.set === record.descriptor.set &&
                now?.get === record.descriptor.get
              ) {
                Object.defineProperty(
                  record.proto,
                  record.name,
                  record.nativeDescriptor
                );
              }
            }
          } catch (_) {}
        }

        try {
          this.activePasteSession?.cleanup?.();
        } catch (_) {}

        this.listeners = [];
        this.observers = [];
        this.timers = [];
        this.protoRecords = [];
        this.domRecords = [];
        this.codeMirrors.clear();
        this.richDocs.clear();
        this.lastTarget = null;
        this.activePasteSession = null;
      }
    };

    function getFrameElement(win) {
      try {
        return win?.frameElement || null;
      } catch (_) {
        return null;
      }
    }

    function isTopWindow(win) {
      try {
        return win.top === win;
      } catch (_) {
        return false;
      }
    }

    function eventWindow(e) {
      return getWin(getDoc(e?.target) || getDoc(e?.currentTarget));
    }

    function eventPath(e) {
      const path = [];

      try {
        if (typeof e?.composedPath === "function") {
          path.push(...e.composedPath());
        }
      } catch (_) {}

      try {
        if (e?.target) path.push(e.target);
      } catch (_) {}

      try {
        if (e?.currentTarget) path.push(e.currentTarget);
      } catch (_) {}

      try {
        const doc = getDoc(e?.target) || getDoc(e?.currentTarget);

        if (doc) {
          path.push(
            doc.activeElement,
            doc.body,
            doc.documentElement,
            doc.defaultView
          );
        }
      } catch (_) {}

      return [...new Set(path.filter(Boolean))];
    }

    function isPasteKey(e) {
      return (e?.ctrlKey || e?.metaKey) && !e?.altKey && lower(e?.key) === "v";
    }

    function isPasteLikeEvent(e) {
      return !!e && (
        e.type === "paste" ||
        (e.type === "beforeinput" &&
          lower(e.inputType) === "insertfrompaste") ||
        (e.type === "keydown" && isPasteKey(e))
      );
    }

    function patchEventTargetPrototype(win) {
      if (!win) return null;

      try {
        if (state.eventTargetByWin.has(win)) {
          return state.eventTargetByWin.get(win);
        }

        const proto = win.EventTarget?.prototype;
        if (!proto) return null;

        const nativeAdd = proto.addEventListener;
        const nativeRemove = proto.removeEventListener;

        if (
          typeof nativeAdd !== "function" ||
          typeof nativeRemove !== "function"
        ) {
          return null;
        }

        const wrappedMap = new WeakMap();

        const listenerKey = (type, options) => {
          let capture = false;

          try {
            capture =
              typeof options === "boolean" ? options : !!options?.capture;
          } catch (_) {}

          return `${String(type)}::${capture ? "1" : "0"}`;
        };

        const shouldWrapType = type => {
          type = lower(type);
          return type === "paste" || type === "beforeinput" || type === "keydown";
        };

        const getWrapped = (listener, type, options) => {
          if (!listener) return listener;
          if (listener?.[INTERNAL_HANDLER_MARK]) return listener;
          if (!shouldWrapType(type)) return listener;

          const key = listenerKey(type, options);
          let byKey = wrappedMap.get(listener);

          if (!byKey) {
            byKey = new Map();
            wrappedMap.set(listener, byKey);
          }

          if (byKey.has(key)) return byKey.get(key);

          const wrapped = function (event) {
            try {
              if (shouldSuppressExternalPasteListener(event, type)) {
                event.__ystPasteExternalListenerSuppressed = true;
                return;
              }
            } catch (_) {}

            if (typeof listener === "function") {
              return listener.call(this, event);
            }

            if (listener && typeof listener.handleEvent === "function") {
              return listener.handleEvent.call(listener, event);
            }
          };

          byKey.set(key, wrapped);
          return wrapped;
        };

        const patchedAdd = function (type, listener, options) {
          return nativeAdd.call(
            this,
            type,
            getWrapped(listener, type, options),
            options
          );
        };

        const patchedRemove = function (type, listener, options) {
          let wrapped = listener;

          try {
            const byKey = wrappedMap.get(listener);
            const key = listenerKey(type, options);
            wrapped = byKey?.get(key) || listener;
          } catch (_) {}

          return nativeRemove.call(this, type, wrapped, options);
        };

        proto.addEventListener = patchedAdd;
        proto.removeEventListener = patchedRemove;

        const record = {
          nativeAdd,
          nativeRemove,
          patchedAdd,
          patchedRemove,
          proto
        };

        state.eventTargetByWin.set(win, record);

        state.domRecords.push({
          kind: "method",
          proto,
          name: "addEventListener",
          native: nativeAdd,
          wrapped: patchedAdd
        });

        state.domRecords.push({
          kind: "method",
          proto,
          name: "removeEventListener",
          native: nativeRemove,
          wrapped: patchedRemove
        });

        return record;
      } catch (_) {
        return null;
      }
    }

    function patchEventPrototype(win) {
      if (!win) return null;

      try {
        if (state.nativeByWin.has(win)) {
          return state.nativeByWin.get(win);
        }

        const proto = win.Event?.prototype;
        if (!proto) return null;

        const native = {
          preventDefault: proto.preventDefault,
          stopPropagation: proto.stopPropagation,
          stopImmediatePropagation: proto.stopImmediatePropagation
        };

        const record = {
          native,
          preventDefault: null,
          stopPropagation: null,
          stopImmediatePropagation: null
        };

        record.preventDefault = function (...args) {
          try {
            if (shouldNeutralizePasteBlocker(this)) {
              this.__cxPastePreventDefaultIgnored = true;
              return;
            }
          } catch (_) {}

          return native.preventDefault.apply(this, args);
        };

        record.stopPropagation = function (...args) {
          try {
            if (shouldNeutralizePasteBlocker(this)) {
              this.__cxPasteStopPropagationIgnored = true;
              return;
            }
          } catch (_) {}

          return native.stopPropagation.apply(this, args);
        };

        record.stopImmediatePropagation = function (...args) {
          try {
            if (shouldNeutralizePasteBlocker(this)) {
              this.__cxPasteStopImmediatePropagationIgnored = true;
              return;
            }
          } catch (_) {}

          return native.stopImmediatePropagation.apply(this, args);
        };

        proto.preventDefault = record.preventDefault;
        proto.stopPropagation = record.stopPropagation;
        proto.stopImmediatePropagation = record.stopImmediatePropagation;

        state.nativeByWin.set(win, record);

        state.protoRecords.push({
          win,
          proto,
          native,
          preventDefault: record.preventDefault,
          stopPropagation: record.stopPropagation,
          stopImmediatePropagation: record.stopImmediatePropagation
        });

        return record;
      } catch (_) {
        return null;
      }
    }

    function nativeEventMethods(win) {
      return patchEventPrototype(win)?.native || {
        preventDefault: Event.prototype.preventDefault,
        stopPropagation: Event.prototype.stopPropagation,
        stopImmediatePropagation: Event.prototype.stopImmediatePropagation
      };
    }

    function hardCancel(e) {
      const native = nativeEventMethods(eventWindow(e));

      try {
        native.preventDefault.call(e);
      } catch (_) {}

      try {
        native.stopPropagation.call(e);
      } catch (_) {}

      try {
        native.stopImmediatePropagation.call(e);
      } catch (_) {}
    }

    function stopOnly(e) {
      const native = nativeEventMethods(eventWindow(e));

      try {
        native.stopPropagation.call(e);
      } catch (_) {}

      try {
        native.stopImmediatePropagation.call(e);
      } catch (_) {}
    }

    function isPasteCatcherNode(node) {
      const el = toElement(node);
      return !!el?.closest?.("[data-cx-paste-catcher='1']");
    }

    function isPlainInput(el) {
      el = toElement(el);
      if (!el) return false;

      const tag = lower(el.tagName);

      if (tag === "textarea" || tag === "select") return true;

      if (tag === "input") {
        const type = lower(el.getAttribute("type") || "text");

        return ![
          "button",
          "checkbox",
          "color",
          "file",
          "hidden",
          "image",
          "radio",
          "range",
          "reset",
          "submit"
        ].includes(type);
      }

      return false;
    }

    function isEditableElement(el) {
      el = toElement(el);
      if (!el) return false;

      try {
        if (el.isContentEditable) return true;
      } catch (_) {}

      try {
        const value = el.getAttribute("contenteditable");
        if (value == null) return false;
        const attr = lower(value);
        return attr === "true" || attr === "plaintext-only" || attr === "";
      } catch (_) {
        return false;
      }
    }

    function isExplicitlyNonEditable(node) {
      try {
        for (let cur = toElement(node); cur; cur = cur.parentElement) {
          const value = cur.getAttribute?.("contenteditable");
          if (value == null) continue;

          const attr = lower(value);
          if (attr === "false") return true;
          // A nested editable host may explicitly reopen editing.
          if (attr === "true" || attr === "plaintext-only" || attr === "") {
            return false;
          }
        }
      } catch (_) {}

      return false;
    }

    function closestEditableHost(node) {
      const start = toElement(node);
      if (!start || isPlainInput(start) || isExplicitlyNonEditable(start)) return null;

      let host = null;
      try {
        for (let cur = start; cur && cur.nodeType === 1; cur = cur.parentElement) {
          if (isPlainInput(cur) || lower(cur.getAttribute?.("contenteditable")) === "false") break;
          if (isEditableElement(cur)) host = cur;
          else if (host) break;
        }
      } catch (_) {}
      return host;
    }

    function findCodeMirrorFromElement(el) {
      el = toElement(el);
      if (!el) return null;

      try {
        const wrapper = el.closest?.(".CodeMirror");
        if (wrapper?.CodeMirror) return wrapper.CodeMirror;
      } catch (_) {}

      for (const cm of state.codeMirrors) {
        try {
          const wrapper = cm.getWrapperElement?.();

          if (wrapper && (wrapper === el || wrapper.contains(el))) {
            return cm;
          }

          const input = cm.getInputField?.();

          if (input && (input === el || input.contains?.(el))) {
            return cm;
          }

          const textarea = cm.getTextArea?.();

          if (textarea && textarea === el) {
            return cm;
          }
        } catch (_) {}
      }

      return null;
    }

    function findCodeMirrorFromEvent(e) {
      // Only the actual event target identifies the editor. Other frames may
      // retain activeElement, and a recently used editor is not a paste target.
      const doc = getDoc(e?.target) || getDoc(e?.currentTarget);
      if (!e?.target?.nodeType || e.target.nodeType === 9) {
        if (!documentHasFocus(doc)) return null;
      }
      return findCodeMirrorFromElement(e?.target);
    }

    function replaceInCodeMirror(cm, text) {
      // Respect author read-only settings and beforeChange validators. Never
      // rewrite options or private handlers to force a cancelled edit through.
      if (typeof cm.getOption !== "function" || cm.getOption("readOnly")) return false;
      const doc = cm.getDoc ? cm.getDoc() : cm.doc;
      if (!doc || typeof doc.getValue !== "function") return false;
      const before = doc.getValue();
      const selectionState = () => {
        if (typeof cm.listSelections === "function") return JSON.stringify(cm.listSelections());
        if (typeof doc.getCursor === "function") {
          return JSON.stringify([doc.getCursor("from"), doc.getCursor("to")]);
        }
        return null;
      };
      const beforeSelection = selectionState();
      let changed = false;
      let rangeStart = null;
      let appliedChange = null;
      const onChange = (_editor, change) => { changed = true; appliedChange = change; };
      const observesChanges = typeof cm.on === "function" && typeof cm.off === "function";
      const run = () => {
        const selections = cm.listSelections?.();
        if (selections?.length > 1) {
          if (typeof cm.replaceSelections !== "function") return;
          cm.replaceSelections(selections.map(() => text), "end", "paste");
        } else if (typeof cm.replaceSelection === "function") {
          cm.replaceSelection(text, "end", "paste");
        } else if (typeof doc.replaceSelection === "function") {
          doc.replaceSelection(text, "end", "paste");
        } else if (typeof doc.replaceRange === "function" && typeof doc.getCursor === "function") {
          // getCursor() alone discards the selected span, especially backwards selections.
          const from = doc.getCursor("from");
          const to = doc.getCursor("to");
          if (from && to) {
            rangeStart = { line: from.line, ch: from.ch };
            doc.replaceRange(text, from, to, "paste");
          }
        }
      };
      try {
        if (observesChanges) cm.on("change", onChange);
        if (typeof cm.operation === "function") cm.operation(run);
        else run();
      } catch (_) {
        // A site change listener can throw after the model was already edited.
        // Verify the result below rather than allowing a second native paste.
      } finally {
        if (observesChanges) { try { cm.off("change", onChange); } catch (_) {} }
      }
      // Same-text replacements may only collapse the selection. A cancelled
      // beforeChange leaves both content and selection intact; never retry it.
      let inserted = changed;
      try { inserted = inserted || doc.getValue() !== before || selectionState() !== beforeSelection; } catch (_) {}
      if (inserted) {
        if (rangeStart && typeof doc.setCursor === "function" &&
            appliedChange?.from && Array.isArray(appliedChange.text) && appliedChange.text.length) {
          // Public change data reflects any beforeChange text transformation.
          // Without it, retain the editor's own selection mapping rather than guess.
          const lines = appliedChange.text;
          const from = appliedChange.from;
          const end = { line: from.line + lines.length - 1,
            ch: lines.length === 1 ? from.ch + lines[0].length : lines[lines.length - 1].length };
          try { doc.setCursor(end); } catch (_) {}
        }
        try { cm.save?.(); } catch (_) {}
      }
      return inserted;
    }

    function insertIntoCodeMirror(cm, text) {
      text = String(text ?? "");
      if (!cm || !text) return false;
      let ok = false;
      try { ok = replaceInCodeMirror(cm, text); } catch (_) {}
      if (ok) state.markInserted({ type: "codemirror", cm }, text);
      return ok;
    }

    function escapeHTML(text) {
      return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function escapeRichLine(line) {
      return escapeHTML(line)
        .replace(/\t/g, "    ")
        .replace(/ {2}/g, " &nbsp;");
    }

    function plainTextToRichHTML(text) {
      return String(text ?? "")
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map(line => escapeRichLine(line))
        .join("<br>");
    }

    function hasRichEditorMarks(doc) {
      try {
        return !!doc.querySelector(
          [
            'link[href*="editor/themes/iframe.css"]',
            'link[href*="ueditor"]',
            'script[src*="ueditor"]',
            ".edui-body-container",
            "#baidu_pastebin",
            "style#table",
            "style#list",
            '[contenteditable="true"]',
            '[contenteditable="plaintext-only"]',
            '[role="textbox"]'
          ].join(",")
        );
      } catch (_) {
        return false;
      }
    }

    function looksLikeRichFrame(win, doc) {
      const frame = getFrameElement(win);
      if (!frame) return false;

      try {
        const info = lower(
          [
            frame.id,
            frame.name,
            frame.className,
            frame.title,
            frame.getAttribute?.("src")
          ].join(" ")
        );

        if (/ueditor|edui|editor|rich|iframeholder/.test(info)) {
          return true;
        }

        if (
          frame.closest?.(
            ".edui-editor,.edui-editor-iframeholder,.ueditor,.richtext,.rich-text,.editor"
          )
        ) {
          return true;
        }
      } catch (_) {}

      try {
        const url = lower(`${doc.URL || ""} ${win.location?.href || ""}`);

        if (
          /ueditor|editor\/themes\/iframe|kindeditor|ckeditor|fckeditor/.test(
            url
          )
        ) {
          return true;
        }
      } catch (_) {}

      return false;
    }

    function looksLikeRichDoc(doc) {
      if (!doc?.body) return false;

      const win = getWin(doc);

      try {
        if (lower(doc.designMode) === "on") return true;
      } catch (_) {}

      if (
        isEditableElement(doc.body) ||
        isEditableElement(doc.documentElement) ||
        closestEditableHost(doc.activeElement)
      ) {
        return true;
      }

      if (hasRichEditorMarks(doc)) return true;

      if (!isTopWindow(win) && looksLikeRichFrame(win, doc)) {
        return true;
      }

      try {
        const cls = lower(
          `${doc.documentElement?.className || ""} ${doc.body?.className || ""}`
        );

        if (!isTopWindow(win) && /\b(view|edit|editable|edui|ueditor)\b/.test(cls)) {
          return true;
        }
      } catch (_) {}

      return false;
    }

    function rangeBelongsToDoc(range, doc) {
      if (!range || !doc?.body) return false;

      try {
        const node = range.commonAncestorContainer;
        if (!node) return false;

        const el = node.nodeType === 1 ? node : node.parentElement;
        if (el && isPasteCatcherNode(el)) return false;

        if (
          node === doc ||
          node === doc.body ||
          node === doc.documentElement
        ) {
          return true;
        }

        const owner = node.ownerDocument || node.document;
        if (owner !== doc) return false;

        return !!el && (el === doc.body || doc.body.contains(el));
      } catch (_) {
        return false;
      }
    }

    function saveRichRange(doc) {
      if (!doc?.body) return false;

      try {
        if (state.activePasteSession?.route?.doc === doc) {
          return false;
        }

        const sel = getWin(doc).getSelection?.();
        if (!sel || sel.rangeCount < 1) return false;

        const range = sel.getRangeAt(0);

        const host = getDefaultRichHost(doc);
        if (!rangeBelongsToRichHost(range, doc, host)) return false;

        state.richRanges.set(doc, range.cloneRange());
        return true;
      } catch (_) {
        return false;
      }
    }

    function documentHasFocus(doc) {
      try {
        if (doc?.hasFocus?.() !== true) return false;
        let frame = getFrameElement(getWin(doc));
        while (frame) {
          if (frame.isConnected === false || frame.ownerDocument?.activeElement !== frame) return false;
          frame = getFrameElement(getWin(frame.ownerDocument));
        }
        return true;
      } catch (_) {
        return false;
      }
    }

    function getDefaultRichHost(doc, preferred) {
      if (!doc?.body) return null;
      if (!preferred && !documentHasFocus(doc)) return null;
      const el = toElement(preferred || doc.activeElement);
      if (!el || el.ownerDocument !== doc || el.isConnected === false ||
          isPlainInput(el) || isPasteCatcherNode(el) || isExplicitlyNonEditable(el)) return null;

      // Whole-document editing is still confined to visible body content.
      if (el !== doc.body && !doc.body.contains(el)) return null;
      if (lower(doc.designMode) === "on") return doc.body;
      const host = closestEditableHost(el);
      return host === doc.documentElement ? doc.body : host;
    }

    function rangeBelongsToRichHost(range, doc, host) {
      if (!host || !rangeBelongsToDoc(range, doc)) return false;
      try {
        return [range.startContainer, range.endContainer].every(node =>
          node && (node === host || host.contains(node)) &&
          getDefaultRichHost(doc, toElement(node)) === host
        );
      } catch (_) {
        return false;
      }
    }

    function focusRichDoc(doc, preferredHost) {
      if (!doc?.body) return;

      const win = getWin(doc);
      const frame = getFrameElement(win);
      const host = getDefaultRichHost(doc, preferredHost);
      if (!host) return;

      try {
        frame?.focus?.({ preventScroll: true });
      } catch (_) {}

      try {
        win.focus?.();
      } catch (_) {}

      try {
        if (host && typeof host.focus === "function") {
          host.focus({ preventScroll: true });
        }
      } catch (_) {}

      try {
        win.focus?.();
      } catch (_) {}
    }

    function ensureRichRange(doc, preferredHost) {
      if (!doc?.body) return null;
      const host = getDefaultRichHost(doc, preferredHost);
      if (!host) return null;
      const win = getWin(doc);

      try {
        const sel = win.getSelection?.();
        if (!sel) return null;
        // The caret may have moved before selectionchange has been delivered.
        if (sel.rangeCount > 0) {
          const current = sel.getRangeAt(0);
          if (!rangeBelongsToRichHost(current, doc, host)) return null;
          state.richRanges.set(doc, current.cloneRange());
          return current;
        }
        const saved = state.richRanges.get(doc);
        if (saved && rangeBelongsToRichHost(saved, doc, host)) {
          sel.removeAllRanges();
          sel.addRange(saved);
          return saved;
        }
        const range = doc.createRange();
        range.selectNodeContents(host);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        state.richRanges.set(doc, range.cloneRange());
        return range;
      } catch (_) {
        return null;
      }
    }

    function isRichBlockElement(el) {
      if (!el || el.nodeType !== 1) return false;

      return /^(P|DIV|LI|TD|TH|BLOCKQUOTE|H1|H2|H3|H4|H5|H6)$/i.test(
        el.tagName
      );
    }

    function findBlockForRange(range, host, doc) {
      if (!range) return null;

      let node = range.startContainer;

      if (node && node.nodeType !== 1) {
        node = node.parentElement;
      }

      try {
        while (node && node !== doc.body && node !== doc.documentElement) {
          if (isRichBlockElement(node)) return node;
          if (host && node === host) break;
          node = node.parentElement;
        }
      } catch (_) {}

      return null;
    }

    function isVisuallyEmptyBlock(el) {
      if (!el || el.nodeType !== 1) return false;

      try {
        const text = String(el.textContent || "")
          .replace(/[\u200B\uFEFF\u00A0]/g, "")
          .trim();

        if (text) return false;

        for (const child of [...el.childNodes]) {
          if (child.nodeType === 3) {
            if (
              String(child.nodeValue || "")
                .replace(/[\u200B\uFEFF\u00A0]/g, "")
                .trim()
            ) {
              return false;
            }

            continue;
          }

          if (child.nodeType !== 1) continue;

          const tag = lower(child.tagName);

          if (tag === "br") continue;
          if (tag === "span" && isVisuallyEmptyBlock(child)) continue;

          return false;
        }

        return true;
      } catch (_) {
        return false;
      }
    }

    function findSingleEmptyBlockInHost(host) {
      if (!host || host.nodeType !== 1) return null;

      try {
        const children = [...host.children].filter(
          el => !isPasteCatcherNode(el)
        );

        if (
          children.length === 1 &&
          isRichBlockElement(children[0]) &&
          isVisuallyEmptyBlock(children[0])
        ) {
          return children[0];
        }
      } catch (_) {}

      return null;
    }

    function normalizeRangeBeforeRichInsert(doc, range, host) {
      if (!doc?.body || !range) return range;

      try {
        if (!range.collapsed) return range;

        let block = findBlockForRange(range, host, doc);

        if (!block) {
          block = findSingleEmptyBlockInHost(host);
        }

        if (!block || block === doc.body || !isVisuallyEmptyBlock(block)) {
          return range;
        }

        while (block.firstChild) {
          block.removeChild(block.firstChild);
        }

        const newRange = doc.createRange();
        newRange.selectNodeContents(block);
        newRange.collapse(true);

        const sel = getWin(doc).getSelection?.();

        if (sel) {
          sel.removeAllRanges();
          sel.addRange(newRange);
        }

        state.richRanges.set(doc, newRange.cloneRange());
        return newRange;
      } catch (_) {
        return range;
      }
    }

    function findUEditorByDoc(doc, host) {
      if (!doc) return null;

      const win = getWin(doc);
      const candidates = [];

      const pushUE = UE => {
        if (UE && !candidates.includes(UE)) {
          candidates.push(UE);
        }
      };

      try {
        pushUE(window.UE);
      } catch (_) {}

      try {
        pushUE(win.UE);
      } catch (_) {}

      try {
        pushUE(win.parent?.UE);
      } catch (_) {}

      try {
        pushUE(win.top?.UE);
      } catch (_) {}

      try {
        pushUE(parent?.UE);
      } catch (_) {}

      try {
        pushUE(top?.UE);
      } catch (_) {}

      // Registry lookup is read-only. UE.getEditor(id) creates an editor and
      // a guessed frame name is not proof that an instance owns this document.
      for (const UE of candidates) {
        try {
          const instances = new Set([UE.instants, UE.instances, UE._instances]
            .filter(Boolean).flatMap(registry => Object.values(registry)));

          for (const editor of instances) {

            try {
              const iframe = editor?.iframe || editor?._iframe;
              // Inline editors can share a document. Document identity alone
              // must not send commands or synchronization to a sibling host.
              if (host && (editor?.body ? editor.body !== host : host !== doc.body)) continue;

              if (
                editor?.document === doc ||
                editor?.window === win ||
                editor?.body === doc.body ||
                iframe?.contentDocument === doc ||
                iframe?.contentWindow === win
              ) {
                return editor;
              }
            } catch (_) {}
          }
        } catch (_) {}
      }

      return null;
    }

    function syncRichEditor(doc, host) {
      const win = getWin(doc);
      const editor = findUEditorByDoc(doc, host);

      if (editor) {
        try {
          editor.fireEvent?.("contentchange");
        } catch (_) {}

        try {
          editor.fireEvent?.("selectionchange");
        } catch (_) {}

        try {
          editor.sync?.();
        } catch (_) {}

        try {
          const textarea =
            editor.textarea ||
            editor.textareaInput ||
            editor.container?.querySelector?.("textarea");

          if (textarea) {
            dispatchBasicEvents(
              textarea,
              textarea.ownerDocument?.defaultView || win
            );
          }
        } catch (_) {}
      }

      for (const target of [
        host,
        doc.body,
        doc.documentElement,
        getFrameElement(win)
      ].filter(Boolean)) {
        try {
          dispatchBasicEvents(target, target.ownerDocument?.defaultView || win);
        } catch (_) {}
      }

      try {
        doc.dispatchEvent(
          new win.Event("selectionchange", {
            bubbles: true,
            cancelable: true
          })
        );
      } catch (_) {}
    }

    function insertHTMLByRange(route, html) {
      const doc = route.doc;
      const host = getDefaultRichHost(doc, route.el);

      if (!host || html == null) return false;

      const before = doc.body.innerHTML;

      try {
        const win = getWin(doc);
        const sel = win.getSelection?.();

        if (!sel) return false;

        let range = ensureRichRange(doc, host);

        if (!rangeBelongsToRichHost(range, doc, host)) return false;

        range = normalizeRangeBeforeRichInsert(doc, range, host);

        const temp = doc.createElement("div");
        temp.innerHTML = html;

        const frag = doc.createDocumentFragment();
        let node;
        let last = null;

        while ((node = temp.firstChild)) {
          last = frag.appendChild(node);
        }

        if (!last) return false;

        range.deleteContents();
        range.insertNode(frag);

        const newRange = doc.createRange();
        newRange.setStartAfter(last);
        newRange.collapse(true);

        sel.removeAllRanges();
        sel.addRange(newRange);

        state.richRanges.set(doc, newRange.cloneRange());

        syncRichEditor(doc, host);
        focusRichDoc(doc, host);

        return doc.body.innerHTML !== before;
      } catch (_) {
        return false;
      }
    }

    function insertIntoUEditor(route, html) {
      if (!isCurrentRoute(route)) return false;
      const { doc, el: host } = route;
      const range = ensureRichRange(doc, host);
      if (!rangeBelongsToRichHost(range, doc, host)) return false;
      const editor = findUEditorByDoc(doc, host);
      if (!editor || typeof editor.execCommand !== "function" ||
          typeof editor.queryCommandState !== "function" ||
          editor.queryCommandState("insertHTML") === -1) return false;
      const editorRange = editor.selection?.getRange?.();
      if (!editorRange || typeof editorRange.setStart !== "function" ||
          typeof editorRange.setEnd !== "function" || typeof editorRange.select !== "function") return false;
      // UEditor's command owns its undo history and contentchange events.
      // Populate its range from the already verified live DOM selection.
      editorRange.setStart(range.startContainer, range.startOffset);
      editorRange.setEnd(range.endContainer, range.endOffset);
      editorRange.select();
      if (!isCurrentRoute(route)) return false;
      const before = host.innerHTML;
      const start = range.startContainer, end = range.endContainer;
      const startOffset = range.startOffset, endOffset = range.endOffset;
      let result;
      try { result = editor.execCommand("insertHTML", html); } catch (_) {}
      // Some site callbacks throw after applying the command; mutation wins
      // over the return value so native paste cannot duplicate the edit.
      const selection = getWin(doc).getSelection?.();
      const after = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
      const changed = host.innerHTML !== before || (after &&
        (after.startContainer !== start || after.endContainer !== end ||
         after.startOffset !== startOffset || after.endOffset !== endOffset));
      if (result === false && !changed) return false;
      if (changed) { try { editor.sync?.(); } catch (_) {} }
      return !!changed;
    }

    function insertIntoRichEditor(route, text) {
      text = String(text ?? "");

      if (!route?.doc?.body || !text || !isCurrentRoute(route)) return false;

      const doc = route.doc;
      const host = getDefaultRichHost(doc, route.el);
      if (!host) return false;

      route.el = host;
      const range = ensureRichRange(doc, host);
      if (!rangeBelongsToRichHost(range, doc, host)) return false;

      patchRichDoc(doc, true);

      state.remember(route);

      const html = plainTextToRichHTML(text);
      let ok = false;
      try {
        // A known UEditor must use its command API; falling back to direct DOM
        // insertion after a disabled/cancelled command would bypass its policy.
        if (findUEditorByDoc(doc, host)) ok = insertIntoUEditor(route, html);
        else if (typeof doc.execCommand === "function") {
          const command = lower(host.getAttribute?.("contenteditable")) === "plaintext-only"
            ? "insertText" : "insertHTML";
          const before = host.innerHTML;
          const beforeSelection = capturePasteRoute(route);
          try { ok = doc.execCommand(command, false, command === "insertText" ? text : html); } catch (_) {}
          ok = !!ok || host.innerHTML !== before ||
            (!!beforeSelection && !matchesPasteRoute(beforeSelection));
          if (ok) syncRichEditor(doc, host);
        }
      } catch (_) {}

      if (ok) {
        state.markInserted(route, text);
        saveRichRange(doc);
      }

      return ok;
    }

    function richRouteFromEvent(e) {
      const doc = getDoc(e?.target) || getDoc(e?.currentTarget);
      if (!doc?.body) return null;
      if (!e?.target?.nodeType || e.target.nodeType === 9) {
        if (!documentHasFocus(doc)) return null;
      }
      const host = getDefaultRichHost(doc, toElement(e?.target));
      if (!host) return null;
      patchRichDoc(doc, true);
      return { type: "rich", doc, el: host };
    }

    function routeFromEvent(e) {
      const targetEl = toElement(e?.target);
      if (isExplicitlyNonEditable(targetEl)) return null;
      if (isPlainInput(targetEl) && !findCodeMirrorFromElement(targetEl)) {
        return null;
      }

      const cm = findCodeMirrorFromEvent(e);

      if (cm) {
        return {
          type: "codemirror",
          cm
        };
      }

      const rich = richRouteFromEvent(e);
      if (rich) return rich;

      return null;
    }

    function activeRoute() {
      for (const cm of state.codeMirrors) {
        try {
          const wrapper = cm.getWrapperElement?.();
          const doc = wrapper?.ownerDocument;
          if (wrapper?.isConnected === false || !documentHasFocus(doc)) continue;
          const active = doc.activeElement;
          if (active && (wrapper === active || wrapper.contains(active) || cm.getInputField?.() === active)) {
            return { type: "codemirror", cm };
          }
        } catch (_) {}
      }
      for (const doc of state.richDocs) {
        const host = getDefaultRichHost(doc);
        if (host) return { type: "rich", doc, el: host };
      }
      return null;
    }

    function isCurrentRoute(route) {
      if (route?.type === "rich") {
        return getDefaultRichHost(route.doc) === route.el;
      }
      if (route?.type !== "codemirror") return false;
      try {
        const wrapper = route.cm.getWrapperElement?.();
        const doc = wrapper?.ownerDocument;
        if (!wrapper || wrapper.isConnected === false || !documentHasFocus(doc)) return false;
        const active = doc.activeElement;
        return !!active && (wrapper === active || wrapper.contains(active) || route.cm.getInputField?.() === active);
      } catch (_) {
        return false;
      }
    }

    function capturePasteRoute(route) {
      if (!isCurrentRoute(route)) return null;
      try {
        if (route.type === "rich") {
          const selection = getWin(route.doc).getSelection?.();
          if (selection?.rangeCount !== 1) return null;
          const range = selection.getRangeAt(0);
          if (!rangeBelongsToRichHost(range, route.doc, route.el)) return null;
          return { route, start: range.startContainer, startOffset: range.startOffset,
            end: range.endContainer, endOffset: range.endOffset };
        }
        const cm = route.cm;
        if (typeof cm.listSelections !== "function") return null;
        const selections = cm.listSelections();
        if (!selections?.length) return null;
        const positions = selections.map(({ anchor, head }) => [anchor.line, anchor.ch, head.line, head.ch]);
        return { route, model: cm.getDoc?.() || cm.doc, positions: JSON.stringify(positions) };
      } catch (_) {
        return null;
      }
    }

    function matchesPasteRoute(snapshot) {
      const current = snapshot && capturePasteRoute(snapshot.route);
      if (!current) return false;
      if (snapshot.route.type === "rich") {
        return current.start === snapshot.start && current.startOffset === snapshot.startOffset &&
          current.end === snapshot.end && current.endOffset === snapshot.endOffset;
      }
      return current.model === snapshot.model && current.positions === snapshot.positions;
    }

    function shouldNeutralizePasteBlocker(e) {
      try {
        if (!isPasteLikeEvent(e) || e.__cxAllowNativePaste) return false;
        if (isExplicitlyNonEditable(e?.target)) return false;

        if (
          state.activePasteSession?.catcher === toElement(e?.target) &&
          Date.now() - state.activePasteSession.startedAt < 2000
        ) {
          return true;
        }

        const targetEl = toElement(e?.target);

        if (isPlainInput(targetEl) && !isPasteCatcherNode(targetEl)) {
          return false;
        }

        const route = routeFromEvent(e);
        if (route?.type === "codemirror" && route.cm.getOption?.("readOnly")) return false;
        return !!route;
      } catch (_) {
        return false;
      }
    }

    function shouldSuppressExternalPasteListener(e, type) {
      try {
        type = lower(type);

        if (!e || e.__cxAllowNativePaste) return false;
        if (isPasteCatcherNode(e?.target)) return false;
        if (isExplicitlyNonEditable(e?.target)) return false;

        if (type === "keydown" && !isPasteKey(e)) return false;

        if (
          type === "beforeinput" &&
          lower(e.inputType) !== "insertfrompaste"
        ) {
          return false;
        }

        if (
          type !== "paste" &&
          type !== "beforeinput" &&
          type !== "keydown"
        ) {
          return false;
        }

        const targetEl = toElement(e?.target);
        if (isPlainInput(targetEl) && !isPasteCatcherNode(targetEl)) {
          return false;
        }

        const route = routeFromEvent(e);
        if (route?.type === "codemirror" && route.cm.getOption?.("readOnly")) return false;
        return !!route;
      } catch (_) {}

      return false;
    }

    function isRecentDuplicate(text) {
      if (!state.lastInsertAt) return false;
      if (Date.now() - state.lastInsertAt > 120) return false;

      const value = String(text ?? "");
      return !value || value === state.lastText;
    }

    function insertByRoute(route, text) {
      if (!route || !text || !isCurrentRoute(route)) return false;

      state.remember(route);

      if (route.type === "codemirror") {
        return insertIntoCodeMirror(route.cm, text);
      }

      if (route.type === "rich") {
        return insertIntoRichEditor(route, text);
      }

      return false;
    }

    function createPasteCatcher(route) {
      try {
        state.activePasteSession?.cleanup?.();
      } catch (_) {}

      saveRichRange(route.doc);

      const savedRangeBeforeCatch = (() => {
        try {
          const saved = state.richRanges.get(route.doc);
          return saved ? saved.cloneRange() : null;
        } catch (_) {
          return null;
        }
      })();

      const catcherDoc = route.doc || document;
      const oldActive = catcherDoc.activeElement;

      const session = {
        route,
        startedAt: Date.now(),
        done: false,
        catcher: null,
        cleanup: null
      };

      const catcher = catcherDoc.createElement("textarea");
      session.catcher = catcher;

      catcher.setAttribute("data-cx-paste-catcher", "1");
      catcher.setAttribute("aria-hidden", "true");
      catcher.setAttribute("autocomplete", "off");
      catcher.setAttribute("autocorrect", "off");
      catcher.setAttribute("autocapitalize", "off");
      catcher.setAttribute("spellcheck", "false");

      Object.assign(catcher.style, {
        position: "fixed",
        left: "-10000px",
        top: "0px",
        width: "1px",
        height: "1px",
        opacity: "0",
        pointerEvents: "none",
        zIndex: "2147483647"
      });

      const restoreSavedRange = () => {
        try {
          if (
            savedRangeBeforeCatch &&
            rangeBelongsToRichHost(savedRangeBeforeCatch, route.doc, getDefaultRichHost(route.doc, route.el))
          ) {
            const range = savedRangeBeforeCatch.cloneRange();
            state.richRanges.set(route.doc, range);
            const selection = getWin(route.doc).getSelection?.();
            selection?.removeAllRanges();
            selection?.addRange(range);
          }
        } catch (_) {}
      };

      const cleanup = () => {
        const restoreFocus = catcherDoc.activeElement === catcher && documentHasFocus(catcherDoc);
        try {
          catcher.removeEventListener("paste", onCatcherPaste, true);
        } catch (_) {}

        try {
          catcher.removeEventListener("input", onCatcherInput, true);
        } catch (_) {}

        try {
          catcher.remove();
        } catch (_) {}

        if (state.activePasteSession === session) {
          state.activePasteSession = null;
        }

        if (!restoreFocus) return false;
        restoreSavedRange();

        try {
          oldActive?.focus?.({ preventScroll: true });
        } catch (_) {}

        focusRichDoc(route.doc, route.el);
        ensureRichRange(route.doc, route.el);
        return true;
      };

      const finish = text => {
        if (session.done) return;

        text = String(text ?? "");
        if (!text) return;

        session.done = true;
        if (!cleanup()) return;

        if (!isRecentDuplicate(text)) {
          insertByRoute(route, text);
        }
      };

      function onCatcherPaste(e) {
        const text = getClipboardTextFromEvent(e);

        if (text) {
          hardCancel(e);
          finish(text);
        } else {
          // Let the browser fill the catcher when clipboardData is unavailable.
          stopOnly(e);
        }
      }

      function onCatcherInput() {
        const text = catcher.value || catcher.textContent || "";

        if (text) {
          finish(text);
        }
      }

      session.cleanup = cleanup;
      state.activePasteSession = session;

      catcher.addEventListener("paste", onCatcherPaste, true);
      catcher.addEventListener("input", onCatcherInput, true);

      try {
        (catcherDoc.body || catcherDoc.documentElement).appendChild(catcher);
        catcher.focus({ preventScroll: true });
        catcher.select();
      } catch (_) {}

      state.addTimer(
        setTimeout(() => {
          if (session.done) return;
          const text = catcher.value || catcher.textContent || "";

          if (text) {
            finish(text);
          } else {
            session.done = true;
            cleanup();
          }
        }, 120)
      );

      return session;
    }

    function handlePasteEvent(e) {
      if (e.__cxPasteHandled) return;
      if (isPasteCatcherNode(e?.target)) return;

      const route = routeFromEvent(e);
      if (!route) return;

      e.__cxPasteHandled = true;

      const text = getClipboardTextFromEvent(e);

      if (!text) {
        e.__cxAllowNativePaste = true;
        return;
      }
      state.remember(route);
      if (insertByRoute(route, text)) hardCancel(e);
      else e.__cxAllowNativePaste = true;
    }

    function handleBeforeInputEvent(e) {
      if (e.__cxBeforeInputHandled) return;
      if (lower(e.inputType) !== "insertfrompaste") return;
      if (isPasteCatcherNode(e?.target)) return;

      const route = routeFromEvent(e);
      if (!route) return;

      e.__cxBeforeInputHandled = true;

      const text =
        e.dataTransfer?.getData("text/plain") ||
        e.dataTransfer?.getData("text") ||
        e.data ||
        "";

      if (!text) {
        e.__cxAllowNativePaste = true;
        return;
      }
      state.remember(route);
      if (insertByRoute(route, text)) hardCancel(e);
      else e.__cxAllowNativePaste = true;
    }

    function handleKeyDownEvent(e) {
      if (e.__cxKeydownHandled) return;
      if (!isPasteKey(e)) return;
      if (isPasteCatcherNode(e?.target)) return;

      const route = routeFromEvent(e);
      if (!route) return;

      e.__cxKeydownHandled = true;

      state.remember(route);

      // Keep the real editor focused. A hidden catcher cannot return a failed
      // insertion to the browser's native paste path, so ordinary paste events
      // are the only automatic insertion path (no delayed clipboard reads).
    }

    function handleSelectionChange(e) {
      const doc = getDoc(e?.target) || getDoc(e?.currentTarget);

      if (!doc || !state.richDocs.has(doc)) return;

      if (state.activePasteSession?.route?.doc === doc) {
        return;
      }

      saveRichRange(doc);
    }

    function handleRichActivity(e) {
      const route = richRouteFromEvent(e);
      if (!route) return;
      state.remember(route);
      saveRichRange(route.doc);
    }

    function scanFramesInside(root) {
      try {
        if (!root) return;

        if (root.nodeType === 1) {
          const tag = lower(root.tagName);
          if (tag === "iframe" || tag === "frame") {
            patchFrame(root);
          }
        }

        if (root.querySelectorAll) {
          root.querySelectorAll("iframe,frame").forEach(frame => patchFrame(frame));
        }
      } catch (_) {}
    }

    function afterDOMMutation(root) {
      try {
        scanFramesInside(root);
      } catch (_) {}

      try {
        scheduleInstall(0);
      } catch (_) {}

      state.addTimer(
        setTimeout(() => {
          try {
            scanFramesInside(root);
          } catch (_) {}
          scheduleInstall(0);
        }, 0)
      );
    }

    function patchDOMMutationMethods(win) {
      if (!win || state.patchedDOMWindows.has(win)) return;

      state.patchedDOMWindows.add(win);

      function patchMethod(proto, name, makeWrapped) {
        if (!proto) return;

        try {
          const native = proto[name];
          if (typeof native !== "function") return;
          if (native.__ystPasteUnlockWrapped) return;

          const wrapped = makeWrapped(native);

          try {
            Object.defineProperty(wrapped, "__ystPasteUnlockWrapped", {
              value: true,
              configurable: true
            });
          } catch (_) {}

          proto[name] = wrapped;

          state.domRecords.push({
            kind: "method",
            proto,
            name,
            native,
            wrapped
          });
        } catch (_) {}
      }

      patchMethod(win.Node?.prototype, "appendChild", native => function (node) {
        const ret = native.call(this, node);
        afterDOMMutation(node);
        return ret;
      });

      patchMethod(win.Node?.prototype, "insertBefore", native => function (node, ref) {
        const ret = native.call(this, node, ref);
        afterDOMMutation(node);
        return ret;
      });

      patchMethod(win.Node?.prototype, "replaceChild", native => function (node, oldNode) {
        const ret = native.call(this, node, oldNode);
        afterDOMMutation(node);
        return ret;
      });

      patchMethod(win.Element?.prototype, "insertAdjacentHTML", native => function (position, html) {
        const ret = native.call(this, position, html);
        afterDOMMutation(this);
        return ret;
      });

      patchMethod(win.Document?.prototype, "write", native => function (...args) {
        const ret = native.apply(this, args);
        afterDOMMutation(this);
        return ret;
      });

      patchMethod(win.Document?.prototype, "writeln", native => function (...args) {
        const ret = native.apply(this, args);
        afterDOMMutation(this);
        return ret;
      });

      patchMethod(win.Document?.prototype, "close", native => function (...args) {
        const ret = native.apply(this, args);
        afterDOMMutation(this);
        return ret;
      });

      try {
        let proto = win.Element?.prototype;
        let holder = null;
        let desc = null;

        while (proto && !desc) {
          desc = Object.getOwnPropertyDescriptor(proto, "innerHTML");
          if (desc) holder = proto;
          proto = Object.getPrototypeOf(proto);
        }

        if (holder && desc?.get && desc?.set && !desc.set.__ystPasteUnlockWrapped) {
          const nativeDescriptor = desc;
          const wrappedGet = function () {
            return nativeDescriptor.get.call(this);
          };
          const wrappedSet = function (value) {
            const ret = nativeDescriptor.set.call(this, value);
            afterDOMMutation(this);
            return ret;
          };

          try {
            Object.defineProperty(wrappedSet, "__ystPasteUnlockWrapped", {
              value: true,
              configurable: true
            });
          } catch (_) {}

          const descriptor = {
            get: wrappedGet,
            set: wrappedSet,
            configurable: nativeDescriptor.configurable,
            enumerable: nativeDescriptor.enumerable
          };

          Object.defineProperty(holder, "innerHTML", descriptor);

          state.domRecords.push({
            kind: "accessor",
            proto: holder,
            name: "innerHTML",
            nativeDescriptor,
            descriptor
          });
        }
      } catch (_) {}
    }

    function patchDocument(doc) {
      if (!doc) return;
      if (ownedByOther(doc, DOC_MARK)) return;
      if (state.patchedDocs.has(doc)) return;

      markObject(doc, DOC_MARK);
      state.patchedDocs.add(doc);

      const win = getWin(doc);

      if (ownedByOther(win, WIN_MARK)) return;
      markObject(win, WIN_MARK);

      patchEventTargetPrototype(win);
      patchEventPrototype(win);
      patchDOMMutationMethods(win);

      state.on(win, "paste", handlePasteEvent, true);
      state.on(doc, "paste", handlePasteEvent, true);

      state.on(win, "beforeinput", handleBeforeInputEvent, true);
      state.on(doc, "beforeinput", handleBeforeInputEvent, true);

      state.on(win, "keydown", handleKeyDownEvent, true);
      state.on(doc, "keydown", handleKeyDownEvent, true);

      state.on(doc, "selectionchange", handleSelectionChange, true);

      try {
        const root = doc.documentElement || doc.body;

        if (root) {
          state.observe(
            root,
            {
              childList: true,
              subtree: true
            },
            mutations => {
              for (const mutation of mutations) {
                for (const node of mutation.addedNodes || []) {
                  scanFramesInside(node);
                }
              }
              scheduleInstall(20);
            }
          );
        }
      } catch (_) {}
    }

    function patchCodeMirror(cm) {
      if (!cm || state.patchedCodeMirrors.has(cm)) return;

      const wrapper = cm.getWrapperElement?.();
      if (!wrapper) return;

      state.patchedCodeMirrors.add(cm);
      state.codeMirrors.add(cm);

      const remember = () => {
        state.remember({
          type: "codemirror",
          cm
        });
      };

      for (const node of [
        wrapper,
        cm.getInputField?.(),
        cm.getTextArea?.(),
        cm.getScrollerElement?.()
      ].filter(Boolean)) {
        state.on(node, "focus", remember, true);
        state.on(node, "mousedown", remember, true);
        state.on(node, "mouseup", remember, true);
        state.on(node, "click", remember, true);
        state.on(node, "keydown", remember, true);
      }

      try {
        cm.on?.("focus", remember);
      } catch (_) {}

      try {
        cm.on?.("cursorActivity", remember);
      } catch (_) {}

      try {
        cm.__forcePasteText = text => {
          remember();
          return insertByRoute({ type: "codemirror", cm }, String(text ?? ""));
        };
      } catch (_) {}
    }

    function patchRichDoc(doc, force = false) {
      if (!doc?.body) return;
      if (!force && !looksLikeRichDoc(doc)) return;
      if (ownedByOther(doc, DOC_MARK)) return;

      patchDocument(doc);

      state.richDocs.add(doc);

      if (state.patchedRichDocs.has(doc)) return;

      state.patchedRichDocs.add(doc);

      const win = getWin(doc);

      patchEventTargetPrototype(win);
      patchEventPrototype(win);
      patchDOMMutationMethods(win);

      for (const target of [
        win,
        doc,
        doc.documentElement,
        doc.body
      ].filter(Boolean)) {
        state.on(target, "focus", handleRichActivity, true);
        state.on(target, "focusin", handleRichActivity, true);
        state.on(target, "mousedown", handleRichActivity, true);
        state.on(target, "mouseup", handleRichActivity, true);
        state.on(target, "click", handleRichActivity, true);
        state.on(target, "keydown", handleRichActivity, true);
        state.on(target, "keyup", handleRichActivity, true);
        state.on(target, "selectionchange", handleSelectionChange, true);
      }

      const frame = getFrameElement(win);

      if (frame) {
        state.on(frame, "focus", handleRichActivity, true);
        state.on(frame, "mousedown", handleRichActivity, true);
        state.on(frame, "mouseup", handleRichActivity, true);
        state.on(frame, "click", handleRichActivity, true);
      }

      try {
        doc.__forcePasteText = text => {
          const route = {
            type: "rich",
            doc,
            el: getDefaultRichHost(doc, doc.activeElement)
          };

          state.remember(route);
          return insertIntoRichEditor(route, String(text ?? ""));
        };
      } catch (_) {}
    }

    function patchFrame(frame) {
      if (!frame || state.patchedFrames.has(frame)) return;

      state.patchedFrames.add(frame);

      const schedule = () => {
        try {
          if (frame.contentWindow?.document) {
            patchWindow(frame.contentWindow);
          }
        } catch (_) {}

        scheduleInstall(0);
      };

      state.on(frame, "load", schedule, true);
      state.on(frame, "focus", schedule, true);
      state.on(frame, "mousedown", schedule, true);
      state.on(frame, "click", schedule, true);

      try {
        if (frame.contentWindow?.document) {
          patchWindow(frame.contentWindow);
        }
      } catch (_) {}

      state.addTimer(setTimeout(schedule, 0));
      state.addTimer(setTimeout(schedule, 50));
      state.addTimer(setTimeout(schedule, 250));
    }

    function patchWindow(win) {
      if (!win) return;
      if (ownedByOther(win, WIN_MARK)) return;

      try {
        markObject(win, WIN_MARK);

        const doc = win.document;
        if (!doc) return;

        patchEventTargetPrototype(win);
        patchEventPrototype(win);
        patchDOMMutationMethods(win);
        patchDocument(doc);

        try {
          doc.querySelectorAll(".CodeMirror").forEach(wrapper => {
            if (wrapper.CodeMirror) {
              patchCodeMirror(wrapper.CodeMirror);
            }
          });
        } catch (_) {}

        try {
          doc
            .querySelectorAll(
              [
                '[contenteditable="true"]',
                '[contenteditable="plaintext-only"]',
                '[role="textbox"]',
                ".edui-body-container",
                ".cke_editable",
                ".ql-editor",
                ".w-e-text"
              ].join(",")
            )
            .forEach(el => {
              patchRichDoc(el.ownerDocument, true);
            });
        } catch (_) {}

        if (looksLikeRichDoc(doc)) {
          patchRichDoc(doc, true);
        }

        try {
          doc.querySelectorAll("iframe,frame").forEach(frame => {
            patchFrame(frame);

            try {
              if (frame.contentWindow?.document) {
                patchWindow(frame.contentWindow);
              }
            } catch (_) {}
          });
        } catch (_) {}
      } catch (_) {}
    }

    function walk(win, seen = new Set()) {
      if (!win || seen.has(win)) return;
      if (ownedByOther(win, WIN_MARK)) return;

      seen.add(win);
      patchWindow(win);

      try {
        win.document?.querySelectorAll("iframe,frame").forEach(frame => {
          patchFrame(frame);

          try {
            if (
              frame.contentWindow &&
              !ownedByOther(frame.contentWindow, WIN_MARK)
            ) {
              walk(frame.contentWindow, seen);
            }
          } catch (_) {}
        });
      } catch (_) {}
    }

    function install() {
      if (state.installing) return;

      state.installing = true;

      try {
        walk(window);
      } finally {
        state.installing = false;
      }
    }

    function scheduleInstall(delay = 60) {
      if (state.scheduled) return;

      state.scheduled = true;

      state.addTimer(
        setTimeout(() => {
          state.scheduled = false;
          install();
        }, delay)
      );
    }

    install();
    scheduleInstall(0);
    scheduleInstall(30);
    scheduleInstall(100);
    scheduleInstall(300);
    scheduleInstall(1000);

    try {
      document.addEventListener(
        "DOMContentLoaded",
        () => scheduleInstall(0),
        {
          once: true,
          capture: true
        }
      );

      window.addEventListener(
        "load",
        () => scheduleInstall(0),
        {
          once: true,
          capture: true
        }
      );
    } catch (_) {}

    const fastTimer = setInterval(install, 300);
    state.addTimer(fastTimer);

    state.addTimer(
      setTimeout(() => {
        try {
          clearInterval(fastTimer);
        } catch (_) {}

        state.addTimer(setInterval(install, 2000));
      }, 20000)
    );

    window.__pastePatchInstall = install;

    window.__pastePatchCleanup = () => {
      state.cleanup();
    };

    window.__pastePatchStatus = () => ({
      version: "3.1.0",
      codeMirrorCount: state.codeMirrors.size,
      richEditorCount: state.richDocs.size,
      lastTarget: state.lastTarget,
      lastTargetAt: state.lastTargetAt,
      activePasteSession: !!state.activePasteSession,
      codeMirrors: [...state.codeMirrors],
      richEditors: [...state.richDocs]
    });

    window.__pasteText = text => {
      text = String(text ?? "");

      if (!text) return false;

      const route = activeRoute();

      return route ? insertByRoute(route, text) : false;
    };

    window.__pasteFromClipboard = async () => {
      const route = activeRoute();
      const snapshot = capturePasteRoute(route);
      if (!snapshot) return false;
      const win = route.type === "rich" ? getWin(route.doc) : window;
      const text = await readClipboardText(win);
      return text && matchesPasteRoute(snapshot) ? insertByRoute(route, text) : false;
    };

    window.__pasteToCodeMirror = (text, index = 0) => {
      const cm = [...state.codeMirrors][index];

      if (!cm) return false;

      return insertByRoute({ type: "codemirror", cm }, String(text ?? ""));
    };

    window.__pasteToRichEditor = (text, index = 0) => {
      const doc = [...state.richDocs][index];

      if (!doc) return false;

      const route = {
        type: "rich",
        doc,
        el: getDefaultRichHost(doc, doc.activeElement)
      };

      return insertIntoRichEditor(route, String(text ?? ""));
    };
  }

  if (IS_EDUCODER) {
    installEducoderUnlock();
  }

  if (IS_CHAOXING_FAMILY) {
    installChaoxingPasteEnhancer();
  }
})();

