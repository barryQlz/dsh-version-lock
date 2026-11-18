#!/usr/bin/env node
/**
 * dsh-version-lock — standalone rollback.
 *
 * The plugin already reverts everything when it is switched off in
 * Settings → Plugins. This script is the manual escape hatch for the case where
 * the plugin was disabled by editing the profile YAML while the app was closed
 * (so no disposer ever ran):
 *
 *   node restore.mjs            # revert using %DSH_HOME%/dsh-version-lock/state.json
 *   node restore.mjs --check    # only report what it would do
 */

import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

const PLUGIN = 'dsh-version-lock'
const FEED_FILE = 'app-update.yml'
const FEED_PARKED = `${FEED_FILE}.${PLUGIN}`
const MENU_NEEDLE = 'label: currentDesktopLocale().messages.checkUpdatesMenu,'
const MENU_INSERT = `visible: false, /* ${PLUGIN} */ `

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

function journalPath() {
  return join(dshHome(), PLUGIN, 'state.json')
}

function digestOf(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch {
    return undefined
  }
}

const checkOnly = process.argv.includes('--check')
const result = { menu: 'skipped', feed: 'skipped', policy: 'skipped' }

let journal = {}
try {
  journal = JSON.parse(readFileSync(journalPath(), 'utf8'))
} catch {
  journal = {}
}

if (journal.root === undefined && journal.menu === undefined && journal.policy === undefined) {
  console.log(`${PLUGIN}: no journal at ${journalPath()} — nothing recorded, nothing to do`)
}

// 1. menu item
const menu = journal.menu
if (menu !== undefined && menu.patched === true && typeof menu.file === 'string' && existsSync(menu.file)) {
  const text = readFileSync(menu.file, 'utf8')
  const patched = MENU_INSERT + MENU_NEEDLE
  if (!text.includes(patched)) {
    result.menu = 'clean'
  } else if (checkOnly) {
    result.menu = 'would-restore'
  } else {
    writeFileSync(menu.file, text.split(patched).join(MENU_NEEDLE), 'utf8')
    result.menu = 'restored'
  }
}

// 2. update feed
const root = typeof journal.root === 'string' ? journal.root : undefined
if (root !== undefined) {
  const live = join(root, FEED_FILE)
  const parked = join(root, FEED_PARKED)
  if (existsSync(parked) && !existsSync(live)) {
    if (checkOnly) {
      result.feed = 'would-restore'
    } else {
      renameSync(parked, live)
      result.feed = 'restored'
    }
  } else if (existsSync(parked) && existsSync(live)) {
    result.feed = 'both-present'
  } else {
    result.feed = 'clean'
  }
}

// 3. mandatory-update policy
const policy = journal.policy
if (policy !== undefined && policy.patched === true) {
  const { file, backup, sha256 } = policy
  if (typeof file !== 'string' || typeof backup !== 'string' || !existsSync(backup)) {
    result.policy = 'clean'
  } else if (!existsSync(file)) {
    result.policy = 'missing'
  } else if (digestOf(file) !== sha256) {
    result.policy = 'changed-since'
  } else if (checkOnly) {
    result.policy = 'would-restore'
  } else {
    copyFileSync(backup, file)
    result.policy = 'restored'
  }
}

if (!checkOnly) {
  try {
    rmSync(journalPath(), { force: true })
  } catch {
    /* ignore */
  }
}

console.log(JSON.stringify({ plugin: PLUGIN, checkOnly, journal: journalPath(), result }, null, 2))
