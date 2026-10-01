# Changelog

All notable changes to **AM Code** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/):

- **patch** (`0.1.2 → 0.1.3`) — bug fixes, wording, small polish
- **minor** (`0.1.3 → 0.2.0`) — new features, backwards compatible
- **major** (`0.2.0 → 1.0.0`) — breaking changes (settings renamed, removed features)

---

## [0.4.0] — 2026-10-01

### Fixed — the desktop app behaves like a real Windows program
- **Every question is now asked inside the app.** The model wizard no longer opens VS Code style
  input-box windows: *Add model* opens the panel's Models screen with the form focused, key prompts are
  inline rows, and quick picks (tool calling, images, folder, …) are in-app lists. Nothing pops a
  separate window any more.
- **The window is always visible and in the taskbar** — `setAppUserModelId`, window bounds remembered
  between runs, and a watchdog that shows the window even if the renderer is slow (an invisible process
  could keep running before).
- **Quitting really quits.** `before-quit`/`will-quit` now stop the agent, dispose every MCP server,
  terminate tracked child processes (`taskkill /T` on Windows) and force-exit after 1.5 s. No more
  `node.exe` / MCP servers left behind in Task Manager.
- **First run is self-explanatory**: with no model configured the app opens the Models screen and shows
  a welcome toast, instead of a notification that could be missed.
- MCP stdio servers accept `args` as either an array or a single string (hand-edited config files no
  longer hang the connection until the 25 s timeout).

### Added — game-engine MCP presets 🎮
One-click setups for the engines people actually ship games with:

| Preset | What it connects to |
| --- | --- |
| **Godot 4 (editor control)** | `npx -y godot-mcp-server` — scenes, nodes, scripts, playtests inside the open editor (needs the “Godot MCP” plugin enabled) |
| **Unity 6 (MCP Bridge)** | `npx -y unity-mcp-bridge` — Unity 6 editor package talks over TCP; port auto-discovery |
| **Unity 2020.3+ (mcp-unity plugin)** | `npx -y @akiojin/unity-mcp-server@latest` — the plugin route, TCP 6400 |
| **Unreal Engine 5 (run python)** | `uvx --from git+…/mcp-unreal mcp-unreal` — runs python inside the open UE 5.5+ editor |
| **Unreal Engine 5 (UnrealMCP plugin)** | `uv … unreal_mcp_server_advanced.py` — full actor/blueprint control via the UnrealMCP plugin |

All five open the in-app MCP screen, fill command, arguments, environment variables and a hint that
explains which editor-side plugin to install first. Also: `settingsShow`, `refreshWorkspace` and
`inlinePrompt` messages replace the remaining host-side dialogs; the Settings/Token-saver/About menu
entries now open the corresponding in-app screens.

### Tests
- Panel suite grew to 18: first-run flow, in-app input/pick prompts, game-engine presets
  (Godot fills command + args + env). Total: **59**.

## [0.3.0] — 2026-10-01

### Added
- **Token saver** (`agentcode.tokenSaver` = `off | balanced | aggressive`) — every provider request is
  compressed before it leaves the machine: large tool results are digested to head + tail with an honest
  "N lines omitted" marker, repeated identical output collapses to a pointer, file reads that were
  superseded by a newer read are dropped, screenshots older than the protected tail are removed, and
  ANSI colours / CRLF / blank-line runs are stripped. The saved session and the on-disk transcript are
  never modified, pairing rules stay valid (a tool result is never separated from its call) and the
  result is deterministic (prompt-cache friendly). Fine-grained knobs: `tokenSaverKeepRecent`,
  `tokenSaverMaxToolChars`, `tokenSaverDedupe`, `tokenSaverDropImages`.
- **Tokens screen** in the panel: pick the mode, tune the knobs, press *Analyse this session* to see what
  would be saved right now, and watch live numbers (tokens before → after, % saved, what was squeezed).
  The status line under the composer shows a live "saved N (P%)" chip.
- **General screen** in the panel — the agent settings that used to live only in `settings.json` are now
  editable in the UI (mode, work style, tool calling, max steps, soft budget, command timeout, reply
  language, approval style, all permission toggles, context/diagnostics/reasoning switches, custom
  instructions). The host validates every value against an allow-list.
- Blocky **AM CODE wordmark** in the hero (generated SVG in `media/wordmark.svg`), OpenCode-style hero
  spacing and centered status line in the full-window layout.
- **Ready-to-install Windows build**: `AM-Code-Setup-0.3.0.exe` (NSIS installer, per-user, no admin
  rights, desktop + start-menu shortcuts) and a portable build script; `resources/icon.ico` is created
  from the AM Code logo so the installer, the exe and the shortcuts all carry it.

### Changed
- The wide ("ultra") layout now uses compact work-mode chips and hides the redundant section headings,
  matching the OpenCode reference screenshot more closely.
- Session tabs only appear when there is more than one session.

### Tests
- New `test/tokenSaver.test.ts` (11 tests) including an end-to-end assertion that what actually goes
  **over the wire** is smaller while the stored transcript keeps the full output. Panel suite grew to 15
  (Tokens + General screens). Total: **55**.

