#!/usr/bin/env node
/**
 * cua.mjs - standalone Windows Computer Use CLI for DeepSeek Harness (and any shell-driving agent).
 *
 * It drives the same runtime Codex uses (@oai/sky + codex-computer-use.exe) but without node_repl:
 *   - resolves the Codex CUA node runtime automatically
 *   - shims globalThis.nodeRepl so the runtime works standalone
 *   - asks for user approval per app (never auto-approves unknown apps)
 *   - does observe -> act -> observe inside one process so window/element/screenshot ids stay valid
 *
 * Output: JSON on stdout. Exit codes: 0 ok, 1 error, 2 ambiguous target, 3 approval required, 4 runtime missing.
 *
 * Commands: ping apps windows use state activate launch
 *           click type key scroll drag set-value secondary
 *           approve revoke approvals help
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, "..");
const STATE_DIR = path.join(SKILL_DIR, ".state");
const SHOT_DIR = path.join(STATE_DIR, "shots");
const APPROVALS_PATH = path.join(STATE_DIR, "approved-apps.json");
const CURRENT_PATH = path.join(STATE_DIR, "current-window.json");

const EXIT = { ok: 0, error: 1, ambiguous: 2, approval: 3, runtime: 4 };
const APPROVED_META_KEY = "x-oai-cua-approved-app";

// ---------------------------------------------------------------- small utils

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function die(obj, code = EXIT.error) {
  emit({ ok: false, ...obj });
  if (obj.hint) process.stderr.write(String(obj.hint) + "\n");
  process.exit(code);
}

function toInt(value) {
  if (value === undefined || value === null || value === true || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith("--") && Number.isNaN(Number(next)))) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      pos.push(arg);
    }
  }
  return { flags, pos };
}

// ------------------------------------------------------------ runtime lookup

// codex-computer-use.exe spawns `codex app-server` itself and finds the CLI only through
// CODEX_CLI_PATH (the Codex desktop app sets it; a bare shell does not, and the npm `codex`
// shim is a .cmd, which the native helper cannot run). Resolve a real codex.exe so `ping`
// and the approval flow work without any manual environment setup.
function codexCliExe() {
  const names = ["codex.exe"];
  if (process.env.CODEX_CLI_PATH) names.unshift(process.env.CODEX_CLI_PATH);
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  names.push(path.join(localAppData, "OpenAI", "Codex", "bin", "codex.exe"));

  const found = [];
  const collect = (dir, depth) => {
    if (depth < 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase() === "codex.exe") found.push(path.join(dir, entry.name));
      else if (entry.isDirectory() && depth > 0) collect(path.join(dir, entry.name), depth - 1);
    }
  };
  collect(path.join(localAppData, "OpenAI", "Codex", "bin"), 3);

  found.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; // newest CLI build first
    } catch {
      return 0;
    }
  });
  for (const exe of [...names, ...found]) {
    try {
      if (fs.statSync(exe).isFile()) return exe;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function findRuntime() {
  const candidates = [];
  if (process.env.OAI_CUA_RUNTIME) candidates.push(process.env.OAI_CUA_RUNTIME);
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const base = path.join(localAppData, "OpenAI", "Codex", "runtimes", "cua_node");
  if (fs.existsSync(base)) {
    candidates.push(base);
    const children = [];
    for (const name of fs.readdirSync(base)) {
      const dir = path.join(base, name);
      try {
        if (fs.statSync(dir).isDirectory()) children.push({ dir, mtime: fs.statSync(dir).mtimeMs });
      } catch {}
    }
    children.sort((a, b) => b.mtime - a.mtime);
    for (const child of children) candidates.push(child.dir);
  }
  for (const root of candidates) {
    const skyIndex = path.join(root, "bin", "node_modules", "@oai", "sky", "dist", "project", "cua", "sky_js", "src", "index.js");
    const helper = path.join(root, "bin", "node_modules", "@oai", "sky", "bin", "windows", "codex-computer-use.exe");
    if (fs.existsSync(skyIndex) && fs.existsSync(helper)) return { root, skyIndex, helper };
  }
  return null;
}

function ensureCodexCli() {
  const exe = codexCliExe();
  if (!exe) return;
  process.env.CODEX_CLI_PATH = exe; // forwarded to the helper, which reads only this variable
}

ensureCodexCli();
const runtime = findRuntime();

const { flags, pos } = parseArgs(process.argv.slice(2));
const command = pos[0] ?? "help";

if (command === "help") {
  emit({
    ok: true,
    usage: "node cua.mjs <command> [options]",
    commands: {
      ping: "check that the Codex Computer Use runtime is available",
      apps: "list apps and their open windows",
      windows: "list targetable windows",
      use: "select and remember a target window (--app <regex> | --title <regex> | --window-id N)",
      state: "capture accessibility tree + screenshot of the target window",
      activate: "bring the target window to the foreground",
      launch: "launch an app (--app <appId>)",
      click: "click (--x N --y N | --index N [--expect text] | --find text [--nth K, zero-based]) [--double] [--button right]",
      type: "type text (--text <s> | --text-file <path>) [--submit] [--require-focus text]",
      key: "press a key chord (--key \"Control_L+a\")",
      scroll: "scroll from a point (--x N --y N --dy N [--dx N])",
      drag: "drag (--from-x N --from-y N --to-x N --to-y N)",
      "set-value": "replace an editable element value (--index|--find) --value <s>|--value-file <p>",
      secondary: "invoke a secondary accessibility action (--index|--find) --action <label>",
      approve: "remember a user approval: approve <approvedAppId>",
      revoke: "forget an approval: revoke <approvedAppId>",
      approvals: "list remembered approvals",
    },
    windowOptions: ["--app <regex>", "--title <regex>", "--window-id <id>", "--window-index <k>"],
    outputOptions: ["--no-tree", "--no-shot", "--shot <path>", "--timeout <ms>"],
    exitCodes: EXIT,
  });
  process.exit(EXIT.ok);
}

if (command === "ping" || !runtime) {
  if (!runtime) {
    die(
      {
        error: "cua_runtime_not_found",
        searched: "OAI_CUA_RUNTIME, %LOCALAPPDATA%\\OpenAI\\Codex\\runtimes\\cua_node",
        hint: "Run Computer Use once from the Codex desktop app, or set OAI_CUA_RUNTIME to a cua_node runtime directory.",
      },
      EXIT.runtime,
    );
  }
}

// ----------------------------------------------------------------- approvals

const approvals = readJson(APPROVALS_PATH, { approved: [], learned: {} });
if (!Array.isArray(approvals.approved)) approvals.approved = [];
if (typeof approvals.learned !== "object" || approvals.learned === null) approvals.learned = {};

const saveApprovals = () => writeJson(APPROVALS_PATH, approvals);
const isApproved = (id) => Boolean(id) && approvals.approved.includes(id);

function guessApprovalId(windowApp) {
  if (!windowApp) return null;
  if (windowApp.startsWith("process:")) return path.win32.basename(windowApp.slice("process:".length));
  return windowApp;
}

if (command === "approvals") {
  emit({ ok: true, approved: approvals.approved, learned: approvals.learned, file: APPROVALS_PATH });
  process.exit(EXIT.ok);
}

if (command === "approve" || command === "revoke") {
  const id = String(pos[1] ?? flags.app ?? "").trim();
  if (!id) die({ error: "app_id_required", hint: "Usage: node cua.mjs approve <approvedAppId>" }, EXIT.error);
  if (command === "approve") {
    if (!approvals.approved.includes(id)) approvals.approved.push(id);
  } else {
    approvals.approved = approvals.approved.filter((x) => x !== id);
    for (const [key, value] of Object.entries(approvals.learned)) if (value === id) delete approvals.learned[key];
  }
  saveApprovals();
  emit({ ok: true, command, approved: approvals.approved });
  process.exit(EXIT.ok);
}

// --------------------------------------------------------------- sky shim

// Import first: the package decides "standalone mode" when globalThis.nodeRepl
// is absent at module-evaluation time. The shim is added right after.
const { sky } = await import(pathToFileURL(runtime.skyIndex).href);

let pendingWindowApp = null;

class ApprovalRequiredError extends Error {
  constructor(appId, displayName) {
    super(`approval_required:${appId}`);
    this.name = "ApprovalRequiredError";
    this.appId = appId;
    this.displayName = displayName ?? appId;
  }
}

globalThis.nodeRepl = {
  config: {},
  requestMeta: {},
  createElicitation: async (request) => {
    const appId = String(request?.meta?.tool_params?.app ?? "").trim();
    const displayName = String(
      request?.meta?.tool_params_display?.find?.((item) => item.name === "app")?.value ?? appId,
    ).trim();
    if (appId && pendingWindowApp) {
      approvals.learned[pendingWindowApp] = appId;
      saveApprovals();
    }
    if (!isApproved(appId)) throw new ApprovalRequiredError(appId, displayName);
    return { action: "accept" };
  },
};

function primeApproval(windowApp) {
  pendingWindowApp = windowApp ?? null;
  const meta = globalThis.nodeRepl.requestMeta;
  delete meta[APPROVED_META_KEY];
  if (!windowApp) return;
  const learned = approvals.learned[windowApp];
  const candidate = learned && isApproved(learned) ? learned : guessApprovalId(windowApp);
  if (isApproved(candidate)) meta[APPROVED_META_KEY] = candidate;
}

// ----------------------------------------------------------------- commands

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listWindowsFlat() {
  const apps = await sky.list_apps();
  const flat = [];
  for (const app of apps) {
    for (const win of app.windows ?? []) {
      flat.push({
        app: win.app ?? app.id,
        appId: app.id,
        displayName: app.displayName ?? app.id,
        id: win.id,
        title: win.title ?? "",
      });
    }
  }
  return { apps, flat };
}

async function selectWindow() {
  const wantedId = toInt(flags["window-id"]);
  if (wantedId !== undefined) {
    const win = await sky.get_window({ id: wantedId });
    return { app: win.app, id: win.id, title: win.title ?? "" };
  }

  const { flat } = await listWindowsFlat();
  const appRe = flags.app ? new RegExp(String(flags.app), "i") : null;
  const titleRe = flags.title ? new RegExp(String(flags.title), "i") : null;

  if (!appRe && !titleRe) {
    const current = readJson(CURRENT_PATH, null);
    if (!current) {
      die({ error: "no_window_selected", hint: "Select a window first: node cua.mjs use --app <pattern>" }, EXIT.error);
    }
    const found = flat.find((win) => win.id === current.id);
    if (!found) {
      die(
        { error: "current_window_gone", window: current, hint: "The remembered window is gone. Re-select with: node cua.mjs use --app <pattern>" },
        EXIT.error,
      );
    }
    return { app: found.app, id: found.id, title: found.title };
  }

  let matches = flat;
  if (appRe) matches = matches.filter((w) => appRe.test(w.app) || appRe.test(w.appId) || appRe.test(w.displayName));
  if (titleRe) matches = matches.filter((w) => titleRe.test(w.title));

  if (matches.length === 0) {
    die({ error: "no_window_match", hint: "Nothing matched. Run: node cua.mjs apps" }, EXIT.error);
  }
  if (matches.length > 1) {
    const idx = toInt(flags["window-index"]);
    const summary = matches.map((w, i) => ({ i, app: w.app, id: w.id, title: w.title }));
    if (idx === undefined) {
      die(
        { error: "ambiguous_window", candidates: summary, hint: "Narrow with --title, or add --window-index <i>." },
        EXIT.ambiguous,
      );
    }
    const pick = matches[idx];
    if (!pick) die({ error: "bad_window_index", count: matches.length }, EXIT.ambiguous);
    return { app: pick.app, id: pick.id, title: pick.title };
  }
  return { app: matches[0].app, id: matches[0].id, title: matches[0].title };
}

// Retention: every `state` / `click` / `key` / `scroll` call drops one screenshot into
// .state/shots, so the folder would grow without bound. Keep the newest N (default 100,
// roughly 4 MB) and delete the rest. CUA_SHOT_KEEP=0 disables pruning entirely.
const SHOT_KEEP = (() => {
  const raw = Number(process.env.CUA_SHOT_KEEP);
  return Number.isInteger(raw) && raw >= 0 ? raw : 100;
})();

function pruneShots() {
  if (SHOT_KEEP === 0) return;
  let entries;
  try {
    entries = fs
      .readdirSync(SHOT_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(SHOT_DIR, entry.name);
        try {
          return { file, mtime: fs.statSync(file).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return; // no shots dir yet - nothing to prune
  }
  if (entries.length <= SHOT_KEEP) return;
  entries.sort((a, b) => b.mtime - a.mtime); // newest first
  for (const stale of entries.slice(SHOT_KEEP)) {
    try {
      fs.unlinkSync(stale.file);
    } catch {
      /* a locked or already-deleted shot must never fail the command */
    }
  }
}

