"use strict";

/**
 * Texts that the adapter generates itself (notifications, summary text),
 * in the ioBroker system language.
 */

const TEXTS = {
	en: {
		security: (name, n) => `${name}: ${n} security update${n === 1 ? "" : "s"} available`,
		jobFailed: (target, state) =>
			`Ultimate Updater job for ${target} ${state === "interrupted" ? "was interrupted" : "failed"}`,
		reboot: name => `${name} needs a reboot`,
		summaryNone: "All systems are up to date",
		summary: (u, t) => `${u} update${u === 1 ? "" : "s"} on ${t} system${t === 1 ? "" : "s"}`,
		summaryReboot: r => `${r} reboot${r === 1 ? "" : "s"} required`,
	},
	de: {
		security: (name, n) => `${name}: ${n} Sicherheitsupdate${n === 1 ? "" : "s"} verfügbar`,
		jobFailed: (target, state) =>
			`Ultimate-Updater-Job für ${target} ${state === "interrupted" ? "wurde abgebrochen" : "ist fehlgeschlagen"}`,
		reboot: name => `${name} muss neu gestartet werden`,
		summaryNone: "Alle Systeme sind aktuell",
		summary: (u, t) => `${u} Update${u === 1 ? "" : "s"} auf ${t} System${t === 1 ? "" : "en"}`,
		summaryReboot: r => `${r} Neustart${r === 1 ? "" : "s"} nötig`,
	},
	ru: {
		security: (name, n) => `${name}: доступно обновлений безопасности: ${n}`,
		jobFailed: (target, state) =>
			`Задание Ultimate Updater для ${target} ${state === "interrupted" ? "прервано" : "завершилось с ошибкой"}`,
		reboot: name => `${name} требует перезагрузки`,
		summaryNone: "Все системы обновлены",
		summary: (u, t) => `Обновлений: ${u}, систем: ${t}`,
		summaryReboot: r => `требуется перезагрузок: ${r}`,
	},
	pt: {
		security: (name, n) => `${name}: ${n} atualização(ões) de segurança disponível(is)`,
		jobFailed: (target, state) =>
			`Tarefa do Ultimate Updater para ${target} ${state === "interrupted" ? "foi interrompida" : "falhou"}`,
		reboot: name => `${name} precisa ser reiniciado`,
		summaryNone: "Todos os sistemas estão atualizados",
		summary: (u, t) => `${u} atualização(ões) em ${t} sistema(s)`,
		summaryReboot: r => `${r} reinício(s) necessário(s)`,
	},
	nl: {
		security: (name, n) => `${name}: ${n} beveiligingsupdate${n === 1 ? "" : "s"} beschikbaar`,
		jobFailed: (target, state) =>
			`Ultimate Updater-taak voor ${target} ${state === "interrupted" ? "is onderbroken" : "is mislukt"}`,
		reboot: name => `${name} moet opnieuw worden opgestart`,
		summaryNone: "Alle systemen zijn up-to-date",
		summary: (u, t) => `${u} update${u === 1 ? "" : "s"} op ${t} systeem${t === 1 ? "" : "en"}`,
		summaryReboot: r => `${r} herstart${r === 1 ? "" : "s"} nodig`,
	},
	fr: {
		security: (name, n) => `${name} : ${n} mise(s) à jour de sécurité disponible(s)`,
		jobFailed: (target, state) =>
			`La tâche Ultimate Updater pour ${target} ${state === "interrupted" ? "a été interrompue" : "a échoué"}`,
		reboot: name => `${name} doit être redémarré`,
		summaryNone: "Tous les systèmes sont à jour",
		summary: (u, t) => `${u} mise(s) à jour sur ${t} système(s)`,
		summaryReboot: r => `${r} redémarrage(s) nécessaire(s)`,
	},
	it: {
		security: (name, n) =>
			`${name}: ${n} aggiornament${n === 1 ? "o" : "i"} di sicurezza disponibil${n === 1 ? "e" : "i"}`,
		jobFailed: (target, state) =>
			`Il job di Ultimate Updater per ${target} ${state === "interrupted" ? "è stato interrotto" : "non è riuscito"}`,
		reboot: name => `${name} deve essere riavviato`,
		summaryNone: "Tutti i sistemi sono aggiornati",
		summary: (u, t) => `${u} aggiornament${u === 1 ? "o" : "i"} su ${t} sistem${t === 1 ? "a" : "i"}`,
		summaryReboot: r => `${r} riavvi${r === 1 ? "o" : ""} necessari${r === 1 ? "o" : ""}`,
	},
	es: {
		security: (name, n) => `${name}: ${n} actualización(es) de seguridad disponible(s)`,
		jobFailed: (target, state) =>
			`La tarea de Ultimate Updater para ${target} ${state === "interrupted" ? "se interrumpió" : "falló"}`,
		reboot: name => `${name} necesita reiniciarse`,
		summaryNone: "Todos los sistemas están actualizados",
		summary: (u, t) => `${u} actualización(es) en ${t} sistema(s)`,
		summaryReboot: r => `${r} reinicio(s) necesario(s)`,
	},
	pl: {
		security: (name, n) => `${name}: dostępne aktualizacje bezpieczeństwa: ${n}`,
		jobFailed: (target, state) =>
			`Zadanie Ultimate Updater dla ${target} ${state === "interrupted" ? "zostało przerwane" : "nie powiodło się"}`,
		reboot: name => `${name} wymaga ponownego uruchomienia`,
		summaryNone: "Wszystkie systemy są aktualne",
		summary: (u, t) => `Aktualizacje: ${u}, systemy: ${t}`,
		summaryReboot: r => `wymagane restarty: ${r}`,
	},
	uk: {
		security: (name, n) => `${name}: доступно оновлень безпеки: ${n}`,
		jobFailed: (target, state) =>
			`Завдання Ultimate Updater для ${target} ${state === "interrupted" ? "перервано" : "завершилося з помилкою"}`,
		reboot: name => `${name} потребує перезавантаження`,
		summaryNone: "Усі системи оновлені",
		summary: (u, t) => `Оновлень: ${u}, систем: ${t}`,
		summaryReboot: r => `потрібно перезавантажень: ${r}`,
	},
	"zh-cn": {
		security: (name, n) => `${name}：有 ${n} 个安全更新`,
		jobFailed: (target, state) =>
			`${target} 的 Ultimate Updater 任务${state === "interrupted" ? "已中断" : "失败"}`,
		reboot: name => `${name} 需要重启`,
		summaryNone: "所有系统均为最新",
		summary: (u, t) => `${t} 个系统上有 ${u} 个更新`,
		summaryReboot: r => `需要重启 ${r} 次`,
	},
};

/**
 * Text set for a system language (falls back to English).
 *
 * @param {string} lang - ioBroker system language
 * @returns {typeof TEXTS.en} texts
 */
function texts(lang) {
	const l = String(lang || "en").toLowerCase();
	return TEXTS[l] || TEXTS[l.split("-")[0]] || TEXTS.en;
}

module.exports = { texts, LANGUAGES: Object.keys(TEXTS) };
