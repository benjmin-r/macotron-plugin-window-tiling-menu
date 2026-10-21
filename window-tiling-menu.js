// @macotron needs 1.5
// APIs: keyboard.on, fs, window.focused, window.moveToFraction, display.list, panel, command, checks
const opts = macotron.plugin({
  title: "Window Tiling Menu",
  description: "Moom-style tiling: press one shortcut, then a single key to place the focused window.",
  help: "Activate, then press the key shown next to an action. Esc or clicking away cancels. Record the activation shortcut for \"Tile Window\" on this page. Name actions, pick their keys and draw their grid placement with \"Configure Tiling Actions\" in the launcher, or Edit in the overlay.",
  permissions: ["accessibility"],
  options: {
    gap: {
      type: "number",
      label: "Gap (px)",
      default: 0,
      min: 0,
      max: 40,
      help: "Padding between a tiled window and the screen edge or its neighbor.",
    },
    actionsFile: {
      type: "string",
      label: "Actions file",
      placeholder: "Empty keeps them in Macotron's local storage",
      help: "A JSON file to keep the actions in, such as ~/.config/macotron/tiling-actions.json, so they can live in a git repo. The file is created on the first save. Actions already in local storage are moved into it.",
    },
  },
});

const OVERLAY_ID = "window-tiling-menu";
const EDITOR_ID = "window-tiling-menu-editor";
const STORE_KEY = "window-tiling-menu.actions";
// Where the actions are kept: the file from the options, or localStorage when it is empty.
const ACTIONS_FILE = String(opts.actionsFile || "").trim();
const NAMED_KEYS = ["left", "right", "up", "down", "space", "return", "tab"];
const MAX_GRID = 20;