async function capture(window, { shot = true, text = true, save = false } = {}) {
  if (!shot && !text) text = true;
  const state = await sky.get_window_state({
    window: { app: window.app, id: window.id },
    include_screenshot: shot,
    include_text: text,
  });
  let screenshot = null;
  if (shot) {
    const shots = [...(state.screenshots ?? [])].sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0));
    const main = shots[0];
    if (main?.url) {
      const mime = /^data:([^;]+);/.exec(main.url)?.[1] ?? "image/jpeg";
      const ext = mime.includes("png") ? ".png" : mime.includes("webp") ? ".webp" : ".jpg";
      screenshot = {
        id: main.id,
        mime,
        width: main.width ?? null,
        height: main.height ?? null,
        originX: main.originX ?? null,
        originY: main.originY ?? null,
      };
      if (save) {
        const target = flags.shot ? path.resolve(String(flags.shot)) : path.join(SHOT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-w${window.id}${ext}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(String(main.url).split(",")[1] ?? "", "base64"));
        screenshot.path = target;
        screenshot.bytes = fs.statSync(target).size;
        if (!flags.shot) pruneShots(); // an explicit --shot path is the caller's business
      }
    }
  }
  return { state, screenshot };
}

async function captureAfter(window, options = {}) {
  try {
    return { ...(await capture(window, options)), warning: null };
  } catch (error) {
    if (error instanceof ApprovalRequiredError) throw error;
    return {
      state: null,
      screenshot: null,
      warning: `action sent, but the follow-up state read failed (${String(error?.message ?? error)}); the window may have closed.`,
    };
  }
}

