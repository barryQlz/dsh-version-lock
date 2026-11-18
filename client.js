/**
 * dsh-version-lock — Client half.
 *
 * The Desktop update entry is rendered by `dsh-client-ui-settings-general`
 * from `globalThis.dshDesktop.updates`: the sidebar indicator, the badge on the
 * sidebar toggle, and the “Update / 新版本” prompt all stay invisible while the
 * presentation phase is `idle`. This module therefore makes the isolated
 * Electron bridge look permanently idle — by replacing it, or by rewriting its
 * `updates` carrier when the property is read-only — and keeps a DOM guard as
 * the last line of defence.
 *
 * Nothing is written to disk here, so switching the plugin off (or reloading
 * the page) restores the real bridge and the real entries immediately.
 */

window.__ModuleLoader__.load({
  id: 'dsh-version-lock',
  factory() {
    const name = 'dsh-version-lock'
    const IDLE = { phase: 'idle' }
    const HIDDEN_ATTR = 'data-dsh-version-lock'

    /** Visible copy of every Desktop update phase, both shipped locales. */
    const HIDE_MATCHERS = [
      /^新版本$/u,
      /^重试更新$/u,
      /^正在检查更新…$/u,
      /^正在校验更新文件…$/u,
      /^正在准备重启…$/u,
      /^安装并重启$/u,
      /^正在下载更新/u,
      /^Update$/u,
      /^Retry update$/u,
      /^Checking for updates…$/u,
      /^Verifying update files…$/u,
      /^Preparing to restart…$/u,
      /^Install and Restart$/u,
      /^Downloading update/u,
    ]

    function matchesUpdateCopy(value) {
      const text = typeof value === 'string' ? value.trim() : ''
      if (text === '') return false
      return HIDE_MATCHERS.some((pattern) => pattern.test(text))
    }

    function idleUpdates() {
      const updates = {
        status: () => Promise.resolve(IDLE),
        open: () => Promise.resolve(),
        subscribe: () => () => {},
      }
      updates.status.__dshVersionLock = true
      updates.open.__dshVersionLock = true
      updates.subscribe.__dshVersionLock = true
      return updates
    }

    /** Best-effort: make `globalThis.dshDesktop.updates` answer idle forever. */
    function installBridgeStub() {
      const original = globalThis.dshDesktop
      const restoreCallbacks = []
      const stubUpdates = idleUpdates()

      // A. Replace the exposed object outright: plain assignment first, then a
      //    fresh property descriptor — `exposeInMainWorld` differs per Electron
      //    build, so both paths are tried and both are verified by identity.
      let method = 'none'
      const descriptor = (() => {
        try {
          const own = Object.getOwnPropertyDescriptor(globalThis, 'dshDesktop')
          return own === undefined
            ? null
            : {
                configurable: own.configurable === true,
                writable: own.writable === true,
                enumerable: own.enumerable === true,
                accessor: typeof own.get === 'function' || typeof own.set === 'function',
              }
        } catch {
          return null
        }
      })()
      const stub = {}
      if (original !== null && typeof original === 'object') {
        for (const key of Object.keys(original)) {
          try {
            stub[key] = original[key]
          } catch {
            /* an unreadable member stays absent */
          }
        }
      }
      stub.protocolVersion = 1
      stub.updates = stubUpdates

      try {
        globalThis.dshDesktop = stub
        if (globalThis.dshDesktop === stub) method = 'assigned'
      } catch {
        /* non-writable */
      }
      if (method === 'none') {
        try {
          Object.defineProperty(globalThis, 'dshDesktop', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: stub,
          })
          if (globalThis.dshDesktop === stub) method = 'defined'
        } catch {
          /* the property may reject redefinition */
        }
      }
      if (method !== 'none') {
        restoreCallbacks.push(() => {
          try {
            globalThis.dshDesktop = original
            if (globalThis.dshDesktop !== original) {
              Object.defineProperty(globalThis, 'dshDesktop', {
                configurable: true,
                enumerable: true,
                writable: true,
                value: original,
              })
            }
          } catch {
            /* ignore */
          }
        })
      }

      // B. Rewrite the carrier in place when the bridge itself is immutable.
      if (method === 'none' && original !== null && typeof original === 'object') {
        const live = original.updates
        if (live !== null && typeof live === 'object') {
          const previous = {
            status: live.status,
            open: live.open,
            subscribe: live.subscribe,
          }
          try {
            live.status = stubUpdates.status
            live.open = stubUpdates.open
            live.subscribe = stubUpdates.subscribe
            if (
              live.status === stubUpdates.status &&
              live.open === stubUpdates.open &&
              live.subscribe === stubUpdates.subscribe
            ) {
              method = 'mutated'
              restoreCallbacks.push(() => {
                try {
                  live.status = previous.status
                  live.open = previous.open
                  live.subscribe = previous.subscribe
                } catch {
                  /* ignore */
                }
              })
            }
          } catch {
            /* frozen carrier */
          }
        }
      }

      return {
        method,
        descriptor,
        updatesFrozen: (() => {
          try {
            return original !== null && typeof original === 'object' && original.updates !== undefined
              ? Object.isFrozen(original.updates)
              : null
          } catch {
            return null
          }
        })(),
        restore() {
          for (const undo of restoreCallbacks) {
            try {
              undo()
            } catch {
              /* ignore */
            }
          }
          restoreCallbacks.length = 0
        },
      }
    }

    /** Last line of defence: hide any update affordance that still paints. */
    function installDomGuard() {
      if (typeof document === 'undefined') return () => {}
      let timer = 0
      let observer

      const sweep = () => {
        try {
          const nodes = document.querySelectorAll('button[aria-label], span[role="img"][aria-label]')
          for (const node of nodes) {
            if (node.getAttribute(HIDDEN_ATTR) === 'hidden') continue
            if (matchesUpdateCopy(node.getAttribute('aria-label')) || matchesUpdateCopy(node.textContent)) {
              node.style.setProperty('display', 'none', 'important')
              node.setAttribute(HIDDEN_ATTR, 'hidden')
            }
          }
        } catch {
          /* a detached document ends the sweep */
        }
      }

      // Trailing debounce: streaming chat output mutates the tree on every
      // token, and one sweep per 200 ms is more than the sidebar needs.
      const schedule = () => {
        if (timer !== 0) return
        timer = setTimeout(() => {
          timer = 0
          sweep()
        }, 200)
      }

      sweep()
      try {
        observer = new MutationObserver(schedule)
        observer.observe(document.documentElement ?? document, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['aria-label'],
        })
      } catch {
        observer = undefined
      }

      return () => {
        try {
          observer?.disconnect()
        } catch {
          /* ignore */
        }
        if (timer !== 0) clearTimeout(timer)
        timer = 0
        try {
          for (const node of document.querySelectorAll(`[${HIDDEN_ATTR}="hidden"]`)) {
            node.style.removeProperty('display')
            node.removeAttribute(HIDDEN_ATTR)
          }
        } catch {
          /* ignore */
        }
      }
    }

    function report(payload) {
      try {
        const body = JSON.stringify({ at: new Date().toISOString(), plugin: name, ...payload })
        void fetch('/dsh-version-lock/report', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body,
        }).catch(() => {})
      } catch {
        /* diagnostics must never break the pin */
      }
    }

    function apply(ctx) {
      const bridge = installBridgeStub()
      const stopGuard = installDomGuard()
      const snapshot = {
        bridge: bridge.method,
        bridgeProperty: bridge.descriptor,
        updatesFrozen: bridge.updatesFrozen,
        guard: true,
        protocolVersion: globalThis.dshDesktop?.protocolVersion ?? null,
        href: typeof location === 'undefined' ? null : location.href,
      }
      try {
        globalThis.__DSH_VERSION_LOCK__ = { ...snapshot, at: new Date().toISOString() }
      } catch {
        /* ignore */
      }
      report(snapshot)

      ctx.effect(
        () => () => {
          stopGuard()
          bridge.restore()
          try {
            delete globalThis.__DSH_VERSION_LOCK__
          } catch {
            /* ignore */
          }
          report({ ...snapshot, bridge: 'released', guard: false })
        },
        'dsh-version-lock: desktop update suppression',
      )
    }

    return { name, inject: [], apply }
  },
})