// Special actions. A frame is a fraction of the screen, x and y being the top-left
// corner; the display ones move the window full screen to a neighboring display.
const SPECIALS = {
  "left-half": { label: "Left Half", frame: { x: 0, y: 0, w: 0.5, h: 1 } },
  "right-half": { label: "Right Half", frame: { x: 0.5, y: 0, w: 0.5, h: 1 } },
  "top-half": { label: "Top Half", frame: { x: 0, y: 0, w: 1, h: 0.5 } },
  "bottom-half": { label: "Bottom Half", frame: { x: 0, y: 0.5, w: 1, h: 0.5 } },
  "top-left": { label: "Top Left", frame: { x: 0, y: 0, w: 0.5, h: 0.5 } },
  "top-right": { label: "Top Right", frame: { x: 0.5, y: 0, w: 0.5, h: 0.5 } },
  "bottom-left": { label: "Bottom Left", frame: { x: 0, y: 0.5, w: 0.5, h: 0.5 } },
  "bottom-right": { label: "Bottom Right", frame: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
  "full-screen": { label: "Full Screen", frame: { x: 0, y: 0, w: 1, h: 1 } },
  "center": { label: "Center", frame: { x: 0.125, y: 0.125, w: 0.75, h: 0.75 } },
  "first-third": { label: "First Third", frame: { x: 0, y: 0, w: 1 / 3, h: 1 } },
  "center-third": { label: "Center Third", frame: { x: 1 / 3, y: 0, w: 1 / 3, h: 1 } },
  "last-third": { label: "Last Third", frame: { x: 2 / 3, y: 0, w: 1 / 3, h: 1 } },
  "first-two-thirds": { label: "First Two Thirds", frame: { x: 0, y: 0, w: 2 / 3, h: 1 } },
  "last-two-thirds": { label: "Last Two Thirds", frame: { x: 1 / 3, y: 0, w: 2 / 3, h: 1 } },
  "next-display": { label: "Next Display", display: 1 },
  "prev-display": { label: "Previous Display", display: -1 },
};

const special = (key, id) => ({ key, name: SPECIALS[id].label, special: id });
const DEFAULT_ACTIONS = [
  special("h", "left-half"),
  special("l", "right-half"),
  special("k", "top-half"),
  special("j", "bottom-half"),
  special("y", "top-left"),
  special("u", "top-right"),
  special("b", "bottom-left"),
  special("n", "bottom-right"),
  special("f", "full-screen"),
  special("c", "center"),
  special("1", "first-third"),
  special("2", "center-third"),
  special("3", "last-third"),
  special("4", "first-two-thirds"),
  special("5", "last-two-thirds"),
  special("]", "next-display"),
  special("[", "prev-display"),
];

// The next three are source text, not functions, because the panels need their
// source. Macotron may load a plugin from a bytecode cache that keeps no function
// source (at launch, and after a reload that scans the file), and there
// fn.toString() returns "[native code]": injected into a page that is a syntax
// error, and the page stays empty. A hot reload compiles from source, so it hid
// the problem. frameOf is also used here, built from the same text, so the page
// and the plugin can never disagree about where a grid selection lands.

// Turns a keydown event into the token stored with an action. A held Option
// changes e.key to a symbol, so letters and digits fall back to the physical key.
const EVENT_KEY_SRC = `function eventKey(e) {
  const named = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", " ": "space", Enter: "return", Tab: "tab" };
  if (named[e.key]) return named[e.key];
  if (e.key.length === 1 && !e.altKey) return e.key.toLowerCase();
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code || "");
  return m ? (m[1] || m[2]).toLowerCase() : null;
}`;

// The screen fraction an action covers, or null for one that has none (display moves).
const FRAME_OF_SRC = `function frameOf(a, specials) {
  if (a.special) return (specials[a.special] || {}).frame || null;
  const g = a.grid;
  if (!g) return null;
  return { x: g.c0 / g.cols, y: g.r0 / g.rows, w: (g.c1 - g.c0 + 1) / g.cols, h: (g.r1 - g.r0 + 1) / g.rows };
}`;
const frameOf = new Function("return " + FRAME_OF_SRC)();

const ICON_SVG_SRC = `function iconSvg(frame) {
  if (!frame) return '<svg width="22" height="14"></svg>';
  return '<svg width="22" height="14" viewBox="0 0 22 14"><rect class="screen" x="0.5" y="0.5" width="21" height="13" rx="2"/>' +
    '<rect class="tile" x="' + (1 + frame.x * 20) + '" y="' + (1 + frame.y * 12) + '" width="' + (frame.w * 20) + '" height="' + (frame.h * 12) + '" rx="1"/></svg>';
}`;

const ICON_CSS = `.screen { fill: none; stroke: currentColor; stroke-opacity: 0.35; }
.tile { fill: currentColor; fill-opacity: 0.7; }`;

function configKey(text) {
  const key = text.toLowerCase();
  return key.length === 1 || NAMED_KEYS.includes(key) ? key : null;
}

// Checks what came out of localStorage or the editor. An action that cannot work
// is dropped and reported rather than left to fail when its key is pressed.
function sanitizeActions(list) {
  const out = [];
  const problems = [];
  const seen = new Set();
  if (!Array.isArray(list)) return { actions: out, problems: ["Saved actions are not a list."] };
  for (const raw of list) {
    const a = raw || {};
    const key = typeof a.key === "string" ? configKey(a.key) : null;
    if (!key) {
      problems.push(`"${a.name}" has no valid key.`);
      continue;
    }
    if (seen.has(key)) {
      problems.push(`"${a.name}" repeats the key ${key}.`);
      continue;
    }
    const name = typeof a.name === "string" ? a.name.trim().slice(0, 40) : "";
    if (SPECIALS[a.special]) {
      out.push({ key, name: name || SPECIALS[a.special].label, special: a.special });
    } else {
      const g = a.grid || {};
      const ints = [g.cols, g.rows, g.c0, g.r0, g.c1, g.r1];
      const valid = ints.every(Number.isInteger) && g.cols >= 1 && g.cols <= MAX_GRID && g.rows >= 1 && g.rows <= MAX_GRID
        && Math.min(g.c0, g.c1, g.r0, g.r1) >= 0 && Math.max(g.c0, g.c1) < g.cols && Math.max(g.r0, g.r1) < g.rows;
      if (!valid) {
        problems.push(`"${name || key}" has no valid placement.`);
        continue;
      }
      out.push({
        key,
        name: name || "Untitled",
        grid: { cols: g.cols, rows: g.rows, c0: Math.min(g.c0, g.c1), r0: Math.min(g.r0, g.r1), c1: Math.max(g.c0, g.c1), r1: Math.max(g.r0, g.r1) },
      });
    }
    seen.add(key);
  }
  return { actions: out, problems };
}

// One action per line keeps the file readable and its diffs small.
function writeActions(list) {
  try {
    if (ACTIONS_FILE) macotron.fs.write(ACTIONS_FILE, "[\n" + list.map((a) => "  " + JSON.stringify(a)).join(",\n") + "\n]\n");
    else localStorage.setItem(STORE_KEY, JSON.stringify(list));
    console.log("window-tiling-menu: wrote", list.length, "actions to", ACTIONS_FILE || "local storage");
    return true;
  } catch (e) {
    console.error("window-tiling-menu: could not write", ACTIONS_FILE || "local storage", e);
    macotron.notify.toast("Tiling", "Could not save actions", { color: "error" });
    return false;
  }
}

// With a file set, the file wins. Otherwise (or when the file does not exist yet)
// the actions come from localStorage, and are moved into the file if there is one.
// With nothing saved the defaults apply and are not written, so a later change to
// them still reaches anyone who never edited their actions.
function loadStored() {
  if (ACTIONS_FILE && macotron.fs.exists(ACTIONS_FILE)) {
    try {
      return { list: JSON.parse(macotron.fs.read(ACTIONS_FILE)), problems: [] };
    } catch (e) {
      console.error("window-tiling-menu: could not read", ACTIONS_FILE, e);
      return { list: DEFAULT_ACTIONS, problems: [`${ACTIONS_FILE} is not valid JSON, so the defaults are in use. Fix it, or save from the editor to replace it.`] };
    }
  }
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  } catch (e) {
    console.error("window-tiling-menu: could not read the actions in local storage", e);
    return { list: DEFAULT_ACTIONS, problems: ["The actions in local storage are unreadable, so the defaults are in use. Save from the editor to replace them."] };
  }
  if (!Array.isArray(saved)) return { list: DEFAULT_ACTIONS, problems: [] };
  if (ACTIONS_FILE && writeActions(saved)) {
    localStorage.removeItem(STORE_KEY);
    console.log("window-tiling-menu: moved", saved.length, "actions from local storage to", ACTIONS_FILE);
  }
  return { list: saved, problems: [] };
}

