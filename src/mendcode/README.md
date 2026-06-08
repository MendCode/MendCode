<p align="center">
  <a href="https://github.com/MendCode/MendCode">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="MendCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent.</p>
<p align="center">
  <a href="https://mendcode.ai"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://github.com/MendCode/mendcode-cli/actions"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/MendCode/mendcode-cli/security.yml?style=flat-square&branch=main" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![MendCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://github.com/MendCode/MendCode)

---

### Installation

Install MendCode from the MendCode release assets:

```bash
curl -fsSL https://mendcode.ai/install | bash

# Install into a custom bin directory
MENDCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://mendcode.ai/install | bash
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

MendCode is also available through the current MendCode desktop distribution. Download from the [releases page](https://mendcode.ai/releases) or [mendcode.ai/download](https://mendcode.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `mendcode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `mendcode-desktop-mac-x64.dmg`     |
| Windows               | `mendcode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$MENDCODE_INSTALL_DIR` - Custom installation directory
2. `$OPENCODE_INSTALL_DIR` - Legacy compatibility custom directory
3. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
4. `$HOME/.mendcode/bin` - Default fallback

```bash
# Examples
MENDCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://mendcode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://mendcode.ai/install | bash
```

### Agents

MendCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more in the [MendCode agent docs](https://mendcode.ai/docs/agents).

### Documentation

For more info on how to configure MendCode today, use the [MendCode docs](https://mendcode.ai/docs).

MendCode also includes a local persistent memory system for user preferences and project decisions. See [Memory](../../docs/memory-system.md) for storage paths, CLI/TUI controls, proposal approval, and the editable learning policy.

### Contributing

If you're interested in contributing to MendCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Internal Layout

Some source paths still include `packages/opencode` while the runtime is being adopted. That path is internal only; public distribution and install commands use MendCode-owned names.

### FAQ

#### How is this different from Claude Code?

It's very similar to Claude Code in terms of capability. Here are the key differences:

- 100% open source
- Not coupled to any provider. MendCode keeps the local CLI/runtime experience provider-agnostic.
- Built-in opt-in LSP support
- A focus on TUI. MendCode is built by neovim users and the creators of [terminal.shop](https://terminal.shop); we are going to push the limits of what's possible in the terminal.
- A client/server architecture. This, for example, can allow MendCode to run on your computer while you drive it remotely from a mobile app, meaning that the TUI frontend is just one of the possible clients.

---

**Community** [mendcode.ai](https://mendcode.ai)