function parseTree(tree) {
  const entries = [];
  for (const line of String(tree ?? "").split("\n")) {
    const match = /^[\t ]*(\d+)[\t ]+(.*)$/.exec(line);
    if (match) entries.push({ index: Number(match[1]), text: match[2].trim(), raw: line.trim() });
  }
  return entries;
}

function resolveElementIndex(tree) {
  const entries = parseTree(tree);
  const explicit = toInt(flags.index);
  if (explicit !== undefined) {
    const hit = entries.find((entry) => entry.index === explicit);
    const expect = flags.expect ? String(flags.expect).toLowerCase() : null;
    if (expect) {
      const ok = hit && hit.text.toLowerCase().includes(expect);
      if (!ok) {
        die(
          {
            error: "element_mismatch",
            index: explicit,
            expected: flags.expect,
            actual: hit?.text ?? null,
            hint: "The UI changed since you read the tree. Re-run state and pick again.",
          },
          EXIT.error,
        );
      }
    }
    if (!hit) die({ error: "element_index_not_found", index: explicit }, EXIT.error);
    return explicit;
  }
  if (flags.find) {
    const needle = String(flags.find).toLowerCase();
    const hits = entries.filter((entry) => entry.text.toLowerCase().includes(needle));
    if (hits.length === 0) {
      die({ error: "element_not_found", find: flags.find, hint: "Re-run state and copy the exact text of the target line." }, EXIT.error);
    }
    const nth = toInt(flags.nth);
    if (hits.length > 1 && nth === undefined) {
      die(
        {
          error: "element_ambiguous",
          find: flags.find,
          matches: hits.slice(0, 20).map((entry, i) => ({ nth: i, index: entry.index, text: entry.text })),
          hint: "Matches are in tree order; --nth is zero-based in the same order. Refine --find, or pass --nth <k>.",
        },
        EXIT.ambiguous,
      );
    }
    return hits[nth ?? 0]?.index ?? hits[0].index;
  }
  die({ error: "element_selector_required", hint: "Pass --index N (optionally --expect \"text\") or --find \"text\"." }, EXIT.error);
  return null;
}

