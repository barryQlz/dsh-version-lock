# dsh-version-lock · 版本锁定（关闭更新）

把 **DeepSeek Harness 桌面版**钉死在当前版本：不再出现「新版本」角标与「检查更新…」入口，不再检查 / 下载 / 安装更新，也不会被服务端「该版本已停止支持」的阻断页赶下车。

**在「设置 → 插件」里关掉本插件，它改过的每个文件都会逐字节还原**，不留残留。

- 许可证：MIT，免费、可改、可再分发
- 适用：`@deepseek-ai/dsh-desktop` 0.2.1-rc.2（profile `desktop`），其他版本按下面「兼容性」判断
- 不联网、不上报、不碰账号数据；只操作本机安装目录里的 3 个文件

---

## 为什么需要它

桌面外壳里更新是三条独立路径，任意一条都能打断“我就想用这个版本”：

1. **nightly feed 轮询**：启动时 + 每 10 分钟（`DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS`）+ 系统唤醒时查一次 `download.deepseek.com`，一有新版本就在侧边栏画出「新版本」角标，并提供下载 / 安装并重启。
2. **应用菜单项**：「检查更新…」直接调 `openUpdatePrompt(true)`，手工触发检查。
3. **强制更新策略**：`resources/app/package.json` 里的 `dshMandatoryUpdatePolicy` 让外壳去 `harness.deepseek.com` 问“这个版本还能不能用”，返回不支持时会盖一层不可关闭的「请更新后继续使用」。

注意：`autoDownload` / `autoInstallOnAppQuit` 本来就是 `false`，所以“自动更新”的危险不在静默安装，而在**这条随时可能弹出来、且可能直接封死应用的通道**。本插件把这三条一起拿掉。

## 它改了什么

| # | 配置项 | 落点 | 效果 | 生效 |
|---|--------|------|------|------|
| 1 | `patchFeed` | `resources/app-update.yml` → `resources/app-update.yml.dsh-version-lock` | 外壳构造 `DesktopUpdateCoordinator` 时的 `enabled()` 探针为假 ⇒ **一次 feed 请求都不发**；无 candidate ⇒ 无下载、无安装、无状态发布 | 下次启动 |
| 2 | `hideMenu` | `resources/app/lib/main.js` 的菜单项前插入 `visible: false` | 应用菜单弹层里「检查更新…」整条隐藏（连它点出来会报错的对话框都不会再有） | 下次启动 |
| 3 | `disableMandatoryPolicy` | 从 `resources/app/package.json` 删除 `dshMandatoryUpdatePolicy` | 强制更新策略整条不加载，阻断页不可能出现 | 下次启动 |
| 4 | 客户端半边 | 页面内拦截 `globalThis.dshDesktop.updates` + DOM 守卫 | 侧边栏角标 / 状态条 / 更新文案即时不渲染 | 页面加载即生效 |

第 4 条的实测结论：`contextBridge` 暴露的 `dshDesktop` 是 `configurable:false, writable:false`，且 `updates` 载体被冻结，页面侧**无法**把它替换成“永远 idle”的假桥，所以这一层只能做 DOM 守卫（按 `aria-label` / 文案精确匹配隐藏 `button` 与 `span[role=img]`）。真正“入口不存在”由前三条文件层保证。

每条改动在落地前都会先写入账本 `%DSH_HOME%\dsh-version-lock\state.json`（含原文件 sha256、插入标记、备份路径），还原时按账本反做。

## 安装

前置：已安装 Desktop 版（默认 `%LOCALAPPDATA%\Programs\DeepSeek Harness`），profile 为 `desktop`。

1) 取源码到本地：

```powershell
git clone https://github.com/barryQlz/dsh-version-lock.git D:\tools\dsh-version-lock
```

2) 让 Harness 自己装（推荐，`install_bundle` 会写 profile 的 `package.json` / `cordis.patch.yml` 并激活，别手工改这些文件）：

对 Harness 里的 Agent 说：

> 用 plugin_manager 的 install_bundle 安装 `D:\tools\dsh-version-lock`

等价调用：

```json
{ "action": "install_bundle", "target": "D:\\tools\\dsh-version-lock" }
```

成功标准：返回 `application: "applied"`、`warnings: []`；随后插件行 ID 为 `include:dsh-version-lock`。

3) 重启一次 Harness。文件层的三处改动只在下一次启动时体现（当前进程里跑的还是旧 `main.js`）；页面层已经即时生效。

> 也可以直接用仓库 tarball（`dsh.install.tarball` 已写好）：安装目标填
> `https://codeload.github.com/barryQlz/dsh-version-lock/tar.gz/refs/heads/main`。

