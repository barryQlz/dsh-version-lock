/**
 * dsh-version-lock — Host half.
 *
 * While this plugin is enabled it pins the installed Desktop build:
 *
 * 1. `patchFeed`  — parks `resources/app-update.yml`, so the Electron shell's
 *    `enabled()` probe fails: no feed check, no download, no install, and the
 *    periodic (`DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS`) polling can never
 *    publish an update state.
 * 2. `hideMenu`   — inserts `visible: false` in front of the shell's
 *    “Check for Updates…” menu item, so the application-menu popup no longer
 *    offers the entry (and cannot raise its error dialog).
 * 3. `disableMandatoryPolicy` — drops `dshMandatoryUpdatePolicy` from
 *    `resources/app/package.json`, so the server-driven “this version is no
 *    longer supported” screen cannot lock the build out.
 *
 * Every change is journaled under `$DSH_HOME/dsh-version-lock/` before it is
 * written, and reverted by the plugin disposer, i.e. when the row is switched
 * off in Settings → Plugins or its config changes. Restoration is an inverse
 * edit (not a whole-file overwrite) wherever that is possible, so unrelated
 * patches to the same file survive.
 *
 * A small local HTTP surface keeps the page and the operator informed:
 *   GET  /dsh-version-lock/state   → journal, resolved install root, log path
 *   POST /dsh-version-lock/report  → one client-side line appended to the log
 */

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

const PLUGIN = 'dsh-version-lock'
const FEED_FILE = 'app-update.yml'
const FEED_PARKED = `${FEED_FILE}.${PLUGIN}`
const MENU_NEEDLE = 'label: currentDesktopLocale().messages.checkUpdatesMenu,'
const MENU_INSERT = `visible: false, /* ${PLUGIN} */ `
const POLICY_KEY = 'dshMandatoryUpdatePolicy'
const DEFAULTS = {
  patchFeed: true,
  hideMenu: true,
  disableMandatoryPolicy: true,
  debugLog: true,
}

/* ── small utilities ─────────────────────────────────────────────────── */

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

function stateDir() {
  return join(dshHome(), PLUGIN)
}

function journalPath() {
  return join(stateDir(), 'state.json')
}

function logPath() {
  return join(stateDir(), 'version-lock.log')
}

function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* the log/journal writers tolerate a missing directory */
  }
}

function digestOf(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return undefined
  }
}

