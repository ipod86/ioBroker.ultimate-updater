![Logo](admin/ultimate-updater.png)
# ioBroker.ultimate-updater

🇬🇧 [English version](README.md)

[![NPM version](https://img.shields.io/npm/v/iobroker.ultimate-updater.svg)](https://www.npmjs.com/package/iobroker.ultimate-updater)
[![Downloads](https://img.shields.io/npm/dm/iobroker.ultimate-updater.svg)](https://www.npmjs.com/package/iobroker.ultimate-updater)
![Number of Installations](https://iobroker.live/badges/ultimate-updater-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/ultimate-updater-stable.svg)
[![NPM](https://nodei.co/npm/iobroker.ultimate-updater.png?downloads=true)](https://nodei.co/npm/iobroker.ultimate-updater/)

**Tests:** ![Test and Release](https://github.com/ipod86/ioBroker.ultimate-updater/workflows/Test%20and%20Release/badge.svg)

## Ultimate-Updater-Adapter für ioBroker

Holt den Update-Status deiner Proxmox-Hosts, LXC-Container und VMs in ioBroker und startet Prüfungen und Updates per Knopfdruck.

Der Adapter ist ein Client für den **[Ultimate Updater](https://github.com/BassT23/Proxmox) von [@BassT23](https://github.com/BassT23)**. Der Ultimate Updater erledigt die eigentliche Arbeit auf dem Proxmox-Cluster (Updates, Snapshots/Backups, Filter, Statusmodell); dieser Adapter liest nur dessen Web-UI-API und löst die dort angebotenen Aktionen aus. Vielen Dank an BassT23 für die Erlaubnis, den Namen zu verwenden.

Das Adapter-Icon ist das Ultimate-Updater-Icon von BassT23 ([web-ui/assets/ultimate-updater-icon.png](https://github.com/BassT23/Proxmox/blob/master/web-ui/assets/ultimate-updater-icon.png)).

> **Inoffizieller Community-Adapter.** Er steht in keiner Verbindung zum Ultimate Updater oder zur Proxmox Server Solutions GmbH. Proxmox® ist eine eingetragene Marke der Proxmox Server Solutions GmbH.

### Voraussetzungen

- Ultimate Updater **5.1.3 oder neuer** mit aktivierter Web-UI (Standardport `8765`)
- Ein Proxmox-Konto für den Web-UI-Login (z. B. `root`, Realm `pam`). Der Ultimate Updater akzeptiert nur Konten mit vollen **Administrator**-Rechten auf `/` und **ohne Zwei-Faktor-Authentifizierung**.

### Konfiguration

| Einstellung | Beschreibung |
|---|---|
| IP-Adresse / Hostname, Port, HTTPS verwenden | Adresse der Ultimate-Updater-Weboberfläche |
| Zugangsdaten | **Hier eingeben** (Benutzer und Passwort in den Adapter-Einstellungen) oder **aus dem Credentials-Manager** des Admin (Einstellungen → Credentials, benötigt Admin 7.9 und js-controller 7.2.2 oder neuer). Beim Credentials-Manager wählt man einen Eintrag vom Typ „Login & Passwort“; Änderungen daran werden sofort ohne Neustart des Adapters übernommen. |
| Benutzername / Passwort | Nur bei „Hier eingeben“: Proxmox-Benutzer **ohne** `@Realm` (z. B. `root`) und Passwort. `root@pam` wird automatisch aufgeteilt. Das Passwort wird verschlüsselt gespeichert. |
| Anmeldedomäne (Realm) | Wie im Web-UI-Login, z. B. `pam` oder `pve` |
| TLS-Zertifikat validieren | Standardmäßig aus, da die Web-UI meist das selbstsignierte Proxmox-Zertifikat nutzt |
| Vollständige Statusaktualisierung | Intervall zum Lesen aller Targets (Minuten, Standard 60). Nach einem beendeten Job wird der Status sofort aktualisiert. |
| Job-Abfrageintervall | Wie oft die Jobliste geprüft wird: im Leerlauf (Standard 30 s) und während ein Job läuft (Standard 2 s) |
| Ausgenommen von „Alle aktualisieren“ | VMs/CTs, die die Sammel-Update-Buttons überspringen (z. B. der ioBroker-Container selbst). Einzeln lassen sie sich weiterhin aktualisieren. Die Liste wird von der laufenden Instanz geladen. |
| Neustart-Buttons erlauben | Legt für Hosts/VMs/CTs, die einen Neustart brauchen, einen `reboot`-Button an. Standardmäßig aus. |
| Nicht mehr vorhandene Targets löschen | Entfernt die Datenpunkte von Hosts/VMs/CTs, die der Ultimate Updater nicht mehr meldet (z. B. in Proxmox gelöscht). Standardmäßig an; ist die Option aus, bleiben sie erhalten. |
| Benachrichtigungen | Neue Sicherheitsupdates, Neustart erforderlich, Job fehlgeschlagen/abgebrochen – jeweils einzeln abschaltbar |

### Datenpunkte

| Datenpunkt | Beschreibung |
|---|---|
| `info.connection` | Verbindung zur Web-UI |
| `info.lastRefresh`, `info.targetCount`, `info.updaterVersion`, `info.updaterUpdateAvailable` | Allgemeine Informationen |
| `jobRunning` | Ein Prüf-/Update-Job läuft |
| `summary.text` | Kurze Zusammenfassung in der Systemsprache, z. B. „7 Updates auf 3 Systemen, 1 Neustart nötig“ |
| `summary.*` | Offene Sicherheits-/normale Updates gesamt, Targets mit Updates, nicht erreichbare Targets, Targets mit ausstehendem Neustart |
| `targets.<Name>_<ID>.*` | Alle Felder, die der Ultimate Updater pro Host/LXC/VM liefert (z. B. `security_updates`, `normal_updates`, `reboot_required`, `reachable`, `last_check`) |
| `targets.<…>.jobState`, `targets.<…>.jobUnit` | Status und ID des letzten Jobs dieses Targets (`none`, wenn es keinen gibt) |
| `jobs.<Unit>.*` | Laufende und letzte Jobs; bei fehlgeschlagenen Jobs stehen die letzten Logzeilen in `log` |

### Buttons

| Button | Aktion |
|---|---|
| `targets.<…>.checkNow` | Diesen Host/diese VM/diesen CT prüfen (kein Update) |
| `targets.<…>.updateNow` | Diesen Host/diese VM/diesen CT aktualisieren (Hosts per Node-Update, Gäste werden nicht angefasst) |
| `checkAll` | Alle Targets inklusive Hosts prüfen |
| `updateAllVmsCts` | Alle VMs/CTs aktualisieren, Hosts ausgenommen |
| `updateSecurityOnly` | Alle VMs/CTs mit Sicherheitsupdates aktualisieren, Hosts ausgenommen |
| `targets.<…>.reboot` | Diesen Host/diese VM/diesen CT neu starten – nur vorhanden, wenn Neustart-Buttons erlaubt sind und das Target einen Neustart braucht |
| `jobs.<Unit>.cancel` | Diesen Job abbrechen – nur vorhanden, solange der Job läuft |

Es wird nie automatisch aktualisiert oder neu gestartet – nur per Knopfdruck. Solange ein Job läuft, werden weitere Aktionen abgelehnt.

### Benachrichtigungen

Der Adapter nutzt den ioBroker Notification Manager; Telegram, E-Mail, Pushover usw. werden also zentral in ioBroker eingerichtet. Gemeldet werden nur Änderungen, in der Systemsprache:

- **Neue Sicherheitsupdates** – die Anzahl der Sicherheitsupdates eines Hosts/einer VM/eines CT ist gestiegen
- **Neustart erforderlich** – ein Host/eine VM/ein CT braucht neu einen Neustart
- **Job fehlgeschlagen** – ein Prüf-/Update-/Neustart-Job ist fehlgeschlagen oder wurde abgebrochen (auch Jobs, die fehlschlugen, während der Adapter gestoppt war)

Beim allerersten Start wird nichts gemeldet; der aktuelle Stand wird nur erfasst.

### Hinweis zur API

Der Adapter nutzt derzeit die Endpunkte der Ultimate-Updater-Weboberfläche. Eine dokumentierte, versionierte API mit Token-Anmeldung wird upstream besprochen ([BassT23/Proxmox#378](https://github.com/BassT23/Proxmox/issues/378)); der Adapter stellt darauf um, sobald sie verfügbar ist.

## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**
* (ipod86) Erste Version

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