function treePayload(state, includeTree) {
  const ax = state?.accessibility;
  return {
    treeLength: (ax?.tree ?? "").length,
    focusedElement: ax?.focused_element ?? null,
    selectedText: ax?.selected_text ?? null,
    tree: includeTree ? ax?.tree ?? "" : undefined,
  };
}

function imageHint() {
  return "If your harness cannot display images, rely on the accessibility tree and click by --find/--index instead of coordinates.";
}

const includeTree = flags["no-tree"] !== true;
const wantShot = flags["no-shot"] !== true;
const timeoutNote = "Windows apps are slow to respond sometimes; if a request times out, re-run the command once.";

function handleActionError(error) {
  if (error instanceof ApprovalRequiredError) {
    const appId = error.appId || guessApprovalId(pendingWindowApp) || "unknown";
    die(
      {
        error: "approval_required",
        app: appId,
        displayName: error.displayName ?? appId,
        next: `Ask the user: "Allow Computer Use to control ${error.displayName ?? appId}?" Then run: node cua.mjs approve "${appId}" and retry the command.`,
        hint: `Computer Use needs explicit user approval for ${error.displayName ?? appId} (${appId}).`,
      },
      EXIT.approval,
    );
  }
  die({ error: "computer_use_failed", message: String(error?.message ?? error), hint: timeoutNote }, EXIT.error);
}

