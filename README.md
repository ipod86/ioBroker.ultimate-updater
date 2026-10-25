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

The adapter is a client for **[Ultimate Updater](https://github.com/BassT23/Proxmox) by [@BassT23](https://github.com/BassT23)**. Ultimate Updater does the actual work on your Proxmox cluster (update execution, snapshots/backups, filters, status model); this adapter only reads its status via the integration API v1 and triggers the actions it offers. Many thanks to BassT23 for the permission to use the name.

The adapter icon is the Ultimate Updater icon by BassT23 ([web-ui/assets/ultimate-updater-icon.png](https://github.com/BassT23/Proxmox/blob/master/web-ui/assets/ultimate-updater-icon.png)).

> **Unofficial community adapter.** It is not affiliated with Ultimate Updater or Proxmox Server Solutions GmbH. Proxmox® is a registered trademark of Proxmox Server Solutions GmbH.

### Requirements

- Node.js >= 22, js-controller >= 6.0.11, admin >= 7.8.23 (the credentials manager needs admin 7.9)
- Ultimate Updater **5.2 or newer** (until 5.2 is released: the `develop` branch) with the Web UI enabled (default port `8765`)
- An **API token** for the integration API v1. It works over HTTPS only and has its own permissions. On the Proxmox host:
  ```bash
  ultimate-updater-api-token enable
  ultimate-updater-api-token create iobroker --permissions read,logs,check,update,reboot,cancel
  ```
  The token is shown only once. Leave out permissions you do not want to grant (e.g. `read,logs,check` for status and checks only); the matching buttons then report "permission denied".

The Web UI login with a Proxmox account is deliberately not supported: it needs an account with full Administrator rights and its endpoints are no stable interface.

### Configuration

| Setting | Description |
|---|---|
| IP address / host name, Port, Use HTTPS | Address of the Ultimate Updater Web UI (the API only works over HTTPS) |
| API token | **Enter here** (stored encrypted) or **from the credentials manager** of the admin (Settings → Credentials, a "Key" credential; needs admin 7.9 and js-controller 7.2.2 or newer). A changed credential is used immediately without restarting the adapter. |
| Validate TLS certificate | Off by default because the Web UI usually uses the self-signed Proxmox certificate |
| Full status refresh | Interval for reading all targets (minutes, default 60). After a job has finished the status is refreshed immediately. |
| Job poll interval | How often the job list is checked: when idle (default 30 s) and while a job is running (default 2 s) |
| Excluded from "update all" | VMs/CTs that the collective update buttons skip (e.g. the ioBroker container itself). They can still be updated individually. The list is loaded from the running instance. |
| Collective updates include | **Only running VMs/CTs** (default) or **all VMs/CTs**. "All" only works if updating stopped guests is enabled in Ultimate Updater as well (`STOPPED_CONTAINER` / `STOPPED_VM` in its `update.conf`): it then starts them for the update and shuts them down again. Otherwise Ultimate Updater skips them and their jobs fail. |
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
| `summary.report` | Status report as multi-line text like the status mail of Ultimate Updater (updates per node, current, reboot required, not reachable, errors, skipped), headings in the system language – e.g. for Telegram or a Markdown card |
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
| `updateAllVmsCts` | Update all VMs/CTs, hosts and excluded targets skipped |
| `updateSecurityOnly` | **Full** update of the VMs/CTs that have pending security updates, hosts and excluded targets skipped. Ultimate Updater has no security-only update, so all pending updates of these targets are installed. |
| `bulk.stop` | Stop a running collective update after the current target |
| `targets.<…>.reboot` | Reboot this host/VM/CT – only exists if reboot buttons are allowed and the target needs a reboot |
| `jobs.<unit>.cancel` | Cancel this job – only exists while the job is running |

Nothing is ever updated or rebooted automatically – only when you press a button. While a job is running, further actions are refused.

**Collective updates run one target after the other:** Ultimate Updater answers as soon as a job has *started* (HTTP 202), so the adapter waits until the job of one target has finished before it starts the next one. Jobs started elsewhere (e.g. in the Web UI) are waited for as well. Progress is shown in `bulk.active` and `bulk.progress` (e.g. `3/7: web`, at the end e.g. `4 ok, 2 unchanged, 1 failed, 0 not started`; "unchanged" = job state `skipped`, there was nothing to update).

### Notifications

The adapter uses the ioBroker notification manager, so Telegram, e-mail, Pushover etc. are configured centrally in ioBroker. Notifications are sent only on changes and in the system language:

- **New security updates** – the number of security updates of a host/VM/CT increased
- **Reboot required** – a host/VM/CT newly needs a reboot
- **Job failed** – a check/update/reboot job failed or was interrupted (also jobs that failed while the adapter was stopped)

On the very first start nothing is notified; the current state is only recorded.

### Security

- The **API token** does not grant any Proxmox login. It only works over HTTPS and carries exactly the permissions you give it (`read`, `logs`, `check`, `update`, `reboot`, `cancel`). Grant only what you need and revoke it on the host with `ultimate-updater-api-token revoke <id>`.
- The token is stored encrypted in ioBroker (or in the central credentials manager). Anyone with access to the ioBroker admin or its object database can use it with the permissions it has.
- The adapter does **not validate the TLS certificate** by default, because the Web UI normally uses the self-signed Proxmox certificate. Without validation the connection is encrypted, but a man-in-the-middle in your network could read the token. Enable *Validate TLS certificate* if the Web UI uses a trusted certificate, and run the adapter only in a trusted network.
- Restrict access to the Ultimate Updater Web UI port to the hosts that need it (e.g. firewall rules).

### Note on the API

The adapter uses the documented, versioned integration API v1 of Ultimate Updater 5.2 (bearer token, separate permissions, HTTPS only), which was designed together with BassT23 ([BassT23/Proxmox#378](https://github.com/BassT23/Proxmox/issues/378)).

## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**
* (ipod86) **Breaking:** only the API token (integration API v1, Ultimate Updater 5.2+) is supported; the Web UI login with a Proxmox user was removed
* (ipod86) warning when HTTPS is switched off; running requests are aborted on stop; stable roles for time fields; `info.connection` only written on changes; README and translations of the news corrected
* (ipod86) notifications name the target with ID and name ("115 · iobroker"), so targets with the same name can be told apart

### 0.0.2 (2026-10-21)
* (ipod86) collective updates run one target after the other (waiting for each job), progress in `bulk.*`
* (ipod86) clearer description of the security update button; security notes in the README
* (ipod86) setting whether collective updates include shut down VMs/CTs (default: only running ones)
* (ipod86) authentication with an API token via the integration API v1 of Ultimate Updater 5.2 (Web UI login stays available)
* (ipod86) collective updates count jobs without package changes (job state `skipped`, Ultimate Updater 5.2) as "unchanged" instead of failed
* (ipod86) new state `summary.report`: status report as text like the status mail of Ultimate Updater

Older changelogs are available in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

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