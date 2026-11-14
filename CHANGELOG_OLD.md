# Older Changelog

### 0.0.1 (2026-10-17)
* (ipod86) initial release
## 0.0.2 (2026-10-21)
* (ipod86) collective updates run one target after the other (waiting for each job), progress in `bulk.*`
* (ipod86) clearer description of the security update button; security notes in the README
* (ipod86) setting whether collective updates include shut down VMs/CTs (default: only running ones)
* (ipod86) authentication with an API token via the integration API v1 of Ultimate Updater 5.2 (Web UI login stays available)
* (ipod86) collective updates count jobs without package changes (job state `skipped`, Ultimate Updater 5.2) as "unchanged" instead of failed
* (ipod86) new state `summary.report`: status report as text like the status mail of Ultimate Updater