// `stored` is what the editor edits and the file (or local storage) keeps; `actions` is what
// the overlay shows and places, with each placement already worked out.
let stored = [];
let actions = [];

function adopt(list, loadProblems = []) {
  const result = sanitizeActions(list);
  result.problems.push(...loadProblems);
  stored = result.actions;
  actions = stored.map((a) => ({
    key: a.key,
    label: a.name,
    frame: frameOf(a, SPECIALS),
    display: a.special ? SPECIALS[a.special].display : undefined,
  }));
  for (const problem of result.problems) console.warn("window-tiling-menu:", problem);
  macotron.checks([{
    title: "Actions",
    ok: result.problems.length === 0 && actions.length > 0,
    message: result.problems.length ? result.problems.join(" ") : actions.length ? undefined : "No actions yet. Run Configure Tiling Actions to add some.",
  }]);
}

const loaded = loadStored();
adopt(loaded.list, loaded.problems);
console.log("window-tiling-menu: loaded,", actions.length, "actions, gap =", opts.gap);

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// JSON that is safe inside a <script> element.
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function neighborDisplay(current, delta) {
  const displays = macotron.display.list();
  if (displays.length < 2) return undefined;
  const i = displays.findIndex((d) => d.id === current);
  return displays[(Math.max(i, 0) + delta + displays.length) % displays.length].id;
}

function place(win, action) {
  const frame = action.display ? { x: 0, y: 0, w: 1, h: 1, display: neighborDisplay(win.display, action.display) } : { ...action.frame, display: win.display };
  if (action.display && frame.display === undefined) {
    console.log("window-tiling-menu: only one display, ignoring", action.label);
    macotron.notify.toast("Tiling", "Only one display", { color: "warning" });
    return;
  }
  const ok = macotron.window.moveToFraction(win.id, { ...frame, gap: opts.gap });
  console.log("window-tiling-menu: placed", win.app, "->", action.label, "ok =", ok);
  if (!ok) macotron.notify.toast("Tiling", `Could not place ${win.app}`, { color: "error" });
}

