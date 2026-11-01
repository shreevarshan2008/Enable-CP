// Enable CP v1.3 - runs in the page's own JS world (MAIN) at document_start, in every frame.
//
// Approach: "detect the block, then do it ourselves".
//  - Copy/Cut : if the site cancels the event without putting the right text on the
//               clipboard, we read the selection ourselves and write it to the clipboard.
//  - Paste    : if the site cancels the paste (or nothing changed), we insert the text
//               ourselves (editor API -> execCommand -> value setter -> synthetic paste).
//  - Shortcuts: a site can no longer cancel Ctrl+C/X/V/A, F12, Ctrl+U, etc.
//  - Own clipboard: whatever you copy is remembered, and used if the system clipboard
//               can't be read.
(() => {
  const isOn = () => {
    const r = document.documentElement;
    return !r || r.getAttribute('data-ecp') !== 'off';
  };
  const log = (...a) => { try { console.info('[Enable CP]', ...a); } catch (_) {} };
  let toastEl = null;
  const say = (msg) => {            // small blue message at the bottom-left of the page
    log(msg);
    try {
      const r = document.documentElement;
      if (!r || r.getAttribute('data-ecp-toast') === 'off') return;
      if (toastEl) toastEl.remove();
      const d = document.createElement('div');
      d.textContent = 'Enable CP: ' + msg;
      d.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:8px 12px;' +
        'background:#1d4ed8;color:#fff;font:13px system-ui,sans-serif;border-radius:8px;' +
        'box-shadow:0 2px 8px rgba(0,0,0,.4);pointer-events:none;max-width:80vw;';
      (document.body || r).appendChild(d);
      toastEl = d;
      setTimeout(() => { if (toastEl === d) { d.remove(); toastEl = null; } }, 2500);
    } catch (_) {}
  };

  let lastInfo = '';
  let buffer = '';               // Enable CP's own clipboard
  let sawCopy = false, sawPaste = false, internalCopy = false;
  const synthetic = new WeakSet();   // paste events we created ourselves
  const written = new WeakMap();     // DataTransfer -> text/plain the site wrote
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

  const EDITOR_SEL = '.monaco-editor,.ace_editor,.CodeMirror,.cm-editor';
  const INTERACTIVE_SEL = 'a,button,input,textarea,select,label,summary,[contenteditable],[draggable="true"],' +
    '[role="button"],[role="menuitem"],[role="tab"],[role="option"],[role="slider"],' + EDITOR_SEL;

  const closest = (el, sel) => (el && el.closest ? el.closest(sel) : null);
  const inKnownEditor = (el) => !!closest(el, EDITOR_SEL);

  const deepActive = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };

  // ---------- Editor adapters ----------
  function findMonaco(el) {
    try {
      const mon = window.monaco;
      if (!mon || !mon.editor || typeof mon.editor.getEditors !== 'function') return null;
      const eds = mon.editor.getEditors();
      if (!eds || !eds.length) return null;
      let ed = eds.find((x) => { try { return x.hasTextFocus(); } catch (_) { return false; } });
      if (!ed) {
        const root = closest(el, '.monaco-editor');
        if (root) ed = eds.find((x) => { try { return x.getDomNode() === root; } catch (_) { return false; } });
      }
      return ed || null;
    } catch (_) { return null; }
  }
  const findAce = (el) => { try { const r = closest(el, '.ace_editor'); return (r && r.env && r.env.editor) || null; } catch (_) { return null; } };
  const findCM5 = (el) => { try { const r = closest(el, '.CodeMirror'); return (r && r.CodeMirror) || null; } catch (_) { return null; } };

  // CodeMirror 6 (the editor CodeTantra uses): reach its EditorView through the DOM
  const findCM6 = (el) => {
    try {
      const root = closest(el, '.cm-editor');
      if (!root) return null;
      const content = root.querySelector('.cm-content');
      const cv = content && content.cmView;
      const v = cv && (cv.view || (cv.rootView && cv.rootView.view));
      return v && typeof v.dispatch === 'function' && v.state ? v : null;
    } catch (_) { return null; }
  };

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (inKnownEditor(el)) return true;
    if (el.tagName === 'TEXTAREA') return !el.readOnly && !el.disabled;
    if (el.tagName === 'INPUT') {
      const ty = (el.type || 'text').toLowerCase();
      return ['text', 'search', 'url', 'tel', 'email', 'password'].includes(ty) && !el.readOnly && !el.disabled;
    }
    return !!el.isContentEditable;
  }

  // ---------- Read the current selection ----------
  function getSelectedText() {
    const el = deepActive();
    try {
      const mon = findMonaco(el);
      if (mon) {
        const model = mon.getModel();
        const t = (mon.getSelections() || []).map((s) => model.getValueInRange(s)).join('\n');
        if (t) return t;
      }
      const ace = findAce(el);
      if (ace) { const t = ace.getSelectedText(); if (t) return t; }
      const cm = findCM5(el);
      if (cm) { const t = cm.getSelection(); if (t) return t; }
      const cm6 = findCM6(el);
      if (cm6) {
        const st = cm6.state;
        const t = st.selection.ranges.map((r) => st.sliceDoc(r.from, r.to)).filter(Boolean).join('\n');
        if (t) return t;
      }
      if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'password'))) {
        const s = el.selectionStart, e = el.selectionEnd;
        if (typeof s === 'number' && e > s) return el.value.slice(s, e);
      }
    } catch (_) {}
    const sel = window.getSelection();
    return sel ? sel.toString() : '';
  }

  // Something that changes whenever the editor's content changes
  function snapshot(el) {
    try {
      const mon = findMonaco(el);
      if (mon && mon.getModel()) return 'm' + mon.getModel().getVersionId();
      const ace = findAce(el);
      if (ace) return 'a' + ace.getValue();
      const cm = findCM5(el);
      if (cm) return 'c' + cm.getValue();
      const cm6 = findCM6(el);
      if (cm6) return 'z' + cm6.state.doc.toString();
      const root = closest(el, EDITOR_SEL);
      if (root) return 'd' + root.textContent;
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return 'v' + el.value;
      if (el && el.isContentEditable) return 't' + el.textContent;
    } catch (_) {}
    return '';
  }

  // ---------- Write the clipboard ----------
  async function writeClipboard(text) {
    try { await navigator.clipboard.writeText(text); log('copied via Clipboard API'); return true; } catch (_) {}
    const prev = deepActive();
    const ws = window.getSelection();
    const ranges = [];
    for (let i = 0; ws && i < ws.rangeCount; i++) ranges.push(ws.getRangeAt(i));
    let ps, pe;
    try { ps = prev.selectionStart; pe = prev.selectionEnd; } catch (_) {}
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
    (document.body || document.documentElement).appendChild(ta);
    ta.select();
    let ok = false;
    internalCopy = true;
    try { ok = document.execCommand('copy'); } catch (_) {}
    internalCopy = false;
    ta.remove();
    try { if (prev && prev.focus) prev.focus({ preventScroll: true }); } catch (_) {}
    try { if (typeof ps === 'number') prev.setSelectionRange(ps, pe); } catch (_) {}
    try { if (ws) { ws.removeAllRanges(); ranges.forEach((r) => ws.addRange(r)); } } catch (_) {}
    if (ok) log('copied via execCommand');
    return ok;
  }

  // ---------- Insert text ----------
  const viaApi = (el, text) => {
    const mon = findMonaco(el);
    if (mon) {
      const sels = mon.getSelections() || [];
      mon.pushUndoStop();
      mon.executeEdits('enable-cp', sels.map((r) => ({ range: r, text, forceMoveMarkers: true })));
      mon.pushUndoStop();
      return 'monaco';
    }
    const ace = findAce(el);
    if (ace) { ace.insert(text, true); return 'ace'; }
    const cm = findCM5(el);
    if (cm) { cm.replaceSelection(text, 'end'); return 'codemirror5'; }
    const cm6 = findCM6(el);
    if (cm6) {
      const before = cm6.state.doc;
      cm6.dispatch(Object.assign({}, cm6.state.replaceSelection(text), { scrollIntoView: true }));
      if (!text || !cm6.state.doc.eq(before)) return 'codemirror6';
    }
    return null;
  };
  const viaExec = (el, text) => {
    if (!isEditable(el)) return null;
    if (el.focus) el.focus({ preventScroll: true });
    return document.execCommand(text ? 'insertText' : 'delete', false, text);
  };
  const viaValue = (el, text) => {
    if (!el || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')) return null;
    const s = el.selectionStart, e = el.selectionEnd;
    if (typeof s !== 'number') return null;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, el.value.slice(0, s) + text + el.value.slice(e));
    el.setSelectionRange(s + text.length, s + text.length);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
    return true;
  };
  const viaSynthetic = (el, text) => {
    if (!el) return null;
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
    synthetic.add(ev);
    el.dispatchEvent(ev);
    return true;
  };

  async function insertWithVerify(el, text) {
    const apiResult = (() => { try { return viaApi(el, text); } catch (_) { return null; } })();
    if (apiResult) { log('inserted via', apiResult, 'API'); return true; }
    const methods = [['execCommand', viaExec], ['value', viaValue], ['synthetic paste', viaSynthetic]];
    for (const [name, fn] of methods) {
      const before = snapshot(el);
      let r = null;
      try { r = fn(el, text); } catch (_) { r = null; }
      if (r === null) continue;
      await sleep(120);
      if (snapshot(el) !== before) { log('inserted via', name); return true; }
    }
    const cv = (() => { try { const c = closest(el, '.cm-editor'); return c && c.querySelector('.cm-content'); } catch (_) { return null; } })();
    lastInfo = 'target=' + (el ? el.tagName + '.' + String(el.className).slice(0, 30) : 'none') +
               ', cm6 handle=' + (findCM6(el) ? 'yes' : 'no') + ', cmView=' + (cv && cv.cmView ? 'yes' : 'no');
    log('could not insert text (' + lastInfo + ')');
    return false;
  }

  // ---------- Copy / Cut ----------
  function onCopyCut(e) {
    if (!isOn()) return;
    if (internalCopy) { e.stopImmediatePropagation(); return; }   // our own temp copy: hide from site
    sawCopy = true;
    const el = deepActive();
    const sel = getSelectedText();
    const dt = e.clipboardData;
    if (sel) buffer = sel;
    setTimeout(async () => {
      const w = dt ? written.get(dt) : undefined;
      if (!sel && w) buffer = w;
      if (!sel) { if (!w) say(e.type + ': could not find any selected text'); return; }
      const blocked = e.defaultPrevented && (w === undefined || norm(w) !== norm(sel));
      if (!blocked) { say(e.type + ' OK (' + sel.length + ' characters)'); return; }
      const ok = await writeClipboard(sel);
      say(ok ? e.type + ' was blocked - copied ' + sel.length + ' characters anyway'
             : e.type + ' was blocked and the clipboard could not be written');
      if (ok && e.type === 'cut' && isEditable(el)) {
        try { viaApi(el, '') || viaExec(el, ''); } catch (_) {}
      }
    }, 0);
  }
  window.addEventListener('copy', onCopyCut, true);
  window.addEventListener('cut', onCopyCut, true);

  // Remember what the site writes to the clipboard on copy
  const origSetData = DataTransfer.prototype.setData;
  DataTransfer.prototype.setData = function (type) {
    try { if (/^(text\/plain|text)$/i.test(String(type))) written.set(this, String(arguments[1])); } catch (_) {}
    return origSetData.apply(this, arguments);
  };

  // ---------- Paste ----------
  window.addEventListener('paste', (e) => {
    if (!isOn() || synthetic.has(e)) return;
    sawPaste = true;
    const cd = e.clipboardData;
    if (cd && cd.files && cd.files.length) return;               // images/files: leave alone
    let text = '';
    try { text = cd ? cd.getData('text/plain') : ''; } catch (_) {}
    if (!text) text = buffer;                                     // fall back to Enable CP's own clipboard
    const el = deepActive();
    if (!text) { say('paste: clipboard is empty'); return; }
    if (!isEditable(el)) return;
    const before = snapshot(el);
    setTimeout(async () => {
      if (!isOn()) return;
      if (snapshot(el) !== before) return;                        // paste worked normally
      const ok = await insertWithVerify(el, text);
      say(ok ? 'paste was blocked - inserted ' + text.length + ' characters'
             : 'paste was blocked and I could not insert the text [' + lastInfo + ']');
    }, 200);
  }, true);

  // ---------- Keyboard: unblock shortcuts + fallbacks if no clipboard event arrives ----------
  const isClipboardKey = (e) => {
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    return (mod && ['c', 'x', 'v', 'a', 'insert'].includes(k)) || (e.shiftKey && ['insert', 'delete'].includes(k));
  };
  const isUnlockKey = (e) => {
    if (typeof e.key !== 'string') return false;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    return isClipboardKey(e) || k === 'f12' || (mod && e.shiftKey && ['i', 'j', 'c'].includes(k)) || (mod && k === 'u');
  };

  window.addEventListener('keydown', (e) => {
    if (!isOn() || !e.isTrusted || typeof e.key !== 'string') return;
    const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    const isCopy = (mod && k === 'c') || (mod && k === 'insert');
    const isCut = (mod && k === 'x') || (e.shiftKey && k === 'delete');
    const isPaste = (mod && k === 'v') || (e.shiftKey && k === 'insert');
    const el = deepActive();

    if (isCopy || isCut) {
      const sel = getSelectedText();
      if (!sel) return;
      buffer = sel;
      sawCopy = false;
      setTimeout(async () => {
        if (sawCopy) return;                                      // normal copy event happened
        const ok = await writeClipboard(sel);
        say(ok ? 'site swallowed Ctrl+C - copied ' + sel.length + ' characters anyway' : 'Ctrl+C was swallowed and the clipboard could not be written');
        if (ok && isCut && isEditable(el)) { try { viaApi(el, '') || viaExec(el, ''); } catch (_) {} }
      }, 200);
    }
    if (isPaste) {
      sawPaste = false;
      setTimeout(async () => {
        if (sawPaste) return;                                     // normal paste event happened
        const target = deepActive();
        if (!isEditable(target)) return;
        let text = '';
        try { text = await navigator.clipboard.readText(); } catch (_) {}
        if (!text) text = buffer;
        if (!text) return;
        const ok = await insertWithVerify(target, text);
        say(ok ? 'site swallowed Ctrl+V - inserted ' + text.length + ' characters anyway' : 'Ctrl+V was swallowed and I could not insert the text');
      }, 200);
    }
  }, true);

  // ---------- Neutralise site attempts to cancel shortcuts / selection ----------
  const shouldProtect = (e) => {
    if (!e || !isOn()) return false;
    const t = e.type;
    if (t === 'keydown' || t === 'keyup' || t === 'keypress') {
      return typeof e.key === 'string' && isUnlockKey(e) && !inKnownEditor(e.target);
    }
    if (t === 'mousedown') {
      return e.button === 0 && e.target && e.target.closest && !e.target.closest(INTERACTIVE_SEL);
    }
    return false;
  };
  const origPD = Event.prototype.preventDefault;
  Event.prototype.preventDefault = function preventDefault() {
    if (shouldProtect(this)) return;
    return origPD.apply(this, arguments);
  };
  try {
    const rv = Object.getOwnPropertyDescriptor(Event.prototype, 'returnValue');
    if (rv && rv.set) {
      Object.defineProperty(Event.prototype, 'returnValue', {
        configurable: true, enumerable: rv.enumerable, get: rv.get,
        set(v) { if (v === false && shouldProtect(this)) return; rv.set.call(this, v); }
      });
    }
  } catch (_) {}

  // Right-click, selection start and drag (non-draggable items) are hidden from the site
  ['contextmenu', 'selectstart', 'dragstart'].forEach((type) => {
    window.addEventListener(type, (e) => {
      if (!isOn()) return;
      if (type === 'dragstart' && closest(e.target, '[draggable="true"]')) return;
      e.stopImmediatePropagation();
    }, true);
  });

  // ---------- Text selection inside Shadow DOM ----------
  const sheets = new Set();
  const origAttach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function () {
    const sr = origAttach.apply(this, arguments);
    try {
      const s = new CSSStyleSheet();
      s.replaceSync('*,*::before,*::after{-webkit-user-select:text!important;user-select:text!important}');
      s.disabled = !isOn();
      sr.adoptedStyleSheets = [...sr.adoptedStyleSheets, s];
      sheets.add(s);
    } catch (_) {}
    return sr;
  };
  const obs = new MutationObserver(() => { const on = isOn(); sheets.forEach((s) => { s.disabled = !on; }); });
  const watch = () => {
    if (document.documentElement) obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ecp'] });
    else setTimeout(watch, 10);
  };
  watch();
})();
