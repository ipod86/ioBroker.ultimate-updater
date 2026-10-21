"use strict";

/**
 * Tests of the status report (summary.report), structure like the Ultimate Updater status mail.
 */

const { expect } = require("chai");
const { buildReport, icon, label } = require("../lib/report");
const { texts } = require("../lib/i18n");

const TARGETS = [
	{ id: "host:pve", name: "pve", type: "host", node: "pve", reachable: true, check_status: "ok", updates: { available: 0 }, security_updates: 0, normal_updates: 0, reboot_required: true },
	{ id: "101", name: "NAS", type: "lxc", node: "pve", reachable: true, check_status: "updates_available", updates: { available: 3 }, security_updates: 1, normal_updates: 2 },
	{ id: "102", name: "notes", type: "lxc", node: "pve", reachable: true, check_status: "ok", updates: { available: 0 }, security_updates: 0, normal_updates: 0 },
	{ id: "108", name: "win11", type: "vm", node: "pve", reachable: false, check_status: "not_checked", updates: { available: 3 }, skip_reason: { code: "STOPPED_READ_ONLY" } },
	{ id: "111", name: "OpenCCU", type: "vm", node: "pve", reachable: false, check_status: "error", error: { code: "CONNECTIVITY_FAILED", message: "The target check failed." }, os: "Buildroot" },
	{ id: "113", name: "Docker", type: "vm", node: "pve", reachable: true, check_status: "ok", updates: { available: 0 }, os: "Debian GNU/Linux 13 (trixie)", updater: "apt" },
];

describe("buildReport", () => {
	const report = buildReport(TARGETS, texts("de"));

	it("lists updates per node with the host first", () => {
		expect(report).to.contain("Verfügbare Updates:\n\n🖥️ pve\nSicherheitsupdates: 0\nNormale Updates: 0\n🔄 Neustart erforderlich");
		expect(report).to.contain("🐧 101 · NAS\nSicherheitsupdates: 1\nNormale Updates: 2");
	});

	it("does not count the old update count of a shut down VM", () => {
		expect(report).to.contain("Verfügbare Updates gesamt: 3");
		expect(report).to.not.contain("108 · win11\nSicherheitsupdates");
		expect(report).to.contain("💤 108 · win11\n   Ausgeschaltet – nicht geprüft");
	});

	it("lists current, reboot and unreachable targets", () => {
		expect(report).to.contain("✅ 🐧 102 · notes\n   Keine Updates verfügbar");
		expect(report).to.contain("Neustart erforderlich:\n🔄 pve");
		expect(report).to.contain("Nicht erreichbar:\n⚠️ ❔ 111 · OpenCCU");
	});

	it("uses the system language and falls back to English", () => {
		expect(buildReport([], texts("en"))).to.equal("Ultimate Updater status\n=======================\n\nAvailable updates: none");
		expect(buildReport([], texts("xx")).startsWith("Ultimate Updater status")).to.equal(true);
	});

	it("chooses icons and labels like the original", () => {
		expect(icon({ type: "vm", os: "Microsoft Windows 11" })).to.equal("🪟");
		expect(icon({ type: "vm", updater: "apt" })).to.equal("🐧");
		expect(icon({ type: "vm" })).to.equal("❔");
		expect(icon({ type: "host" })).to.equal("🖥️");
		expect(label({ id: "lxc:101", name: "web", type: "lxc" })).to.equal("101 · web");
		expect(label({ id: "host:pve", node: "pve", type: "host" })).to.equal("pve");
	});
});