// Page code both panels share. Clicks are handled once, on window, and the target
// is found from the pointer position: that works whether the host delivers a click
// to the element or dispatches it on window itself. Handlers on elements would
// silently do nothing in the second case. Errors in the page go to the plugin log,
// where a page that died on load would otherwise leave no trace at all.
const PAGE_ERRORS = `window.addEventListener("error", (e) => {
  const masked = e.message === "Script error." && !e.lineno;
  window.webkit.messageHandlers.macotron.postMessage({ type: "page-error", message: String(e.message) + (masked ? " (masked: thrown by a script the host evaluated, or from another origin)" : ""), line: e.lineno });
});`;

// A page's main script runs inside a function, so its names stay out of the global
// scope, and a catch reports the real message of an exception, which the page's
// error event never does here (it only says "Script error." for anything it
// cannot attribute).
const guardOpen = (name) => `(function () {
const PAGE_NAME = "${name}";
try {`;
const GUARD_CLOSE = `const snapshot = (when) => window.webkit.messageHandlers.macotron.postMessage({ type: "rendered", when, rows: document.querySelectorAll(".row,.item").length, children: document.body.children.length, visibility: document.visibilityState, size: innerWidth + "x" + innerHeight });
snapshot("end of script");
setTimeout(() => snapshot("after 0.5s"), 500);
setTimeout(() => snapshot("after 2s"), 2000);
} catch (e) {
  window.webkit.messageHandlers.macotron.postMessage({ type: "page-error", message: PAGE_NAME + " script threw: " + (e && e.stack || e), line: 0 });
}
})();`;

const PAGE_COMMON = `function send(message) {
  window.webkit.messageHandlers.macotron.postMessage(message);
}
function onClick(handler) {
  let last = { time: 0, x: -1, y: -1 };
  window.addEventListener("click", (e) => {
    const now = Date.now();
    if (now - last.time < 50 && Math.abs(e.clientX - last.x) < 3 && Math.abs(e.clientY - last.y) < 3) return;
    last = { time: now, x: e.clientX, y: e.clientY };
    const target = e.target instanceof Element ? e.target : document.elementFromPoint(e.clientX, e.clientY);
    if (target) handler(target);
  });
}`;

// Logs what a panel's page reported about itself. Returns true when the message was one.
function pageDiagnostic(panel, data) {
  if (data.type === "rendered") {
    console.log(`window-tiling-menu: ${panel} page ${data.when}: ${data.rows} rows, ${data.children} body children, ${data.visibility}, ${data.size}`);
    return true;
  }
  if (data.type !== "page-error") return false;
  console.error(`window-tiling-menu: ${panel} page error: ${data.message} (line ${data.line})`);
  return true;
}

// Only one overlay can be open, so the open window and its handler state live
// here and every onMessage handler reads it. Clearing it on the first message
// keeps a handler left over from an earlier open from placing the window twice.
// `overlayId` is the id panel.open handed back, which is what the rest of the
// panel API wants.
let session = null;
let overlayId = null;

macotron.on("panel:closed", (event) => {
  if (!event || event.id !== overlayId || !session) return;
  const { win } = session;
  session = null;
  macotron.window.focus(win.id);
});

