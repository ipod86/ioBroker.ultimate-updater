![Logo](admin/ultimate-updater.png)
# ioBroker.ultimate-updater

🇩🇪 [Deutsche Version](README.de.md)

[![NPM version](https://img.shields.io/npm/v/iobroker.ultimate-updater.svg)](https://www.npmjs.com/package/iobroker.ultimate-updater)
[![Downloads](https://img.shields.io/npm/dm/iobroker.ultimate-updater.svg)](https://www.npmjs.com/package/iobroker.ultimate-updater)
![Number of Installations](https://iobroker.live/badges/ultimate-updater-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/ultimate-updater-stable.svg)
[![NPM](https://nodei.co/npm/iobroker.ultimate-updater.png?downloads=true)](https://nodei.co/npm/iobroker.ultimate-updater/)

**Tests:** ![Test and Release](https://github.com/ipod86/ioBroker.ultimate-updater/workflows/Test%20and%20Release/badge.svg)

## Ultimate Updater adapter for ioBroker

Brings the update status of your Proxmox hosts, LXC containers and VMs into ioBroker and lets you start checks and updates with a button.

The adapter is a client for **[Ultimate Updater](https://github.com/BassT23/Proxmox) by [@BassT23](https://github.com/BassT23)**. Ultimate Updater does the actual work on your Proxmox cluster (update execution, snapshots/backups, filters, status model); this adapter only reads its Web UI API and triggers the actions it offers. Many thanks to BassT23 for the permission to use the name.

The adapter icon is the Ultimate Updater icon by BassT23 ([web-ui/assets/ultimate-updater-icon.png](https://github.com/BassT23/Proxmox/blob/master/web-ui/assets/ultimate-updater-icon.png)).

> **Unofficial community adapter.** It is not affiliated with Ultimate Updater or Proxmox Server Solutions GmbH. Proxmox® is a registered trademark of Proxmox Server Solutions GmbH.

### Requirements

- Ultimate Updater **5.1.3 or newer** with the Web UI enabled (default port `8765`)
- A Proxmox account for the Web UI login (e.g. `root`, realm `pam`). Ultimate Updater only accepts accounts with full **Administrator** privileges at `/` and **without two-factor authentication**.

### Configuration

| Setting | Description |
|---|---|
| IP address / host name, Port, Use HTTPS | Address of the Ultimate Updater Web UI |
| Login data | **Enter here** (user name and password in the adapter settings) or **from the credentials manager** of the admin (Settings → Credentials, needs admin 7.9 and js-controller 7.2.2 or newer). With the credentials manager you select a "Login & password" credential; changes to it are used immediately without restarting the adapter. |
| Username / Password | Only for "enter here": Proxmox user name **without** `@realm` (e.g. `root`) and password. `root@pam` is split automatically. The password is stored encrypted. |
| Realm | Authentication domain as shown on the Web UI login, e.g. `pam` or `pve` |
| Validate TLS certificate | Off by default because the Web UI usually uses the self-signed Proxmox certificate |
| Full status refresh | Interval for reading all targets (minutes, default 60). After a job has finished the status is refreshed immediately. |
| Job poll interval | How often the job list is checked: when idle (default 30 s) and while a job is running (default 2 s) |
| Excluded from "update all" | VMs/CTs that the collective update buttons skip (e.g. the ioBroker container itself). They can still be updated individually. The list is loaded from the running instance. |
| Allow reboot buttons | Creates a `reboot` button for hosts/VMs/CTs that need a reboot. Off by default. |
| Delete targets that no longer exist | Removes the states of hosts/VMs/CTs that Ultimate Updater no longer reports (e.g. deleted in Proxmox). On by default; if off, they are kept. |
| Notifications | New security updates, reboot required, job failed/interrupted – each can be switched off |

### States

| State | Description |
|---|---|
| `info.connection` | Connection to the Web UI |
| `info.lastRefresh`, `info.targetCount`, `info.updaterVersion`, `info.updaterUpdateAvailable` | General information |
| `jobRunning` | A check/update job is running |
| `summary.text` | Short summary in the system language, e.g. "7 updates on 3 systems, 1 reboot required" |
| `summary.*` | Pending security/normal updates in total, targets with updates, unreachable targets, targets that need a reboot |
| `targets.<name>_<id>.*` | All fields Ultimate Updater delivers per host/LXC/VM (e.g. `security_updates`, `normal_updates`, `reboot_required`, `reachable`, `last_check`) |
| `targets.<…>.jobState`, `targets.<…>.jobUnit` | State and id of the latest job of this target (`none` if there is none) |
| `jobs.<unit>.*` | Running and recent jobs; for failed jobs the last log lines are stored in `log` |

### Buttons

| Button | Action |
|---|---|
| `targets.<…>.checkNow` | Check this host/VM/CT (no update) |
| `targets.<…>.updateNow` | Update this host/VM/CT (hosts via node update, guests are not touched) |
| `checkAll` | Check all targets including hosts |
| `updateAllVmsCts` | Update all VMs/CTs, hosts excluded |
| `updateSecurityOnly` | Update all VMs/CTs that have security updates, hosts excluded |
| `targets.<…>.reboot` | Reboot this host/VM/CT – only exists if reboot buttons are allowed and the target needs a reboot |
| `jobs.<unit>.cancel` | Cancel this job – only exists while the job is running |

Nothing is ever updated or rebooted automatically – only when you press a button. While a job is running, further actions are refused.

### Notifications

The adapter uses the ioBroker notification manager, so Telegram, e-mail, Pushover etc. are configured centrally in ioBroker. Notifications are sent only on changes and in the system language:

- **New security updates** – the number of security updates of a host/VM/CT increased
- **Reboot required** – a host/VM/CT newly needs a reboot
- **Job failed** – a check/update/reboot job failed or was interrupted (also jobs that failed while the adapter was stopped)

On the very first start nothing is notified; the current state is only recorded.

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