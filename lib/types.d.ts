/**
 * JSON payload of the Ultimate Updater API (status, targets, jobs). It is third-party data whose shape depends on
 * the Ultimate Updater version, so it is deliberately not typed further; the adapter checks every field it reads.
 */

export type ApiData = any;