function activate() {
  if (session) {
    macotron.panel.close(overlayId);
    return;
  }
  const win = macotron.window.focused();
  if (!win) {
    console.log("window-tiling-menu: no focused window");
    macotron.notify.toast("Tiling", "No focused window", { color: "warning" });
    return;
  }
  if (!actions.length) {
    console.log("window-tiling-menu: no actions, opening the editor");
    openEditor();
    return;
  }
  console.log("window-tiling-menu: activated for", win.app);
  session = { win };

  const columns = actions.length > 9 ? 2 : 1;
  const rows = Math.ceil(actions.length / columns);
  const payload = scriptJson(actions.map((a) => ({ key: a.key, label: a.label, frame: a.frame })));

  const id = macotron.panel.open({
    id: OVERLAY_ID,
    title: "Tiling",
    width: 250 * columns + 20,
    height: 96 + rows * 32,
    glass: "translucent",
    frameless: true,
    closeOnBlur: true,
    html: `<script>${PAGE_ERRORS}</script>
<style>
body { padding: 14px 10px 10px; gap: 8px; user-select: none; -webkit-user-select: none; }
header { padding: 0 6px; display: flex; justify-content: space-between; align-items: flex-start; }
header div { display: flex; flex-direction: column; gap: 2px; }
header b { font-size: 13px; }
header span, footer { font-size: 11px; opacity: 0.6; }
header .edit { font-size: 11px; padding: 0 4px; background: none; color: var(--macotron-accent); cursor: default; }
footer { padding: 0 6px; }
#list { display: grid; grid-template-columns: repeat(${columns}, 1fr); gap: 2px 6px; }
.row { display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 6px; border-radius: 6px; cursor: default; }
.row:hover, .row.hit { background: color-mix(in srgb, var(--macotron-accent) 45%, transparent); }
kbd { min-width: 22px; height: 20px; padding: 0 5px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; border-radius: 5px; font: 600 12px ui-monospace, monospace; background: light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.14)); }
.label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
svg { flex: none; }
${ICON_CSS}
</style>
<header><div><b>Tile window</b><span>${escapeHtml(win.app)}</span></div><button type="button" class="edit" data-act="edit">Edit</button></header>
<div id="list"></div>
<footer>Press a key to place the window, Esc to cancel</footer>
<script>${guardOpen("overlay")}
${EVENT_KEY_SRC}
${ICON_SVG_SRC}
${PAGE_COMMON}
const ACTIONS = ${payload};
const list = document.getElementById("list");
function esc(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
ACTIONS.forEach((a, i) => {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.act = "pick";
  row.dataset.i = i;
  row.innerHTML = "<kbd>" + esc(a.key) + '</kbd><span class="label">' + esc(a.label) + "</span>" + iconSvg(a.frame);
  list.appendChild(row);
});
onClick((target) => {
  const node = target.closest("[data-act]");
  if (!node) return;
  if (node.dataset.act === "edit") send({ type: "edit" });
  else send({ type: "pick", index: Number(node.dataset.i) });
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") return;
  const key = eventKey(e);
  const index = ACTIONS.findIndex((a) => a.key === key);
  if (index < 0) return;
  e.preventDefault();
  list.children[index].classList.add("hit");
  send({ type: "pick", index });
});
${GUARD_CLOSE}</script>`,
  });
  overlayId = id;

  macotron.panel.onMessage(id, (data) => {
    if (!data || pageDiagnostic("overlay", data) || !session) return;
    console.log("window-tiling-menu: overlay message", data.type);
    if (data.type === "edit") {
      session = null;
      macotron.panel.close(id);
      openEditor();
      return;
    }
    if (data.type !== "pick") return;
    const { win } = session;
    const action = actions[data.index];
    session = null;
    macotron.panel.close(id);
    if (!action) return;
    place(win, action);
    macotron.window.focus(win.id);
  });
}

// Bumped on every open, so a handler left from an earlier editor window ignores
// messages meant for the current one (a reset would otherwise ask twice).
let editorGen = 0;
let editorId = null;

function openEditor() {
  const gen = ++editorGen;
  if (editorId) macotron.panel.close(editorId);
  console.log("window-tiling-menu: editing", stored.length, "actions");
  const id = macotron.panel.open({
    id: EDITOR_ID,
    title: "Tiling Actions",
    width: 780,
    height: 680,
    html: editorHtml(),
  });
  editorId = id;

  macotron.panel.onMessage(id, (data) => {
    if (gen !== editorGen || !data || pageDiagnostic("editor", data)) return;
    if (data.type === "save") {
      adopt(data.actions);
      writeActions(stored);
    } else if (data.type === "reset") {
      if (!confirm("Replace all tiling actions with the defaults?")) return;
      adopt(DEFAULT_ACTIONS);
      writeActions(stored);
      console.log("window-tiling-menu: reset to the", actions.length, "default actions");
      openEditor();
    }
  });
}