async function withWindow(fn) {
  const window = await selectWindow();
  primeApproval(window.app);
  try {
    return await fn(window);
  } catch (error) {
    handleActionError(error);
    throw error;
  }
}

async function main() {
  switch (command) {
    case "ping": {
      const apps = await sky.list_apps();
      emit({
        ok: true,
        command,
        runtime: runtime.root,
        helper: runtime.helper,
        searchableApps: apps.length,
        appsWithWindows: apps.filter((app) => (app.windows ?? []).length > 0).length,
        approvals: approvals.approved,
      });
      return;
    }

    case "apps": {
      const apps = await sky.list_apps();
      emit({
        ok: true,
        command,
        apps: apps.map((app) => ({
          id: app.id,
          displayName: app.displayName ?? app.id,
          isRunning: app.isRunning ?? null,
          windows: (app.windows ?? []).map((win) => ({ id: win.id, title: win.title ?? "" })),
        })),
      });
      return;
    }

    case "windows": {
      const windows = await sky.list_windows();
      emit({ ok: true, command, windows });
      return;
    }

    case "use": {
      const window = await selectWindow();
      writeJson(CURRENT_PATH, { ...window, selectedAt: new Date().toISOString() });
      primeApproval(window.app);
      let snapshot = null;
      try {
        const { state } = await capture(window, { shot: false, text: true });
        snapshot = { focusedElement: state.accessibility?.focused_element ?? null, treeLength: (state.accessibility?.tree ?? "").length };
      } catch (error) {
        handleActionError(error);
      }
      emit({
        ok: true,
        command,
        window,
        remembered: CURRENT_PATH,
        note: "This window is now the default target for later commands.",
        accessibility: snapshot,
        approvalGuess: guessApprovalId(window.app),
      });
      return;
    }

    case "state": {
      await withWindow(async (window) => {
        const { state, screenshot } = await capture(window, { shot: wantShot, text: true, save: wantShot });
        emit({
          ok: true,
          command,
          window: state.window ?? window,
          screenshot,
          imageHint: screenshot ? imageHint() : undefined,
          accessibility: treePayload(state, includeTree),
        });
      });
      return;
    }

    case "activate": {
      await withWindow(async (window) => {
        await sky.activate_window({ window: { app: window.app, id: window.id } });
        const { state, screenshot } = await capture(window, { shot: wantShot, text: true, save: wantShot });
        emit({
          ok: true,
          command,
          window: state.window ?? window,
          screenshot,
          accessibility: treePayload(state, includeTree),
        });
      });
      return;
    }

    case "launch": {
      const appId = String(flags.app ?? pos[1] ?? "").trim();
      if (!appId) die({ error: "app_required", hint: "Usage: node cua.mjs launch --app <appId>" }, EXIT.error);
      primeApproval(appId);
      try {
        await sky.launch_app({ app: appId });
        await sleep(1500);
        const { flat } = await listWindowsFlat();
        const opened = flat.filter((win) => win.app === appId || win.appId === appId);
        emit({
          ok: true,
          command,
          launched: appId,
          windows: opened,
          hint: opened.length === 0 ? "No window yet. Wait a moment and run: node cua.mjs use --app <pattern>" : undefined,
        });
      } catch (error) {
        handleActionError(error);
      }
      return;
    }

    case "click": {
      await withWindow(async (window) => {
        // Element clicks need window geometry, which the runtime derives from a fresh screenshot.
        const before = await capture(window, { shot: true, text: true, save: false });
        const clickCount = flags.double ? 2 : 1;
        const button = flags.button ? String(flags.button) : "left";
        const x = toInt(flags.x);
        const y = toInt(flags.y);
        let target;
        if (x !== undefined && y !== undefined) {
          if (!before.screenshot?.id) die({ error: "no_screenshot_id", hint: "Coordinate clicks need a fresh screenshot; retry without --no-shot." }, EXIT.error);
          await sky.click({ window: { app: window.app, id: window.id }, screenshotId: before.screenshot.id, x, y, click_count: clickCount, mouse_button: button });
          target = { mode: "coordinates", x, y };
        } else {
          const index = resolveElementIndex(before.state.accessibility?.tree ?? "");
          const line = parseTree(before.state.accessibility?.tree ?? "").find((entry) => entry.index === index);
          await sky.click({
            window: { app: window.app, id: window.id },
            element_index: index,
            screenshotId: before.screenshot?.id ?? undefined,
            click_count: clickCount,
            mouse_button: button,
          });
          target = { mode: "element", index, text: line?.text ?? null };
        }
        const after = await captureAfter(window, { shot: wantShot, text: true, save: wantShot });
        emit({
          ok: true,
          command,
          window: after.state?.window ?? window,
          clicked: target,
          screenshot: after.screenshot,
          warning: after.warning ?? undefined,
          accessibility: treePayload(after.state, includeTree),
        });
      });
      return;
    }

    case "type": {
      await withWindow(async (window) => {
        let text = flags.text === undefined ? null : String(flags.text);
        if (text === null && flags["text-file"]) text = fs.readFileSync(path.resolve(String(flags["text-file"])), "utf8");
        if (text === null) die({ error: "text_required", hint: "Pass --text <s> or --text-file <path>." }, EXIT.error);

        const before = await capture(window, { shot: false, text: true });
        const focused = before.state.accessibility?.focused_element ?? null;
        if (flags["require-focus"] && !(focused ?? "").toLowerCase().includes(String(flags["require-focus"]).toLowerCase())) {
          die(
            { error: "focus_mismatch", requireFocus: flags["require-focus"], focusedElement: focused, hint: "Click the intended editor first, then retype." },
            EXIT.error,
          );
        }
        await sky.type_text({ window: { app: window.app, id: window.id }, text });
        if (flags.submit) await sky.press_key({ window: { app: window.app, id: window.id }, key: "Return" });
        const after = await captureAfter(window, { shot: wantShot, text: true, save: wantShot });
        emit({
          ok: true,
          command,
          window: after.state?.window ?? window,
          typedCharacters: text.length,
          focusedBefore: focused,
          submitted: Boolean(flags.submit),
          screenshot: after.screenshot,
          warning: after.warning ?? undefined,
          accessibility: treePayload(after.state, includeTree),
        });
      });
      return;
    }

    case "key": {
      const key = String(flags.key ?? pos[1] ?? "").trim();
      if (!key) die({ error: "key_required", hint: "Usage: node cua.mjs key --key \"Control_L+a\"" }, EXIT.error);
      if (/(^|\+)(Meta|Windows|Win|Cmd|Command|Super|OS)(\+|$)/i.test(key)) {
        die({ error: "forbidden_key", key, hint: "Windows-key shortcuts are not allowed by the Computer Use safety policy." }, EXIT.error);
      }
      await withWindow(async (window) => {
        await sky.press_key({ window: { app: window.app, id: window.id }, key });
        const after = await captureAfter(window, { shot: wantShot, text: true, save: wantShot });
        emit({
          ok: true,
          command,
          window: after.state?.window ?? window,
          key,
          screenshot: after.screenshot,
          warning: after.warning ?? undefined,
          accessibility: treePayload(after.state, includeTree),
        });
      });
      return;
    }

    case "scroll": {
      await withWindow(async (window) => {
        const x = toInt(flags.x);
        const y = toInt(flags.y);
        const dy = toInt(flags.dy) ?? toInt(flags["scroll-y"]) ?? 0;
        const dx = toInt(flags.dx) ?? toInt(flags["scroll-x"]) ?? 0;
        if (x === undefined || y === undefined) die({ error: "point_required", hint: "Usage: node cua.mjs scroll --x N --y N --dy 600" }, EXIT.error);
        const before = await capture(window, { shot: wantShot, text: false });
        const payload = { window: { app: window.app, id: window.id }, x, y, scrollX: dx, scrollY: dy };
        if (before.screenshot?.id) payload.screenshotId = before.screenshot.id;
        await sky.scroll(payload);
        const after = await captureAfter(window, { shot: wantShot, text: true, save: wantShot });
        emit({
          ok: true,
          command,
          window: after.state?.window ?? window,
          scrolled: { x, y, dx, dy },
          screenshot: after.screenshot,
          warning: after.warning ?? undefined,
          accessibility: treePayload(after.state, includeTree),
        });
      });
      return;
    }

    case "drag": {
      await withWindow(async (window) => {
        const fromX = toInt(flags["from-x"]);
        const fromY = toInt(flags["from-y"]);
        const toX = toInt(flags["to-x"]);
        const toY = toInt(flags["to-y"]);
        if ([fromX, fromY, toX, toY].some((value) => value === undefined)) {
          die({ error: "drag_points_required", hint: "Usage: node cua.mjs drag --from-x N --from-y N --to-x N --to-y N" }, EXIT.error);
        }
        const before = await capture(window, { shot: wantShot, text: false });
        const payload = { window: { app: window.app, id: window.id }, from_x: fromX, from_y: fromY, to_x: toX, to_y: toY };
        if (before.screenshot?.id) payload.screenshotId = before.screenshot.id;
        await sky.drag(payload);
        const after = await captureAfter(window, { shot: wantShot, text: true, save: wantShot });
        emit({
          ok: true,
          command,
          window: after.state?.window ?? window,
          dragged: { fromX, fromY, toX, toY },
          screenshot: after.screenshot,
          warning: after.warning ?? undefined,
          accessibility: treePayload(after.state, includeTree),
        });
      });
      return;
    }

    case "set-value": {
      await withWindow(async (window) => {
        let value = flags.value === undefined ? null : String(flags.value);
        if (value === null && flags["value-file"]) value = fs.readFileSync(path.resolve(String(flags["value-file"])), "utf8");
        if (value === null) die({ error: "value_required", hint: "Pass --value <s> or --value-file <path>." }, EXIT.error);
        const before = await capture(window, { shot: false, text: true });
        const index = resolveElementIndex(before.state.accessibility?.tree ?? "");
        await sky.set_value({ window: { app: window.app, id: window.id }, element_index: index, value });
        const after = await captureAfter(window, { shot: wantShot, text: true, save: wantShot });
        emit({
          ok: true,
          command,
          window: after.state?.window ?? window,
          element: index,
          valueLength: value.length,
          screenshot: after.screenshot,
          warning: after.warning ?? undefined,
          accessibility: treePayload(after.state, includeTree),
        });
      });
      return;
    }

    case "secondary": {
      await withWindow(async (window) => {
        const action = String(flags.action ?? pos[1] ?? "").trim();
        if (!action) die({ error: "action_required", hint: "Usage: node cua.mjs secondary --index N --action Expand" }, EXIT.error);
        const before = await capture(window, { shot: false, text: true });
        const index = resolveElementIndex(before.state.accessibility?.tree ?? "");
        await sky.perform_secondary_action({ window: { app: window.app, id: window.id }, element_index: index, action });
        const after = await captureAfter(window, { shot: wantShot, text: true, save: wantShot });
        emit({
          ok: true,
          command,
          window: after.state?.window ?? window,
          element: index,
          action,
          screenshot: after.screenshot,
          warning: after.warning ?? undefined,
          accessibility: treePayload(after.state, includeTree),
        });
      });
      return;
    }

    default:
      die({ error: "unknown_command", command, hint: "Run: node cua.mjs help" }, EXIT.error);
  }
}

try {
  await main();
  process.exit(EXIT.ok);
} catch (error) {
  handleActionError(error);
}
