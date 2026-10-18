<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./mars-logo-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="./mars-logo.png" />
    <img src="./mars-logo.png" alt="MarsAI — free AI coding agent" width="120" height="120" />
  </picture>

  # MarsAI

  <p><strong>Free AI coding agent for Windows, macOS &amp; Linux — with 15M free AI credits for frontier models like Claude, MiniMax, DeepSeek, Qwen and GLM.</strong></p>

  <p>
    <a href="https://github.com/localhost8083/mars-desktop/releases/latest"><img src="https://img.shields.io/github/v/release/localhost8083/mars-desktop?label=latest&style=for-the-badge&color=f97316" alt="Latest release" /></a>
    <a href="https://github.com/localhost8083/mars-desktop/releases"><img src="https://img.shields.io/github/downloads/localhost8083/mars-desktop/total?style=for-the-badge&color=blue&label=downloads" alt="Downloads" /></a>
    <a href="https://github.com/localhost8083/mars-desktop/stargazers"><img src="https://img.shields.io/github/stars/localhost8083/mars-desktop?style=for-the-badge&color=f97316&label=stars" alt="Stars" /></a>
    <a href="https://github.com/localhost8083/mars-desktop"><img src="https://visitor-badge.laobi.icu/badge?page_id=localhost8083.mars-desktop&left_text=views&left_color=%23555&right_color=%23f97316" height="28" alt="Views" /></a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/Windows-x64-0078D6?logo=windows&logoColor=white" alt="Windows x64" />
    <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-000000?logo=apple&logoColor=white" alt="macOS Apple Silicon" />
    <img src="https://img.shields.io/badge/Linux-x64%20%7C%20arm64-FCC624?logo=linux&logoColor=black" alt="Linux x64 and arm64" />
  </p>

  <p>
    <a href="https://github.com/localhost8083/mars-desktop/releases/latest"><img src="https://img.shields.io/badge/Download%20for%20Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white" alt="Download MarsAI for Windows" /></a>
    <a href="https://github.com/localhost8083/mars-desktop/releases/latest"><img src="https://img.shields.io/badge/Download%20for%20macOS-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download MarsAI for macOS" /></a>
    <a href="https://github.com/localhost8083/mars-desktop/releases/latest"><img src="https://img.shields.io/badge/Download%20for%20Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Download MarsAI for Linux" /></a>
  </p>

  <p>
    <a href="https://marsai.click">Website</a> ·
    <a href="https://github.com/localhost8083/mars-desktop/releases">Releases</a> ·
    <a href="https://www.npmjs.com/package/@mars_ai/marscli">CLI</a> ·
    <a href="https://marsai.click/app/keys">API Keys</a>
  </p>
</div>

---

