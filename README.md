# CRYOX CLIENT 🎮

> A Black & Crimson **100% Native Rust** Windows Minecraft launcher with isolated profiles, a built-in Modrinth browser & auto-updater, a one-click **server hosting panel**, and **server-less P2P remote access**. Built with **Tauri v2** and **Rust**.

![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D6?style=flat-square&logo=windows)
![Framework](https://img.shields.io/badge/Framework-Tauri%20v2-FFC131?style=flat-square&logo=tauri)
![Backend](https://img.shields.io/badge/Backend-100%25%20Native%20Rust-DEA584?style=flat-square&logo=rust)
![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

---

## ✨ Features

### 🦀 100% Native Rust Backend
- **Zero Node.js Sidecar**: All launcher, installer, server management, Modrinth, Java, DPAPI, Discord IPC, and tunnel logic runs natively in Rust (`src-tauri/src/`).
- **Clean Windows PE Profile**: Uses direct Win32 APIs (no external `taskkill`, `reg`, or PowerShell spawning) with standard release settings and `zlib` NSIS compression to prevent antivirus false positives.
- **Encrypted Token Storage**: Microsoft & Minecraft auth tokens are encrypted at rest using **Windows DPAPI** (`CryptProtectData`) via `dpapi.rs`.

### 🎮 Launcher & Mod Loaders
- **Profile Isolation**: Every profile gets its own game directory so modpacks, saves, and configs never mix. Per-profile RAM (rounded in 256 MB steps) and custom JVM flags.
- **Mod Loaders**: Supports **Fabric** (with ASM 9.10+ and Java 25 class compatibility), **Forge** (automated Maven library merging & `--installClient` processors), and **Vanilla**.
- **Smart Java Management**: Scans `PATH`, standard directories, and the **Windows Registry** across all drives (`C:\`, `D:\`, `E:\`, etc.) for Java 8, 17, 21, and 25, matches Mojang's `javaVersion` manifest, and auto-provisions portable Adoptium/Temurin runtimes when needed.
- **Fast Downloads & Performance**: Parallel asset downloads (`concurrentDownloads`), optional snapshots toggle, live game console, and automatic integrated-GPU light defaults (`perf.rs`) applied once per profile.
- **Custom HUD Mods**: Attach compatible HUD `.jar` files to profiles (`hud:uploadJar`), verified against loader and Minecraft version.
- **Accounts & Skin Studio**: Microsoft OAuth sign-in with automatic token renewal before launch, offline accounts, and local skin sync via `inex-cosmetics-agent.jar`.
- **Discord Rich Presence**: Native Windows named-pipe integration (`\\.\pipe\discord-ipc-*`) broadcasting active profile, game state, and hosted server tunnel info.

### 📦 Modrinth Content Browser & Watcher
- Search and install **Mods**, **Modpacks** (`.mrpack` with overrides, dependencies, and automatic profile loader/version setup), **Resource Packs**, **Shaders**, and **Data Packs**.
- **Fabric Performance Pack**: Optional bundle (Sodium, Lithium, Krypton, FerriteCore, ImmediatelyFast) with automatic retry on launch.
- **Installed Content Manager**: Real-time **native OS folder watcher** (`notify` crate — zero polling), SHA1 Modrinth lookup for manually added mods, enable/disable/remove controls, and **1-click / Update All** version checks.

### 🖥️ Server Hosting & Public Tunnels
Create and manage Minecraft servers directly from the **Server** tab:
- **Server Software**: **Vanilla**, **Paper** (v3 Fill API), **Purpur**, and **Fabric**.
- **Full Management UI**: **Console**, **Players**, **Plugins & Mods**, **Files & Editor**, **Network**, and **Properties** tabs with live CPU/RAM/uptime telemetry.
- **Bedrock Crossplay**: One-click **Geyser** setup so Bedrock players can join Java servers.
- **Public Tunnels (No Port Forwarding)**: Built-in **bore.pub** native tunnel, SSH tunnels (Pinggy / Serveo), and **Playit.gg** (account linking & temporary guest tunnels).

### 🔑 Server Access by Code (Server-less P2P)
Grant a friend temporary control of **one** of your servers over WebRTC DataChannel:

1. **Host:** `Give access` → select a server → `Generate code`, then share the code with your friend.
2. **Friend:** `Friend servers` → paste the code → send the **reply code** back to the host.
3. **Host:** paste the reply code → `Connect`. The remote editor opens on the friend's side.

- Handshake uses two copy-paste codes (`src/p2p-codec.js`, `src/p2p-link.js`) — **no signalling server or external database**.
- Codes are **single-use** and expire after **15 minutes** (one active peer at a time).
- Restricted strictly to the chosen server (server creation, deletion, and tunnel management are blocked on the host side).

### ⚙️ Settings & Updates
- System RAM detection, concurrent download limits, window dimensions/fullscreen, launcher close behavior, glass blur intensity, and custom data directories.
- Built-in GitHub Releases updater support (`src-tauri/tauri.conf.json`).

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | [Tauri v2](https://v2.tauri.app/) (Windows NSIS installer) |
| Backend | Native Rust (`src-tauri/src/`) — Tokio, Reqwest, Notify, Zip, Windows DPAPI & Win32 FFI |
| Frontend | Vanilla HTML, CSS, and JavaScript (`src/`) |
| P2P | WebRTC DataChannel with compact copy-paste SDP handshake (`src/p2p-codec.js`, `src/p2p-link.js`) |
| Cosmetics Agent | Java Instrumentation Agent (`agent-src/`) |

---

## 📁 Project Structure

```text
src/                 Frontend UI (HTML, CSS, JS)
src-tauri/           Native Rust backend, Tauri v2 config, capabilities, and icons
scripts/             UI build & bridge generation scripts (prepare.js, build-ui.js, gen-bridge.js)
agent-src/           Java skin/cosmetics agent source
test/                Verification scripts
bump-version.js      Version sync helper across package.json, Cargo.toml, and Cargo.lock
.github/workflows/   Automated Windows release pipeline
```

---

## 🚀 Getting Started

### Requirements
- [Rust](https://rustup.rs/) (stable MSVC toolchain)
- [Node.js](https://nodejs.org/) 18 or newer (22 recommended, used only for build/dev tooling)
- Visual Studio C++ Build Tools (Windows)

### Run in Development
```bash
git clone https://github.com/inrwxyz/inrwxyz-cryox-client.git
cd inrwxyz-cryox-client
npm install
npm run dev
```

### Build the Windows Installer
```bash
npm run build
```
The compiled binary and NSIS setup installer (`CRYOX CLIENT_<version>_x64-setup.exe`) are generated in `src-tauri/target/release/bundle/nsis/`.

---

## 📦 Releasing a New Version

1. Bump the version everywhere using the included helper:
   ```bash
   node bump-version.js 1.0.0
   ```
2. Commit, tag, and push (or use `--push`):
   ```bash
   git add -A
   git commit -m "release 1.0.0"
   git tag -a v1.0.0 -m "1.0.0"
   git push origin main --tags
   ```
3. GitHub Actions (`.github/workflows/release.yml`) builds the Windows NSIS installer and publishes a GitHub Release automatically.

---

## 👨‍💻 Author

Developed by **[@inrwxyz](https://github.com/inrwxyz)** — Cryox Studios.

## 📄 License

Released under the MIT License.