## 配置

四个开关都在 profile 的 `cordis.patch.yml` 里这一行：

```yaml
- insert:
    - id: dsh-version-lock
      name: dsh-version-lock
      config:
        patchFeed: true              # 停用更新源（推荐）
        hideMenu: true               # 隐藏「检查更新…」菜单项
        disableMandatoryPolicy: true # 关掉强制更新策略
        debugLog: true               # 写 %DSH_HOME%\dsh-version-lock\version-lock.log
```

改完重载插件即「先还原、再按新配置重做」。想只隐藏界面而保留检查能力，就把 `patchFeed` 设为 `false`。

## 自检

```powershell
# 状态 + 账本（本地 Host 端口，端口见 $env:DSH_WEB_URL）
curl http://127.0.0.1:6072/dsh-version-lock/state

# 日志与账本
%USERPROFILE%\.dsh\dsh-version-lock\version-lock.log
%USERPROFILE%\.dsh\dsh-version-lock\state.json
```

日志里两行关键记录：

```
apply:  {"root":"...\\resources","feed":"parked","menu":"patched","policy":"patched", ...}
client: {"bridge":"none","bridgeProperty":{"configurable":false,"writable":false},"updatesFrozen":true,"guard":true, ...}
```

## 停用 / 还原

- **正常姿势**：「设置 → 插件」把 `dsh-version-lock` 关掉。disposer 立刻把三处文件还原并清空账本（这一圈做了两轮往返实测：`revert: {"menu":"restored","feed":"restored","policy":"restored"}`），重启后菜单项与更新检查全部回来。
- **兜底**：如果你是在应用**关闭**时手改 profile YAML 把它禁用的（disposer 没机会跑），用仓库里的独立脚本：

```powershell
node D:\tools\dsh-version-lock\restore.mjs --check   # 只报告
node D:\tools\dsh-version-lock\restore.mjs           # 按账本反做
```

- **一次性备份**（插件自动还原之外的手工保险）：

```
resources\app-update.yml.dsh-version-lock            ← 原名就是 app-update.yml
resources\app\lib\main.js.dsh-version-lock.bak
resources\app\package.json.dsh-version-lock.bak
```

## 兼容性与注意事项

- 只在 **Desktop（Electron）** 结构上动手；当 `resources/app` 或 `app-update.yml` 不存在（web / headless / sdk profile）时插件是安全 no-op，只在日志里记一行。
- 安装根按 `process.execPath` → `DSH_DESKTOP_NODE_EXECUTABLE` → `%LOCALAPPDATA%\Programs\DeepSeek Harness` → `%ProgramFiles%\DeepSeek Harness` 顺序探测，装在别的盘符请确保能从 `process.execPath` 推导出来。
- **升级外壳后**（手工重装安装包）这三个文件会被覆盖：插件下次启动按文本特征自愈重打，账本哈希随之更新。
- `main.js` 只做单行前缀插入，与 [dsh-purge](https://github.com/HunYiSage/dsh-purge) 之类的 pattern 补丁区域不重叠；若对方之后整体还原了 `main.js`，本插件下次启动会重新打上，且**不会**用旧备份覆盖别人的补丁（还原只走逆向编辑）。
- **不在范围**：插件市场 / 插件管理器里「插件有新版本」属于 bundle 升级（`dsh-client-ui-plugin-manager`），与应用本体更新无关。
- 这是一个“把更新通道关掉”的工具，代价自负：之后不会再有安全修复与功能更新，请自行决定何时手工升级（先关插件 → 重装/升级 → 需要时再开）。

## English

`dsh-version-lock` pins the installed DeepSeek Harness **Desktop** build. While enabled it (1) parks `resources/app-update.yml` so the shell's updater reports no packaged update source, (2) hides the “Check for Updates…” application-menu item, and (3) removes `dshMandatoryUpdatePolicy` from the shell manifest so the server-driven “this version is no longer supported” screen cannot lock the app out. A client half keeps the sidebar update badge from rendering.

Every change is journaled under `%DSH_HOME%\dsh-version-lock\state.json` before it is written and reverted by the plugin disposer, i.e. when the row is switched off, or by `node restore.mjs` when the plugin was disabled while the app was closed. Restoration is an inverse edit, never a whole-file overwrite, so unrelated patches to the same files survive.

Requires `@deepseek-ai/dsh-desktop` 0.2.1-rc.2 with profile `desktop`. MIT licensed.

## License

[MIT](LICENSE) © 2026 barryQlz