**MarsAI** is a free, open desktop app for working with an AI coding agent on
your own projects. Sign in with a MarsAI API key and get **15M free AI
credits** to use frontier models — Claude, MiniMax, DeepSeek, Qwen, GLM Flash
5.3 and more — through one gateway at [marsai.click](https://marsai.click).
Bring your own provider keys (OpenAI, Anthropic, …) whenever you want.

## Highlights

- **15M free AI credits** — every new API key starts with free credits for
  frontier models on the [MarsAI gateway](https://marsai.click)
- **Frontier models, one key** — Claude, MiniMax, DeepSeek, Qwen, GLM Flash
  5.3 and more, all switchable per message from the model picker
- **Real coding agent** — edits files, runs commands, clones and branches
  repos, opens pull requests, and asks before anything destructive
- **Works on your machine** — Windows x64, macOS (Apple Silicon) and Linux
  (x64 & arm64); your code never has to leave your computer
- **Extensible** — add skills and MCP servers from the Library, or plug in
  your own OpenAI/Anthropic keys
- **Self-updating** — in-app updates on all three platforms

## Install

Grab a file from the
[latest release](https://github.com/localhost8083/mars-desktop/releases/latest)
(file names include the version, e.g. `mars-win-x64-1.0.0.exe`):

| Platform | File |
| --- | --- |
| Windows x64 | `mars-win-x64-<version>.exe` |
| macOS, Apple Silicon | `mars-mac-arm64-<version>.dmg` (`.zip` also attached) |
| Linux x64, Debian/Ubuntu | `mars-linux-amd64-<version>.deb` |
| Linux x64, Arch | `mars-linux-x64-<version>.pacman` |
| Linux x64, Fedora/RHEL/openSUSE | `mars-linux-x86_64-<version>.rpm` |
| Linux x64, other | `mars-linux-x86_64-<version>.AppImage` or `mars-linux-x64-<version>.tar.gz` |
| Linux arm64 | same set as x64 with `arm64` / `aarch64` in the name |

### Windows

1. Download and run `mars-win-x64-<version>.exe`.
2. Windows SmartScreen may show "Unknown publisher" (the installer is not
   code-signed yet). Click **More info → Run anyway**.
3. The app installs to `%LOCALAPPDATA%\Programs\MarsAI` and updates itself
   in place from **Settings → Updates**.

### macOS

1. Download and open the `.dmg`, drag **MarsAI** to Applications.
2. Builds are ad-hoc signed but not notarized yet, so on first open macOS
   reports it cannot verify the app: click **Done**, open **System Settings →
   Privacy & Security**, click **Open Anyway**, then **Open**. Or run:

   ```bash
   xattr -dr com.apple.quarantine /Applications/mars.app
   ```

3. When asked to use the "MarsAI Safe Storage" keychain item, enter your
   login password and choose **Always Allow** — it only encrypts your sign-in
   on this Mac.

### Linux

The `.deb`, `.rpm` and `.pacman` packages install their dependencies. For the
AppImage or tar.gz, install the GTK runtime first:

```bash
sudo apt install libgtk-3-0 libnss3 libatk-bridge2.0-0 libasound2   # libasound2t64 on Ubuntu 24.04
```

Then `chmod +x` the AppImage or unpack the tarball. An error about
`libatk-1.0.so.0` means those packages are missing.

Sign-ins are stored in the system keyring when one is available
(gnome-keyring, KeePassXC with Secret Service, KWallet). Without one, the app
falls back to an owner-only file in its data folder and **Settings** says so.
To choose a store explicitly, start with `--password-store=gnome-libsecret`,
`kwallet5` or `kwallet6`.

## Sign in with an API key

MarsAI is API-key-first — no account linking, no device codes.

1. Create a key at **[marsai.click/app/keys](https://marsai.click/app/keys)**.
2. In the app, open the sidebar footer (**MarsAI API key**) or **Settings**.
3. Paste your key (`sk-mars-…`) — you're connected, with **15M free AI
   credits** ready on Claude, DeepSeek, Qwen, MiniMax, GLM and the rest of
   the catalog.

Free-model variants stay available for background agents even when your
credits run out, and you can always add your own OpenAI/Anthropic keys in
**Settings → Providers**.

## CLI

Prefer the terminal? The MarsAI CLI drives the same agent and models:

```bash
npm install -g @mars_ai/marscli
mars --help
```

Docs: [npmjs.com/package/@mars_ai/marscli](https://www.npmjs.com/package/@mars_ai/marscli)

## Features

| Feature | Description | Docs |
| --- | --- | --- |
| Models and effort | Pick a model and effort level (low, high, xhigh, max) per chat; all MarsAI gateway models appear in realtime. | |
| Skills and MCP servers | Add skills and MCP servers from the Library in Settings. Every model sees the same skills and tools. | [skills-and-mcp.md](docs/skills-and-mcp.md) |
| Git workflows | The agent clones, branches, creates worktrees, commits, pushes, and opens and reviews pull requests with `gh`. Write commands ask once per session; destructive ones always ask. | [git-workflows.md](docs/git-workflows.md) |
| Approvals | The composer's full-permissions toggle switches between asking and allowing every tool call. | [approvals.md](docs/approvals.md) |

## Updating

The app updates itself on Windows, macOS and Linux: use
**Settings → Updates** or the **Check for Updates…** menu item.

- **Windows:** downloads the new installer and swaps it in on restart.
- **macOS:** downloads the new DMG and opens it; drag to Applications.
- **Linux:** AppImage, `.deb`, `.rpm` and `.pacman` update in place. The
  tar.gz does not update itself; download new releases manually.

## Development

Requirements: Node.js 24, pnpm 11.4 and Bun 1.3.10 or newer.

```bash
pnpm install --frozen-lockfile
pnpm --filter @mars/desktop dev      # run the desktop app
pnpm typecheck                       # type-check the app
pnpm --filter @mars/desktop test     # desktop tests
```

Releases are built by the **Release** workflow when a `v*` tag is pushed:
it repacks the pinned engine, builds installers for Windows, macOS and Linux,
and publishes them to GitHub Releases with auto-update manifests.

## Support

- Bugs and feature requests:
  [GitHub issues](https://github.com/localhost8083/mars-desktop/issues)
- Everything else: [info@marsai.click](mailto:info@marsai.click)
- Security reports: email info@marsai.click with the subject "security"
  instead of opening a public issue. See [SECURITY.md](SECURITY.md).

## License

The desktop app is available under the repository's [MIT terms](LICENSE).
Code under `ee/` is governed by its own [license](ee/LICENSE). Third-party
components keep the licenses provided by their owners.