function readJournal() {
  try {
    const parsed = JSON.parse(readFileSync(journalPath(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveJournal(journal) {
  ensureDir(stateDir())
  journal.plugin = PLUGIN
  journal.updatedAt = new Date().toISOString()
  try {
    writeFileSync(journalPath(), `${JSON.stringify(journal, null, 2)}\n`, 'utf8')
  } catch {
    /* a read-only DSH_HOME must not break the pin itself */
  }
}

function clearJournal() {
  try {
    rmSync(journalPath(), { force: true })
  } catch {
    /* ignore */
  }
}

function logLine(options, line) {
  if (options !== undefined && options.debugLog === false) return
  try {
    ensureDir(stateDir())
    const file = logPath()
    try {
      if (statSync(file).size > 1024 * 1024) renameSync(file, `${file}.1`)
    } catch {
      /* no log yet, or the rotation lost a race */
    }
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* ignore */
  }
}

/* ── locating the installed Electron shell ───────────────────────────── */

function resourceRoots() {
  const roots = []
  const fromExe = (exe) => {
    if (typeof exe === 'string' && exe.length > 0) roots.push(join(dirname(exe), 'resources'))
  }
  fromExe(process.execPath)
  fromExe(process.env.DSH_DESKTOP_NODE_EXECUTABLE)
  if (typeof process.env.LOCALAPPDATA === 'string') {
    roots.push(join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources'))
  }
  if (typeof process.env.ProgramFiles === 'string') {
    roots.push(join(process.env.ProgramFiles, 'DeepSeek Harness', 'resources'))
  }
  const seen = new Set()
  return roots.filter((root) => {
    const key = root.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function looksLikeShell(root) {
  try {
    return (
      existsSync(join(root, 'app', 'package.json')) ||
      existsSync(join(root, 'app', 'lib', 'main.js')) ||
      existsSync(join(root, 'app.asar')) ||
      existsSync(join(root, FEED_FILE)) ||
      existsSync(join(root, FEED_PARKED))
    )
  } catch {
    return false
  }
}

function resolveShell() {
  for (const root of resourceRoots()) {
    if (looksLikeShell(root)) return root
  }
  return undefined
}

/* ── 1. park the update feed ─────────────────────────────────────────── */

function ensureFeedParked(root, journal) {
  const live = join(root, FEED_FILE)
  const parked = join(root, FEED_PARKED)
  const liveExists = existsSync(live)
  const parkedExists = existsSync(parked)

  if (!liveExists && parkedExists) {
    journal.feed = { parked: true, sha256: digestOf(parked) ?? journal.feed?.sha256 }
    saveJournal(journal)
    return 'already'
  }
  if (!liveExists && !parkedExists) return 'no-feed'

  const sha256 = digestOf(live)
  journal.feed = { parked: false, sha256 }
  saveJournal(journal)
  try {
    if (parkedExists) rmSync(parked, { force: true })
    renameSync(live, parked)
  } catch (error) {
    return `failed: ${describeError(error)}`
  }
  journal.feed = { parked: true, sha256: digestOf(parked) ?? sha256 }
  saveJournal(journal)
  return 'parked'
}

/* ── 2. hide the “Check for Updates…” menu item ────────────────────────────────── */

function ensureMenuHidden(root, journal) {
  const file = join(root, 'app', 'lib', 'main.js')
  if (!existsSync(file)) return 'no-main-js'

  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return `failed: ${describeError(error)}`
  }

  const already = text.split(MENU_INSERT + MENU_NEEDLE).length - 1
  if (already > 0) {
    journal.menu = { patched: true, file, insert: MENU_INSERT }
    saveJournal(journal)
    return 'already'
  }

  const hits = text.split(MENU_NEEDLE).length - 1
  if (hits !== 1) return hits === 0 ? 'needle-missing' : `needle-x${hits}`

  const next = text.split(MENU_NEEDLE).join(MENU_INSERT + MENU_NEEDLE)
  if (next.length !== text.length + MENU_INSERT.length) return 'refused-length-check'

  const backup = `${file}.${PLUGIN}.bak`
  try {
    if (!existsSync(backup)) writeFileSync(backup, text, 'utf8')
    writeFileSync(file, next, 'utf8')
  } catch (error) {
    return `failed: ${describeError(error)}`
  }

  journal.menu = { patched: true, file, insert: MENU_INSERT, backup }
  saveJournal(journal)
  return 'patched'
}

/* ── 3. drop the mandatory-update policy ─────────────────────────────── */

function ensurePolicyDisabled(root, journal) {
  const file = join(root, 'app', 'package.json')
  if (!existsSync(file)) return 'no-manifest'

  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return `failed: ${describeError(error)}`
  }

  let manifest
  try {
    manifest = JSON.parse(text)
  } catch {
    return 'manifest-unreadable'
  }
  if (manifest === null || typeof manifest !== 'object' || !(POLICY_KEY in manifest)) {
    journal.policy = { patched: false }
    saveJournal(journal)
    return 'already'
  }

  const backup = `${file}.${PLUGIN}.bak`
  const next = { ...manifest }
  delete next[POLICY_KEY]
  try {
    if (!existsSync(backup)) writeFileSync(backup, text, 'utf8')
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch (error) {
    return `failed: ${describeError(error)}`
  }

  journal.policy = { patched: true, file, backup, sha256: digestOf(file) }
  saveJournal(journal)
  return 'patched'
}

/* ── revert everything the journal recorded ──────────────────────────── */

function revertJournal(journal, fallbackRoot, options) {
  const result = { menu: 'skipped', feed: 'skipped', policy: 'skipped' }

  const menu = journal.menu
  if (menu !== undefined && menu.patched === true && typeof menu.file === 'string') {
    if (!existsSync(menu.file)) {
      result.menu = 'clean'
    } else {
      try {
        const text = readFileSync(menu.file, 'utf8')
        const patched = MENU_INSERT + MENU_NEEDLE
        if (text.includes(patched)) {
          writeFileSync(menu.file, text.split(patched).join(MENU_NEEDLE), 'utf8')
          result.menu = 'restored'
        } else {
          result.menu = 'clean'
        }
      } catch (error) {
        result.menu = `failed: ${describeError(error)}`
      }
    }
  }

  const root = typeof journal.root === 'string' ? journal.root : fallbackRoot
  if (typeof root === 'string') {
    const live = join(root, FEED_FILE)
    const parked = join(root, FEED_PARKED)
    try {
      const parkedExists = existsSync(parked)
      const liveExists = existsSync(live)
      if (parkedExists && !liveExists) {
        renameSync(parked, live)
        result.feed = 'restored'
      } else if (parkedExists && liveExists) {
        result.feed = 'both-present'
      } else {
        result.feed = 'clean'
      }
    } catch (error) {
      result.feed = `failed: ${describeError(error)}`
    }
  }

  const policy = journal.policy
  if (policy !== undefined && policy.patched === true) {
    const { file, backup, sha256 } = policy
    if (typeof file !== 'string' || typeof backup !== 'string' || !existsSync(backup)) {
      result.policy = 'clean'
    } else if (!existsSync(file)) {
      result.policy = 'missing'
    } else {
      try {
        if (digestOf(file) === sha256) {
          copyFileSync(backup, file)
          result.policy = 'restored'
        } else {
          // Someone rewrote the manifest after us: leave it alone.
          result.policy = 'changed-since'
        }
      } catch (error) {
        result.policy = `failed: ${describeError(error)}`
      }
    }
  }

  logLine(options, `revert: ${JSON.stringify(result)}`)
  clearJournal()
  return result
}

/* ── HTTP surface for the page / operator ────────────────────────────── */

function sendJson(response, code, value) {
  const body = `${JSON.stringify(value, null, 2)}\n`
  try {
    response.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    response.end(body)
  } catch {
    /* the peer may already be gone */
  }
}

function readBody(request, limit = 16 * 1024) {
  return new Promise((resolve) => {
    let settled = false
    let size = 0
    let text = ''
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish('')
        request.destroy()
        return
      }
      text += chunk
    })
    request.on('end', () => finish(text))
    request.on('error', () => finish(''))
  })
}

function registerRoutes(ctx, options, snapshot) {
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    if (webServer === undefined) return

    webCtx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: `/${PLUGIN}/state`,
          handler: (_request, response) => {
            sendJson(response, 200, {
              plugin: PLUGIN,
              applied: snapshot,
              journal: readJournal(),
              journalPath: journalPath(),
              logPath: logPath(),
            })
          },
        }),
      `${PLUGIN}: state route`,
    )

    webCtx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: `/${PLUGIN}/report`,
          handler: async (request, response) => {
            const text = await readBody(request)
            let payload = text
            try {
              payload = JSON.stringify(JSON.parse(text))
            } catch {
              /* keep the raw text */
            }
            logLine(options, `client: ${payload.slice(0, 2000)}`)
            sendJson(response, 200, { ok: true })
          },
        }),
      `${PLUGIN}: report route`,
    )
  })
}

/* ── plugin entry ────────────────────────────────────────────────────── */

export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config !== null && typeof config === 'object' ? config : {}) }
  const journal = readJournal()
  const root = resolveShell()
  const snapshot = {
    root: root ?? null,
    feed: 'skipped',
    menu: 'skipped',
    policy: 'skipped',
    profile: process.env.DSH_PROFILE ?? null,
    execPath: process.execPath,
  }

  ctx.effect(() => {
    if (root === undefined) {
      logLine(options, 'apply: Desktop shell not found (browser/headless profile?), nothing to change')
    } else {
      journal.root = root
      saveJournal(journal)
      if (options.patchFeed === true) snapshot.feed = ensureFeedParked(root, journal)
      if (options.hideMenu === true) snapshot.menu = ensureMenuHidden(root, journal)
      if (options.disableMandatoryPolicy === true) snapshot.policy = ensurePolicyDisabled(root, journal)
      logLine(options, `apply: ${JSON.stringify(snapshot)}`)
    }

    return () => {
      revertJournal(readJournal(), root, options)
    }
  }, `${PLUGIN}: desktop update pin`)

  registerRoutes(ctx, options, snapshot)
}