## [0.2.0] — 2026-09-30

### Added
- **MCP (Model Context Protocol) support** with a graphical screen: presets (Filesystem, GitHub, Fetch,
  Memory, Playwright, SQLite, remote HTTP), stdio + streamable-HTTP/SSE transports, `KEY=VALUE` env and
  `Header: value` editors, tool filters (`read_*`), per-server auto-approve, enable/disable, one-click
  **Test** that reports the server name/version and its tools, and inline remove confirmation.
  Tokens go to Secret Storage and are injected at connect time. New commands: `AM Code: MCP Servers…`
  (`Ctrl+Alt+M`) and `AM Code: Refresh MCP Servers`; new setting `agentcode.mcpServers`.
- **OpenCode-style full-window layout** (`agentcode.interfaceLayout` = `auto | panel | ultra`):
  session tab bar (open/close sessions), large wordmark hero, centered glass composer with an arrow send
  button, and a status line under it — `workspace folder · git branch · active model · MCP servers/tools`,
  plus live step/token chips and a ready/working indicator. A new **Settings → Interface** tab switches
  layouts and shows the about panel.
- **Desktop app for Windows/Linux/macOS** (`desktop/`, Electron): runs the *same* agent engine and panel
  through a `vscode` shim, with its own menu, project folder picker, background terminal window,
  `safeStorage`-encrypted secrets and NSIS/AppImage/DMG packaging. GitHub workflow
  `.github/workflows/desktop-release.yml` builds the installers on demand or on a version tag.
- The `+` button in the composer is now an add-menu (image / model / MCP server / project rules).
- A model chip in the composer for switching models without leaving the chat.
- `DESKTOP.md` (Persian) — how to build and ship the Windows installer.

### Changed
- Replaced every `window.prompt`/`window.confirm` with inline panel rows (set/replace key, remove model,
  remove MCP server) — those browser dialogs do not exist in VS Code webviews or Electron.
- The settings overlay is now tabbed (**Models · MCP · Interface**) and keeps whatever you are typing when
  the agent pushes a state update.
- Settings screen footer adapts to the host: *Open VS Code settings* vs. *Open config file*.

### Fixed
- Panel messages posted before the window existed were dropped (desktop startup showed an empty composer).
- Textareas (MCP env/headers) did not follow the panel input styling.

### Tests
- New `test/mcp.test.ts` (10 tests) with a real stdio MCP server fixture (`test/fixtures/mcp-server.js`)
  and a live HTTP MCP server, covering naming, discovery, calls, failures, filters, disabled servers and
  agent routing. Panel suite grew to 12 tests. Total: **42**.

## [0.1.2] — 2026-09-30

### Added
- **Graphical Models screen** inside the panel: add, edit, test, set key and remove models in one place —
  no more one-question-at-a-time VS Code wizards. Includes *Load list* (`GET /models`) and
  *Save & test connection*.
- New logo (AM monogram) and the author credit **@AM0_0dev** in the panel footer, the Models screen and
  the settings menu (links to `t.me/AM0_0dev`).
- Open-source scaffolding: `LICENSE` (MIT), `.gitignore`, GitHub Actions **CI** and **Release VSIX**
  workflows, `.vscode/launch.json` (F5 debugging), `README.en.md`, `PUBLISHING.md`, this changelog.
- `npm run publish` and `npm run release` helper scripts.

### Fixed
- The Stop button was visible while the agent was idle (CSS specificity vs. the `hidden` attribute).
- The agent kept working and burning tokens after a simple greeting or a question — it now classifies
  conversation vs. work, with read-only loop guards and a soft step budget.
- Slash (`/`) and mention (`@`) menus were destroyed by opening any popup menu.
- The settings menu closed itself on the click that opened it.

## [0.1.1] — 2026-09-30

### Fixed
- Idle turns kept looping (token burn) and the Send/Stop buttons were both rendered.
- The step counter chip stayed at `0/40`.

### Added
- Read-only guard (warn after 3 steps, stop after 8), `agentcode.softStepBudget`, and budget rules
  in the system prompt.

## [0.1.0] — 2026-09-30

### Added
- First release: agentic loop with Plan/Build modes, live task checklist with ticks, approval cards with
  diff previews, file + terminal + LSP tools, research sub-agents, context compaction, sessions,
  and full bring-your-own-model support via **Base URL + Model ID** (OpenAI-compatible + Anthropic).

[0.4.0]: https://github.com/Araz0-0dev/am-code/releases/tag/v0.4.0
[0.3.0]: https://github.com/Araz0-0dev/am-code/releases/tag/v0.3.0
[0.2.0]: https://github.com/Araz0-0dev/am-code/releases/tag/v0.2.0
[0.1.2]: https://github.com/Araz0-0dev/am-code/releases/tag/v0.1.2
[0.1.1]: https://github.com/Araz0-0dev/am-code/releases/tag/v0.1.1
[0.1.0]: https://github.com/Araz0-0dev/am-code/releases/tag/v0.1.0
