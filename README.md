![Logo](admin/ultimate-updater.png)
# ioBroker.ultimate-updater

[![NPM version](https://img.shields.io/npm/v/iobroker.ultimate-updater.svg)](https://www.npmjs.com/package/iobroker.ultimate-updater)
[![Downloads](https://img.shields.io/npm/dm/iobroker.ultimate-updater.svg)](https://www.npmjs.com/package/iobroker.ultimate-updater)
![Number of Installations](https://iobroker.live/badges/ultimate-updater-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/ultimate-updater-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.ultimate-updater.png?downloads=true)](https://nodei.co/npm/iobroker.ultimate-updater/)

**Tests:** ![Test and Release](https://github.com/ipod86/ioBroker.ultimate-updater/workflows/Test%20and%20Release/badge.svg)

## Ultimate Updater adapter for ioBroker

Brings the update status of your Proxmox hosts, LXC containers and VMs into ioBroker and lets you start checks and updates with a button.

The adapter is a client for **[Ultimate Updater](https://github.com/BassT23/Proxmox) by [@BassT23](https://github.com/BassT23)**. Ultimate Updater does the actual work on your Proxmox cluster (update execution, snapshots/backups, filters, status model); this adapter only reads its Web UI API and triggers the actions it offers. Many thanks to BassT23 for the permission to use the name.

> **Unofficial community adapter.** It is not affiliated with Ultimate Updater or Proxmox Server Solutions GmbH. Proxmox® is a registered trademark of Proxmox Server Solutions GmbH.

### Requirements

- Ultimate Updater **5.1.3 or newer** with the Web UI enabled (default port `8765`)
- A Proxmox account for the Web UI login (e.g. `root`, realm `pam`). Ultimate Updater only accepts accounts with full **Administrator** privileges at `/` and **without two-factor authentication**.

### Configuration

| Setting | Description |
|---|---|
| IP address / host name, Port, Use HTTPS | Address of the Ultimate Updater Web UI |
| Username / Password | Proxmox user name **without** `@realm` (e.g. `root`) and password. `root@pam` is split automatically. The password is stored encrypted. |
| Realm | Authentication domain as shown on the Web UI login, e.g. `pam` or `pve` |
| Validate TLS certificate | Off by default because the Web UI usually uses the self-signed Proxmox certificate |
| Full status refresh | Interval for reading all targets (minutes, default 60). After a job has finished the status is refreshed immediately. |
| Job poll interval | How often the job list is checked: when idle (default 30 s) and while a job is running (default 2 s) |

### States

| State | Description |
|---|---|
| `info.connection` | Connection to the Web UI |
| `info.lastRefresh`, `info.targetCount`, `info.updaterVersion`, `info.updaterUpdateAvailable` | General information |
| `jobRunning` | A check/update job is running |
| `summary.*` | Pending security/normal updates in total, targets with updates, unreachable targets, targets that need a reboot |
| `targets.<name>_<id>.*` | All fields Ultimate Updater delivers per host/LXC/VM (e.g. `security_updates`, `normal_updates`, `reboot_required`, `reachable`, `last_check`) |
| `jobs.<unit>.*` | Running and recent jobs; for failed jobs the last log lines are stored in `log` |

### Buttons

| Button | Action |
|---|---|
| `targets.<…>.checkNow` | Check this host/VM/CT (no update) |
| `targets.<…>.updateNow` | Update this host/VM/CT (hosts via node update, guests are not touched) |
| `checkAll` | Check all targets including hosts |
| `updateAllVmsCts` | Update all VMs/CTs, hosts excluded |
| `updateSecurityOnly` | Update all VMs/CTs that have security updates, hosts excluded |

Nothing is ever updated automatically – only when you press a button. While a job is running, further actions are refused. Reboots are not triggered by the adapter.

### Note on the API

The adapter currently uses the Ultimate Updater Web UI endpoints. A documented, versioned API with token authentication is being discussed upstream ([BassT23/Proxmox#378](https://github.com/BassT23/Proxmox/issues/378)); the adapter will switch to it once it is available.

## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**
* (ipod86) initial release

## License
MIT License

Copyright (c) 2026 ipod86 <david@graef.email>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.