function editorHtml() {
  return `<script>${PAGE_ERRORS}</script>
<style>
html, body { height: 100%; }
body { margin: 0; padding: 0; overflow: hidden; }
#app { display: flex; height: 100vh; }
#side { width: 250px; flex: none; display: flex; flex-direction: column; border-right: 1px solid light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.14)); }
#list { flex: 1; overflow: auto; padding: 8px; }
.item { display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 8px; border-radius: 6px; cursor: default; }
.item.sel { background: color-mix(in srgb, var(--macotron-accent) 40%, transparent); }
.item .label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sidebar-buttons { display: flex; gap: 6px; padding: 8px; flex-wrap: wrap; }
kbd { min-width: 22px; height: 20px; padding: 0 5px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; border-radius: 5px; font: 600 12px ui-monospace, monospace; background: light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.14)); }
svg { flex: none; }
${ICON_CSS}
#main { flex: 1; min-width: 0; padding: 18px 22px; display: flex; flex-direction: column; gap: 14px; overflow: auto; }
.field { display: flex; align-items: flex-start; gap: 12px; }
.field > label { width: 64px; flex: none; padding-top: 6px; }
.field input[type=text] { flex: 1; min-width: 0; }
.error { color: #d9352b; font-size: 12px; }
.muted { opacity: 0.6; font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; flex: 1; }
.chips button { padding: 4px 9px; font-size: 12px; }
button.on { background: var(--macotron-accent); color: var(--macotron-accent-text); }
.toolbar { display: flex; gap: 18px; align-items: center; }
.toolbar label { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.toolbar button { width: 26px; height: 26px; padding: 0; }
.toolbar .count { min-width: 1.5em; text-align: center; font-variant-numeric: tabular-nums; }
.stage { width: 100%; max-width: 380px; aspect-ratio: 16 / 10; }
#grid { display: grid; gap: 3px; width: 100%; height: 100%; user-select: none; -webkit-user-select: none; }
.cell { border-radius: 4px; background: light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.10)); pointer-events: none; }
.cell.on { background: color-mix(in srgb, var(--macotron-accent) 55%, transparent); }
.preview { position: relative; width: 100%; height: 100%; border-radius: 6px; background: light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.10)); }
.preview div { position: absolute; border-radius: 4px; background: color-mix(in srgb, var(--macotron-accent) 55%, transparent); }
.spacer { flex: 1; }
</style>
<div id="app">
  <div id="side">
    <div id="list"></div>
    <div class="sidebar-buttons">
      <button type="button" data-act="add">Add</button>
      <button type="button" data-act="up" title="Move up">&uarr;</button>
      <button type="button" data-act="down" title="Move down">&darr;</button>
      <button type="button" data-act="reset">Reset to defaults</button>
    </div>
  </div>
  <div id="main"></div>
</div>
<script>${guardOpen("editor")}
${EVENT_KEY_SRC}
${FRAME_OF_SRC}
${ICON_SVG_SRC}
${PAGE_COMMON}
const SPECIALS = ${scriptJson(SPECIALS)};
const KEYS = "abcdefghijklmnopqrstuvwxyz0123456789";
const MAX_GRID = ${MAX_GRID};
let actions = ${scriptJson(stored)};
let selected = 0;
let recording = false;
let keyError = "";
let drag = null;
let saveTimer = null;
const list = document.getElementById("list");
const main = document.getElementById("main");

function saveNow() {
  clearTimeout(saveTimer);
  send({ type: "save", actions });
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 250);
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, act, extra) {
  const node = el("button", "", text);
  node.type = "button";
  node.dataset.act = act;
  Object.assign(node.dataset, extra || {});
  return node;
}
function current() {
  return actions[selected];
}

function renderList() {
  list.innerHTML = "";
  actions.forEach((a, i) => {
    const row = el("div", "item" + (i === selected ? " sel" : ""));
    row.dataset.act = "select";
    row.dataset.i = i;
    row.appendChild(el("kbd", "", a.key));
    row.appendChild(el("span", "label", a.name || "Untitled"));
    row.insertAdjacentHTML("beforeend", iconSvg(frameOf(a, SPECIALS)));
    list.appendChild(row);
  });
}

function field(label, control) {
  const row = el("div", "field");
  row.appendChild(el("label", "", label));
  row.appendChild(control);
  return row;
}

function renderMain() {
  main.innerHTML = "";
  const a = current();
  if (!a) {
    main.appendChild(el("p", "muted", "No actions yet. Add one to get started."));
    return;
  }

  const name = el("input");
  name.type = "text";
  name.maxLength = 40;
  name.value = a.name;
  name.placeholder = "Name";
  name.oninput = () => {
    a.name = name.value;
    renderList();
    scheduleSave();
  };
  main.appendChild(field("Name", name));

  const keyRow = field("Key", button(recording ? "Press a key..." : a.key, "key"));
  main.appendChild(keyRow);
  if (keyError) main.appendChild(el("div", "error", keyError));

  const chips = el("div", "chips");
  const custom = button("Custom grid", "placement", { v: "grid" });
  if (a.grid) custom.classList.add("on");
  chips.appendChild(custom);
  for (const id of Object.keys(SPECIALS)) {
    const chip = button(SPECIALS[id].label, "placement", { v: id });
    if (a.special === id) chip.classList.add("on");
    chips.appendChild(chip);
  }
  main.appendChild(field("Placement", chips));

  main.appendChild(a.grid ? gridEditor(a) : specialPreview(a));
  if (a.grid) paintGrid(a.grid);

  main.appendChild(el("div", "spacer"));
  const bar = el("div", "field");
  bar.appendChild(button("Delete action", "delete"));
  main.appendChild(bar);
}

function specialPreview(a) {
  const wrap = el("div");
  const frame = frameOf(a, SPECIALS);
  if (!frame) {
    wrap.appendChild(el("p", "muted", SPECIALS[a.special].display > 0 ? "Sends the window full screen to the next display." : "Sends the window full screen to the previous display."));
    return wrap;
  }
  const stage = el("div", "stage");
  const preview = el("div", "preview");
  const tile = el("div");
  tile.style.left = frame.x * 100 + "%";
  tile.style.top = frame.y * 100 + "%";
  tile.style.width = frame.w * 100 + "%";
  tile.style.height = frame.h * 100 + "%";
  preview.appendChild(tile);
  stage.appendChild(preview);
  wrap.appendChild(stage);
  return wrap;
}

function gridEditor(a) {
  const wrap = el("div");
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.gap = "10px";

  const bar = el("div", "toolbar");
  for (const which of ["cols", "rows"]) {
    const label = el("label");
    label.appendChild(document.createTextNode(which === "cols" ? "Columns" : "Rows"));
    label.appendChild(button("−", "resize", { which, d: -1 }));
    label.appendChild(el("span", "count", String(a.grid[which])));
    label.appendChild(button("+", "resize", { which, d: 1 }));
    bar.appendChild(label);
  }
  wrap.appendChild(bar);
  wrap.appendChild(el("p", "muted", "Drag across the grid to choose where the window goes."));

  const stage = el("div", "stage");
  const grid = el("div");
  grid.id = "grid";
  grid.style.gridTemplateColumns = "repeat(" + a.grid.cols + ", 1fr)";
  grid.style.gridTemplateRows = "repeat(" + a.grid.rows + ", 1fr)";
  for (let r = 0; r < a.grid.rows; r++) {
    for (let c = 0; c < a.grid.cols; c++) {
      const cell = el("div", "cell");
      cell.dataset.c = c;
      cell.dataset.r = r;
      grid.appendChild(cell);
    }
  }
  stage.appendChild(grid);
  wrap.appendChild(stage);
  return wrap;
}

function resize(a, which, delta) {
  const g = a.grid;
  g[which] = Math.max(1, Math.min(MAX_GRID, g[which] + delta));
  g.c1 = Math.min(g.c1, g.cols - 1);
  g.c0 = Math.min(g.c0, g.c1);
  g.r1 = Math.min(g.r1, g.rows - 1);
  g.r0 = Math.min(g.r0, g.r1);
  saveNow();
  render();
}

function choosePlacement(a, value) {
  const before = a.special ? SPECIALS[a.special].label : "";
  if (value === "grid") {
    delete a.special;
    a.grid = a.grid || { cols: 6, rows: 6, c0: 0, r0: 0, c1: 2, r1: 5 };
  } else {
    if (!a.name || a.name === before || a.name === "New action") a.name = SPECIALS[value].label;
    a.special = value;
    delete a.grid;
  }
  saveNow();
  render();
}

// Which cell is under the pointer. While dragging, a pointer outside the grid
// counts as the nearest cell, so the selection can run to an edge.
function cellAt(e, clamp) {
  const grid = document.getElementById("grid");
  const a = current();
  if (!grid || !a || !a.grid) return null;
  const rect = grid.getBoundingClientRect();
  const inside = e.clientX >= rect.left && e.clientY >= rect.top && e.clientX < rect.right && e.clientY < rect.bottom;
  if (!inside && !clamp) return null;
  const c = Math.min(a.grid.cols - 1, Math.max(0, Math.floor((e.clientX - rect.left) / rect.width * a.grid.cols)));
  const r = Math.min(a.grid.rows - 1, Math.max(0, Math.floor((e.clientY - rect.top) / rect.height * a.grid.rows)));
  return { c, r };
}

function paintGrid(sel) {
  const grid = document.getElementById("grid");
  if (!grid) return;
  const c0 = Math.min(sel.c0, sel.c1), c1 = Math.max(sel.c0, sel.c1);
  const r0 = Math.min(sel.r0, sel.r1), r1 = Math.max(sel.r0, sel.r1);
  grid.querySelectorAll(".cell").forEach((cell) => {
    const c = Number(cell.dataset.c), r = Number(cell.dataset.r);
    cell.classList.toggle("on", c >= c0 && c <= c1 && r >= r0 && r <= r1);
  });
}

function finishDrag() {
  if (!drag) return;
  const a = current();
  a.grid.c0 = Math.min(drag.c0, drag.c1);
  a.grid.c1 = Math.max(drag.c0, drag.c1);
  a.grid.r0 = Math.min(drag.r0, drag.r1);
  a.grid.r1 = Math.max(drag.r0, drag.r1);
  drag = null;
  saveNow();
  renderList();
}

window.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  const hit = cellAt(e, false);
  if (!hit) return;
  e.preventDefault();
  drag = { c0: hit.c, r0: hit.r, c1: hit.c, r1: hit.r };
  paintGrid(drag);
});
window.addEventListener("mousemove", (e) => {
  if (!drag) return;
  if (e.buttons === 0) {
    finishDrag();
    return;
  }
  const hit = cellAt(e, true);
  if (!hit) return;
  drag.c1 = hit.c;
  drag.r1 = hit.r;
  paintGrid(drag);
});
window.addEventListener("mouseup", finishDrag);

window.addEventListener("keydown", (e) => {
  if (!recording) return;
  e.preventDefault();
  if (e.key === "Escape") {
    recording = false;
    renderMain();
    return;
  }
  const key = eventKey(e);
  if (!key) return;
  const other = actions.find((a, i) => i !== selected && a.key === key);
  if (other) {
    keyError = "Already used by " + other.name + ".";
  } else {
    current().key = key;
    keyError = "";
    saveNow();
  }
  recording = false;
  render();
});

function render() {
  renderList();
  renderMain();
}

function add() {
  const used = actions.map((a) => a.key);
  const key = KEYS.split("").find((k) => !used.includes(k));
  if (!key) return;
  actions.push({ key, name: "New action", grid: { cols: 6, rows: 6, c0: 0, r0: 0, c1: 2, r1: 5 } });
  selected = actions.length - 1;
  recording = false;
  keyError = "";
  saveNow();
  render();
  const name = main.querySelector("input");
  name.focus();
  name.select();
}

function move(delta) {
  const to = selected + delta;
  if (to < 0 || to >= actions.length) return;
  [actions[selected], actions[to]] = [actions[to], actions[selected]];
  selected = to;
  saveNow();
  render();
}

onClick((target) => {
  if (target.tagName === "INPUT") {
    target.focus();
    return;
  }
  const node = target.closest("[data-act]");
  if (!node) return;
  const d = node.dataset;
  switch (d.act) {
    case "select":
      selected = Number(d.i);
      recording = false;
      keyError = "";
      render();
      break;
    case "key":
      recording = !recording;
      keyError = "";
      renderMain();
      break;
    case "placement":
      choosePlacement(current(), d.v);
      break;
    case "resize":
      resize(current(), d.which, Number(d.d));
      break;
    case "delete":
      actions.splice(selected, 1);
      selected = Math.max(0, Math.min(selected, actions.length - 1));
      saveNow();
      render();
      break;
    case "add":
      add();
      break;
    case "up":
      move(-1);
      break;
    case "down":
      move(1);
      break;
    case "reset":
      send({ type: "reset" });
      break;
  }
});
render();
${GUARD_CLOSE}</script>`;
}

macotron.keyboard.on("Tile Window", "ctrl+opt+w", activate);
macotron.command("Configure Tiling Actions", "Name tiling actions, pick their keys and draw their placement", openEditor, { id: "window-tiling-menu/configure" });
