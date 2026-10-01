<div align="center">

<img src="media/icon.png" width="112" alt="AM Code">

# AM Code

**An agentic coding assistant with _your_ models, _your_ bill, no limits.**

[![CI](https://github.com/Araz0-0dev/am-code/actions/workflows/ci.yml/badge.svg)](https://github.com/Araz0-0dev/am-code/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/Araz0-0dev/am-code?color=blueviolet)](https://github.com/Araz0-0dev/am-code/releases/latest)
[![tests](https://img.shields.io/badge/tests-57%20passing-brightgreen)](test)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85-007ACC)](https://code.visualstudio.com/)
[![telegram](https://img.shields.io/badge/Telegram-%40AM0__0dev-2CA5E0?logo=telegram&logoColor=white)](https://t.me/AM0_0dev)

[Install](#install) · [Token saver](#why-am-code-saves-you-money) · [Screenshots](#screenshots) · [فارسی](README.md)

<img src="screenshots/desktop-home.png" width="860" alt="AM Code desktop">

</div>

---

## In 30 seconds

A real coding agent that lives in VS Code **and** as a standalone **Windows / Linux / macOS app**:

> **Plug in any model with `Base URL` + `Model ID` and the agent starts working.**
> OpenAI, OpenRouter, Groq, DeepSeek, Together, Mistral, xAI, Qwen, vLLM, LM Studio, Ollama —
> anything OpenAI-compatible, plus the native Anthropic API.

It works like Claude Code and OpenCode — **Plan/Build modes**, a **self-generated checklist that ticks
itself**, file edits, terminal runs, LSP diagnostics, research sub-agents, **MCP** — but there is no
subscription, no imposed model, and the whole UI speaks **Persian and English**.

---

## Why AM Code saves you money 💸

**Token saver** — unique to AM Code:

Every request is compressed **before it leaves your machine**. What burns your budget is rarely your
own words — it is everything that piles up around them and gets **re-sent on every step**: file
contents, command logs, MCP tool output, screenshots.

<div align="center">

```
before  28,061 tokens   →   after  9,689 tokens      65% smaller, same result
```

<sub>Measured on a real working session; the saver reported `4 repeated tool outputs collapsed to a pointer`</sub>

</div>

| Technique | What it does |
| --- | --- |
| 🧠 **Smart tool digests** | Big older tool results become head + tail with an honest "n lines omitted by AM Code" marker |
| 🔁 **Dedupe** | The same file or command read twice collapses into a one-line pointer to the newest copy |
| 🗂️ **Stale reads** | A file that was read again later drops its older version from the request |
| 🖼️ **Old screenshots** | Each image costs ~800 tokens — images older than the protected tail are not re-sent |
| 🧹 **Noise scrub** | ANSI colours, `\r` and blank-line runs are stripped |

**Safe by design:**

- ✅ The **saved session is never modified** — only the outgoing copy is compressed.
- ✅ A tool result is **never separated** from the tool call that produced it → strict APIs stay happy.
- ✅ Deterministic output → provider **prompt caching keeps working** (cheaper again).
- ✅ Three modes (**off / balanced / aggressive**), an *Analyse this session* button and live numbers.

<div align="center">
<img src="screenshots/desktop-tokens.png" width="820" alt="Tokens screen"><br>
<sub>Tokens screen: mode, fine-grained knobs, "Analyse this session" and live savings</sub>
</div>

---

## How it compares

| | AM Code | Claude Code | OpenCode |
| --- | :-: | :-: | :-: |
| Any model via `Base URL` + `Model ID` | ✅ unlimited | ❌ Anthropic only | ✅ |
| Per-request compression (**token saver**) | ✅ | ❌ (manual `/compact`) | ❌ |
| Windows desktop installer | ✅ | ❌ (terminal) | ⚠️ beta |
| Everything configurable in the UI | ✅ 5 screens | ❌ | ⚠️ config file |
| **MCP** with a graphical screen (stdio + HTTP/SSE) | ✅ | ✅ CLI | ✅ config |
| Self-generated live checklist | ✅ | ✅ | ✅ |
| Persian UI + replies | ✅ | ❌ | ❌ |
| Free & open source (MIT) | ✅ | ❌ | ✅ |

### Feature list

- 🧭 **Plan / Build** modes — Plan only reads and proposes; Build edits and runs.
- ✅ **Self-generated checklist** — the agent writes its own TODO list and ticks items as it works.
- 🗂️ **Approval cards** with real VS Code diffs (Approve / Always allow / Reject).
- 🖥️ **Terminal tool** with timeout, live output and its own approval card.
- 🔎 **Tools** — read/write/search files, grep, glob, LSP (diagnostics, definitions), web fetch.
- 🧑‍🔬 **Research sub-agent** with an isolated context that returns a single summary.
- 🧠 **Project memory** — your own rules that ride along in every prompt.
- 🗃️ **Sessions** — several at once in tabs, saved and restorable.
- 🛑 **No token burn** — a greeting gets *one* answer sweep (not 20 steps); pointless loops warn at 3 steps and stop at 8.
- ⚙️ **Five settings screens inside the panel** — Models · MCP · Tokens · General · Interface.

---

<div align="center">
<img src="screenshots/desktop-agent-run.png" width="820" alt="Agent run"><br>
<sub>A real run: checklist, MCP tool call and a completion card</sub>
</div>

## Screenshots

| Models screen | MCP screen |
| :-: | :-: |
| <img src="screenshots/desktop-models.png" width="410"> | <img src="screenshots/desktop-mcp.png" width="410"> |

Two layouts: **Panel** (docked beside your code) and **Ultra** (the whole window, OpenCode style) —
switch in `Settings → Interface`.

---

## Install

### 1) Desktop app — ready-to-run builds

| Platform | Direct download |
| --- | --- |
| 🪟 **Windows 10/11** | [**AM-Code-Setup-0.3.0.exe**](https://github.com/Araz0-0dev/am-code/releases/latest/download/AM-Code-Setup-0.3.0.exe) — per-user install, **no admin rights** |
| 🐧 **Linux** | [AM-Code-0.3.0.AppImage](https://github.com/Araz0-0dev/am-code/releases/latest/download/AM-Code-0.3.0.AppImage) — `chmod +x` and run |
| 🍎 **macOS (Apple Silicon)** | [AM-Code-0.3.0-arm64.dmg](https://github.com/Araz0-0dev/am-code/releases/latest/download/AM-Code-0.3.0-arm64.dmg) |

> If SmartScreen warns on Windows (no commercial code signature): **More info → Run anyway**.

🎨 Curious about the UI before installing? Open [**panel-preview.html**](https://github.com/Araz0-0dev/am-code/releases/latest/download/panel-preview.html) in a browser.

### 2) VS Code extension

```bash
code --install-extension am-code-0.3.0.vsix      # or download the VSIX below
```

[**Download the VSIX**](https://github.com/Araz0-0dev/am-code/releases/latest/download/am-code-0.3.0.vsix)

### 3) From source

```bash
git clone https://github.com/Araz0-0dev/am-code.git
cd am-code && npm install
npm test            # 57 tests: engine, providers, MCP, token saver, activation, panel
npm run build && npm run package

cd desktop && npm install && npm run dist:win     # → AM-Code-Setup-0.3.0.exe
```

---

## Getting started

1. Open the AM Code panel (activity-bar icon or `Ctrl+Shift+P` → **AM Code: Open Chat**).
2. ⚙️ → **Models** → *Add model*: **Base URL** (`https://api.openai.com/v1`,
   `http://localhost:11434/v1`, …), **Model ID** (`deepseek-chat`, `qwen2.5-coder:32b`, …), API key →
   *Save & test connection*.
3. Ask for something. That's it — the agent plans, ticks and works.

**Cheap starters:** `deepseek-chat` · `gpt-4o-mini` · `claude-haiku` · any OpenRouter model ·
anything local on Ollama / LM Studio (free).

---

## MCP

⚙️ → **MCP** with presets (Filesystem, GitHub, Fetch, Memory, Playwright, SQLite, remote HTTP):

- **stdio** (command) and **HTTP/SSE** transports
- `KEY=VALUE` env and `Header: value` editors, tool filters (`read_*`), per-server auto-approve
- one-click **Test** that reports the server name/version and its tools
- secrets stay in **Secret Storage** and are injected at connect time

Commands: **AM Code: MCP Servers…** (`Ctrl+Alt+M`) and **AM Code: Refresh MCP Servers**.

---

## Tests

```
11/11 core tests passed          agent engine + guards
 4/4  provider tests passed      request / streaming / error paths
10/10 MCP tests passed           real stdio and HTTP servers
11/11 token saver tests passed   compression + proof the payload shrinks on the wire
 5/5  activation tests passed    extension activation
15/15 webview tests passed       panel (Models · MCP · Tokens · General · Interface)
```

## Project layout

```
src/core/    engine: agent loop, tools, prompts, providers, MCP client, token saver
src/host/    VS Code layer: config, secrets, terminal, diffs, settings
src/ui/      the webview panel (HTML/CSS/JS) + message protocol
desktop/     Electron app for Windows/Linux/macOS — same engine, zero changes
test/        node:test suites + a local MCP fixture server
```

## Roadmap

- [ ] Embeddings-based semantic code index
- [ ] "Team" mode: a cheap model for reading, a strong one for planning
- [x] GitHub Action that builds the desktop installers on every release
- [ ] VS Code Marketplace
- [ ] Arabic and Turkish UI translations

## Author

Built by **AM** — [@AM0_0dev](https://t.me/AM0_0dev)

If it saves you tokens, give it a ⭐. Found a bug? Open an issue. Happy to hear what models you run.

## License

[MIT](LICENSE) — free to use, modify and ship commercially.
