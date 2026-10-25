const path = require("node:path");
const { tests } = require("@iobroker/testing");
const { expect } = require("chai");
const { startMock } = require("./mockUuServer");

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, ".."), {
	defineAdditionalTests({ suite }) {
		suite("Against a mocked Ultimate Updater Web UI", getHarness => {
			/** @type {any} */
			let mock;
			/** @type {any} */
			let harness;
			const NS = "ultimate-updater.0";
			const wait = ms => new Promise(r => setTimeout(r, ms));

			before(async function () {
				this.timeout(60000);
				mock = await startMock();
				harness = getHarness();
				const obj = await harness.objects.getObjectAsync(`system.adapter.${NS}`);
				// the token is in encryptedNative → store it encrypted like admin does (legacy XOR, still supported)
				const sys = await harness.objects.getObjectAsync("system.config");
				const secret = String(sys.native.secret);
				const encrypt = v => [...v].map((c, i) => String.fromCharCode(secret.charCodeAt(i % secret.length) ^ c.charCodeAt(0))).join("");
				Object.assign(obj.native, {
					ip: "127.0.0.1",
					port: mock.port,
					https: false,
					apiToken: encrypt("tok-full"),
					pollIdle: 5,
					pollBusy: 1,
					excludeTargets: ["lxc:103"],
					allowReboot: true,
				});
				await harness.objects.setObjectAsync(obj._id, obj);
				await harness.startAdapterAndWait();
				await wait(3000);
			});
			after(() => mock && mock.server.close());

			it("connects with the API token", async () => {
				expect(mock.state.v1Calls.some(c => c[1] === "/api/v1/status")).to.equal(true);
				const conn = await harness.states.getStateAsync(`${NS}.info.connection`);
				expect(conn && conn.val).to.equal(true);
			});

			it("creates target devices and summary states", async () => {
				const sec = await harness.states.getStateAsync(`${NS}.targets.web_lxc_101.security_updates`);
				expect(sec && sec.val).to.equal(2);
				const dev = await harness.objects.getObjectAsync(`${NS}.targets.web_lxc_101`);
				expect(dev && dev.type).to.equal("device");
				const reach = await harness.objects.getObjectAsync(`${NS}.targets.web_lxc_101.reachable`);
				expect(reach && reach.common.role).to.equal("indicator.reachable");
				const total = await harness.states.getStateAsync(`${NS}.summary.securityUpdatesTotal`);
				expect(total && total.val).to.equal(3);
				const text = await harness.states.getStateAsync(`${NS}.summary.text`);
				expect(text && text.val).to.equal("9 updates on 3 systems, 1 reboot required");
				const jobState = await harness.states.getStateAsync(`${NS}.targets.web_lxc_101.jobState`);
				expect(jobState && jobState.val).to.equal("none");
				const reboot = await harness.states.getStateAsync(`${NS}.summary.rebootRequiredList`);
				expect(reboot && reboot.val).to.equal('["pve"]');
			});

			it("stores the log of a failed job", async () => {
				const log = await harness.states.getStateAsync(`${NS}.jobs.uu_1.log`);
				expect(log && log.val).to.equal("E: apt failed");
			});

			it("starts an update when the button is pressed", async () => {
				await harness.states.setStateAsync(`${NS}.targets.web_lxc_101.updateNow`, true, false);
				await wait(1500);
				expect(mock.state.actions).to.deep.include(["update", "lxc:101"]);
				const btn = await harness.states.getStateAsync(`${NS}.targets.web_lxc_101.updateNow`);
				expect(btn && btn.ack).to.equal(true);
			});

			it("updates a host via update-node", async () => {
				await harness.states.setStateAsync(`${NS}.targets.pve_host_pve.updateNow`, true, false);
				await wait(1500);
				expect(mock.state.actions).to.deep.include(["update-node", "pve"]);
			});

			it("creates a reboot button only for targets that need a reboot", async () => {
				expect(await harness.objects.getObjectAsync(`${NS}.targets.pve_host_pve.reboot`)).to.be.ok;
				expect(await harness.objects.getObjectAsync(`${NS}.targets.web_lxc_101.reboot`)).to.not.be.ok;
				await harness.states.setStateAsync(`${NS}.targets.pve_host_pve.reboot`, true, false);
				await wait(1500);
				expect(mock.state.actions).to.deep.include(["reboot", "host:pve"]);
			});

			it("updates all VMs/CTs one after the other and skips excluded targets", async function () {
				this.timeout(30000);
				mock.state.actions.length = 0;
				mock.state.timeline.length = 0;
				mock.state.autoCompleteMs = 2500;
				mock.state.targets.push({
					id: "lxc:104",
					name: "mail",
					type: "lxc",
					node: "pve",
					reachable: true,
					security_updates: 0,
					normal_updates: 3,
					reboot_required: false,
				});
				// shut down CT: skipped by default (setting "only running VMs/CTs")
				mock.state.targets.push({
					id: "lxc:105",
					name: "backup",
					type: "lxc",
					node: "pve",
					status: "stopped",
					reachable: null,
					security_updates: null,
					normal_updates: null,
					reboot_required: null,
				});
				await harness.states.setStateAsync(`${NS}.updateAllVmsCts`, true, false);
				await wait(1500);
				const active = await harness.states.getStateAsync(`${NS}.bulk.active`);
				expect(active && active.val).to.equal(true);
				// only the first target has been started while its job is still running
				expect(mock.state.actions.filter(a => a[0] === "update").map(a => a[1])).to.deep.equal(["lxc:101"]);
				// a single update is refused while the collective update runs
				await harness.states.setStateAsync(`${NS}.targets.pve_host_pve.updateNow`, true, false);
				await wait(9000);
				const started = mock.state.actions.filter(a => a[0] === "update" || a[0] === "update-node").map(a => a[1]);
				expect(started).to.deep.equal(["lxc:101", "lxc:104"]);
				expect(started).to.not.include("lxc:103");
				expect(started).to.not.include("lxc:105");
				// the second job started only after the first one had finished
				const doneFirst = mock.state.timeline.find(e => e[0] === "done" && e[1] === "lxc:101");
				const startSecond = mock.state.timeline.find(e => e[0] === "start" && e[1] === "lxc:104");
				expect(startSecond[2]).to.be.at.least(doneFirst[2]);
				await wait(3000);
				const after = await harness.states.getStateAsync(`${NS}.bulk.active`);
				expect(after && after.val).to.equal(false);
				const progress = await harness.states.getStateAsync(`${NS}.bulk.progress`);
				expect(progress && progress.val).to.equal("2 ok, 0 failed, 0 not started, 1 shut down skipped");
				mock.state.autoCompleteMs = 0;
				mock.state.targets = mock.state.targets.filter(t => t.id !== "lxc:104" && t.id !== "lxc:105");
			});

			it("shows a running job at the target and cancels it", async function () {
				this.timeout(20000);
				mock.state.startJobOnUpdate = true;
				await harness.states.setStateAsync(`${NS}.targets.web_lxc_101.updateNow`, true, false);
				await wait(2500);
				const jobState = await harness.states.getStateAsync(`${NS}.targets.web_lxc_101.jobState`);
				expect(jobState && jobState.val).to.equal("running");
				const running = await harness.states.getStateAsync(`${NS}.jobRunning`);
				expect(running && running.val).to.equal(true);
				expect(await harness.objects.getObjectAsync(`${NS}.jobs.uu_2.cancel`)).to.be.ok;

				// target deleted in Proxmox meanwhile → removed on the refresh after the job ended
				mock.state.targets = mock.state.targets.filter(t => t.id !== "lxc:103");
				// unknown value for a number field must not change the state type
				mock.state.targets.find(t => t.id === "lxc:101").security_updates = null;
				await harness.states.setStateAsync(`${NS}.jobs.uu_2.cancel`, true, false);
				await wait(4000);
				expect(mock.state.actions).to.deep.include(["cancel", "uu-2"]);
				const after = await harness.states.getStateAsync(`${NS}.targets.web_lxc_101.jobState`);
				expect(after && after.val).to.equal("interrupted");
				expect(await harness.objects.getObjectAsync(`${NS}.jobs.uu_2.cancel`)).to.not.be.ok;
			});

			it("keeps the state type when the API delivers null", async () => {
				const obj = await harness.objects.getObjectAsync(`${NS}.targets.web_lxc_101.security_updates`);
				expect(obj && obj.common.type).to.equal("number");
				const st = await harness.states.getStateAsync(`${NS}.targets.web_lxc_101.security_updates`);
				expect(st && st.val).to.equal(null);
			});

			it("does not touch user writes to non-button states", async () => {
				await harness.states.setStateAsync(`${NS}.targets.web_lxc_101.name`, "manual", false);
				await wait(500);
				const st = await harness.states.getStateAsync(`${NS}.targets.web_lxc_101.name`);
				expect(st && st.val).to.equal("manual");
			});

			it("notifies the interrupted job once and removes the deleted target", async () => {
				const ns = await harness.states.getStateAsync(`${NS}.info.notifyState`);
				const notified = JSON.parse(String(ns && ns.val));
				expect(notified.jobs).to.include("uu-2");
				expect(await harness.objects.getObjectAsync(`${NS}.targets.db_lxc_103`)).to.not.be.ok;
			});

			it("stops", async function () {
				this.timeout(10000);
				await harness.stopAdapter();
			});
		});

		suite("Shut down guests and node checks", getHarness => {
			/** @type {any} */
			let mock;
			/** @type {any} */
			let harness;
			const NS = "ultimate-updater.0";
			const wait = ms => new Promise(r => setTimeout(r, ms));

			before(async function () {
				this.timeout(60000);
				mock = await startMock();
				// v1 has no "status" field – a shut down CT is only visible through skip_reason
				mock.state.targets.push({
					id: "lxc:105",
					name: "backup",
					type: "lxc",
					node: "pve",
					status: "stopped",
					reachable: null,
					security_updates: null,
					normal_updates: null,
					reboot_required: null,
				});
				harness = getHarness();
				const sys = await harness.objects.getObjectAsync("system.config");
				const secret = String(sys.native.secret);
				const encrypt = v =>
					[...v]
						.map((c, i) => String.fromCharCode(secret.charCodeAt(i % secret.length) ^ c.charCodeAt(0)))
						.join("");
				const obj = await harness.objects.getObjectAsync(`system.adapter.${NS}`);
				Object.assign(obj.native, {
					ip: "127.0.0.1",
					port: mock.port,
					https: false,
					credentialMode: "manual",
					apiToken: encrypt("tok-full"),
					pollIdle: 5,
					pollBusy: 1,
					excludeTargets: [],
				});
				// like an install/upgrade does: encryptedNative of the instance follows io-package.json
				obj.encryptedNative = require("../io-package.json").encryptedNative;
				obj.protectedNative = require("../io-package.json").protectedNative;
				await harness.objects.setObjectAsync(obj._id, obj);
				await harness.startAdapterAndWait();
				await wait(3000);
			});
			after(() => mock && mock.server.close());

			it("reads the status via /api/v1 and maps skip_reason", async () => {
				expect(mock.state.v1Calls.some(c => c[1] === "/api/v1/status")).to.equal(true);
				const conn = await harness.states.getStateAsync(`${NS}.info.connection`);
				expect(conn && conn.val).to.equal(true);
				const skip = await harness.states.getStateAsync(`${NS}.targets.backup_lxc_105.skip_reason.code`);
				expect(skip && skip.val).to.equal("STOPPED_READ_ONLY");
			});

			it("updates with confirm and skips the shut down CT in collective updates", async function () {
				this.timeout(30000);
				mock.state.autoCompleteMs = 1500;
				// Ultimate Updater 5.2: an update without package changes ends as "skipped", not as failure
				mock.state.finalStates["lxc:103"] = "skipped";
				await harness.states.setStateAsync(`${NS}.updateAllVmsCts`, true, false);
				await wait(9000);
				const updates = mock.state.v1Calls.filter(c => c[0] === "POST" && c[1].startsWith("/api/v1/update/"));
				expect(updates.map(c => c[1])).to.deep.equal(["/api/v1/update/lxc%3A101", "/api/v1/update/lxc%3A103"]);
				expect(updates.every(c => c[2] && c[2].confirm === true)).to.equal(true);
				const progress = await harness.states.getStateAsync(`${NS}.bulk.progress`);
				expect(progress && progress.val).to.equal("1 ok, 1 unchanged, 0 failed, 0 not started, 1 shut down skipped");
				mock.state.finalStates = {};
			});

			it("checks a host via check-node with an empty body", async () => {
				await harness.states.setStateAsync(`${NS}.targets.pve_host_pve.checkNow`, true, false);
				await wait(1500);
				expect(mock.state.v1Calls).to.deep.include(["POST", "/api/v1/check-node/pve", {}]);
			});

			it("stops", async function () {
				this.timeout(10000);
				await harness.stopAdapter();
			});
		});

		suite("With login data from the credentials manager", getHarness => {
			/** @type {any} */
			let mock;
			/** @type {any} */
			let harness;
			/** @type {(v: string) => string} */
			let encrypt;
			const NS = "ultimate-updater.0";
			const CRED = "system.credentials.uu-test";
			const wait = ms => new Promise(r => setTimeout(r, ms));

			before(async function () {
				this.timeout(60000);
				mock = await startMock();
				harness = getHarness();
				const sys = await harness.objects.getObjectAsync("system.config");
				const secret = String(sys.native.secret);
				encrypt = v =>
					[...v]
						.map((c, i) => String.fromCharCode(secret.charCodeAt(i % secret.length) ^ c.charCodeAt(0)))
						.join("");
				await harness.objects.setObjectAsync(CRED, {
					type: "config",
					common: { name: "UU test token" },
					native: { type: "custom", version: 1, encryptedFields: ["key"], key: encrypt("tok-read") },
				});
				const obj = await harness.objects.getObjectAsync(`system.adapter.${NS}`);
				Object.assign(obj.native, {
					ip: "127.0.0.1",
					port: mock.port,
					https: false,
					credentialMode: "manager",
					credentialId: CRED,
					apiToken: "",
				});
				await harness.objects.setObjectAsync(obj._id, obj);
				await harness.startAdapterAndWait();
				await wait(3000);
			});
			after(() => mock && mock.server.close());

			it("uses the token of the credential", async () => {
				expect(mock.state.v1Calls.some(c => c[1] === "/api/v1/status")).to.equal(true);
				const conn = await harness.states.getStateAsync(`${NS}.info.connection`);
				expect(conn && conn.val).to.equal(true);
			});

			it("uses a changed token right away", async function () {
				this.timeout(15000);
				// with the read-only token the job log (permission "logs") is denied; with the full token it works
				delete mock.state.tokens["tok-read"];
				const cred = await harness.objects.getObjectAsync(CRED);
				cred.native.key = encrypt("tok-full");
				await harness.objects.setObjectAsync(CRED, cred);
				const before = mock.state.v1Calls.length;
				await wait(3000);
				const conn = await harness.states.getStateAsync(`${NS}.info.connection`);
				expect(mock.state.v1Calls.length).to.be.greaterThan(before);
				expect(conn && conn.val).to.equal(true);
			});

			it("stops", async function () {
				this.timeout(10000);
				await harness.stopAdapter();
			});
		});
	},
});
