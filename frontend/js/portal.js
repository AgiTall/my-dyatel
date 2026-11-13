/* My Dyatel — ролевой медицинский портал: superadmin / врач / медсестра / пациент */
"use strict";

const ROLE_NAMES = { superadmin: "Администратор", doctor: "Врач", nurse: "Медсестра", patient: "Пациент" };
const STATUS = {
  pending: ["Ожидает", "warn"], confirmed: ["В очереди", "warn"], in_progress: ["На приёме", "warn"],
  completed: ["Завершён", "ok"], cancelled: ["Отменён", "red"],
  active: ["Действует", "ok"], used: ["Использовано", ""], expired: ["Истекло", "red"],
  dispensed: ["Выдан", ""], closed: ["Закрыт", ""], extended: ["Продлён", "warn"],
  ordered: ["Назначен", "warn"], ready: ["Готов", "ok"]
};

const state = { token: localStorage.getItem("token"), user: null, tab: null, cache: { ptHome: "clinic" } };

// ---------- утилиты ----------
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = id => document.getElementById(id);
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = s => (s || "").slice(0, 10).split("-").reverse().join(".");
const badge = st => { const [t, c] = STATUS[st] || [st, ""]; return `<span class="badge ${c}">${t}</span>`; };

function calcAge(birthStr) {
  if (!birthStr) return "—";
  const b = new Date(birthStr.slice(0, 10));
  if (isNaN(b)) return "—";
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  const n = Math.abs(age) % 100, n1 = n % 10;
  const word = (n > 10 && n < 20) ? "лет" : (n1 > 1 && n1 < 5) ? "года" : (n1 === 1) ? "год" : "лет";
  return `${age} ${word}`;
}

function toast(msg, err) {
  const el = document.createElement("div");
  el.className = "toast" + (err ? " err" : "");
  el.textContent = msg;
  $("toast").appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function api(path, body) {
  const opt = { headers: { "Content-Type": "application/json" } };
  if (state.token) opt.headers.Authorization = "Bearer " + state.token;
  if (body !== undefined) { opt.method = "POST"; opt.body = JSON.stringify(body); }
  const res = await fetch("/api/v2" + path, opt);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) { logout(true); throw new Error("Сессия истекла"); }
  if (!res.ok || data.success === false) throw new Error(data.error || "Ошибка запроса");
  return data;
}

async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg || r?.message) toast(okMsg || r.message); return r; }
  catch (e) { toast(e.message, true); return null; }
}

function modal(title, html, narrow) {
  $("modalRoot").innerHTML = `<div class="overlay" onmousedown="if(event.target===this)closeModal()">
    <div class="modal ${narrow ? "narrow" : ""}"><div class="modal-head"><h2>${title}</h2>
    <button class="btn ghost sm" onclick="closeModal()">✕</button></div>${html}</div></div>`;
}
function closeModal() { $("modalRoot").innerHTML = ""; }

const table = (head, rows, empty = "Нет данных") => rows.length
  ? `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`
  : `<div class="empty">${empty}</div>`;

// ---------- тема ----------
$("themeToggle").onclick = () => {
  const r = document.documentElement, dark = r.getAttribute("data-theme") === "dark";
  dark ? r.removeAttribute("data-theme") : r.setAttribute("data-theme", "dark");
  localStorage.setItem("theme", dark ? "light" : "dark");
};

// ---------- вход ----------
function renderLogin(register) {
  $("app").innerHTML = `<div class="login card">
    <h1 style="display:flex;align-items:center;gap:10px;line-height:1"><img src="/favicon.png" alt="" style="width:32px;height:32px;object-fit:contain;display:block;flex-shrink:0;transform:translateY(2px)"><span style="line-height:1">My <span style="color:var(--red)">Dyatel</span></span></h1>
    <p class="muted" style="margin-bottom:14px">${register ? "Регистрация пациента" : "Вход в портал"}</p>
    <form onsubmit="${register ? "doRegister" : "doLogin"}(event)">
      ${register ? `<div class="field"><label>ФИО</label><input name="full_name" required></div>
      <div class="field"><label>Дата рождения</label><input name="birth_date" type="date" required></div>
      <div class="field"><label>Телефон</label><input name="phone"></div>` : ""}
      <div class="field"><label>ИИН (12 цифр)</label><input name="iin" maxlength="12" pattern="\\d{12}" required autofocus></div>
      <div class="field"><label>Пароль</label><input name="password" type="password" required ${register ? 'minlength="6"' : ""}></div>
      <button class="btn" style="width:100%">${register ? "Зарегистрироваться" : "Войти"}</button>
    </form>
    <p style="margin-top:12px"><a href="#" onclick="renderLogin(${!register});return false" style="color:var(--red)">${register ? "← Ко входу" : "Я новый пациент — регистрация"}</a></p>
  </div>`;
}
const formData = e => { e.preventDefault(); return Object.fromEntries(new FormData(e.target)); };

async function doLogin(e) { const r = await act(() => api("/login", formData(e))); if (r) start(r); }
async function doRegister(e) { const r = await act(() => api("/register", formData(e))); if (r) start(r); }
function start(r) { state.token = r.token; state.user = r.user; localStorage.setItem("token", r.token); state.tab = null; renderShell(); }
async function logout(silent) {
  if (!silent) try { await api("/logout", {}); } catch (_) {}
  state.token = null; state.user = null; localStorage.removeItem("token"); renderLogin();
}

// ---------- каркас ----------
const TABS = {
  patient: [["home", "Главная"], ["orders", "Заказы"], ["visits", "Записи"], ["profile", "Профиль"]],
  doctor: [["cabinet", "Цифровой кабинет"], ["patients", "Пациенты"], ["profile", "Профиль"]],
  nurse: [["cabinet", "Цифровой кабинет"], ["patients", "Пациенты"], ["profile", "Профиль"]],
  superadmin: [["overview", "Обзор"], ["doctors", "Врачи"], ["nurses", "Медсёстры"], ["cabinets", "Кабинеты"], ["queue", "Все записи"], ["patients", "Пациенты"], ["audit", "Журнал и бэкапы"], ["profile", "Профиль"]]
};

function renderShell() {
  const u = state.user, tabs = TABS[u.role];
  if (!state.tab || !tabs.some(t => t[0] === state.tab)) state.tab = tabs[0][0];
  const sub = u.role === "doctor" ? `${esc(u.specialty)} · каб. ${esc(u.cabinet_num)}`
    : u.role === "nurse" ? `Мед. сестра врача: ${esc(u.doctor_name || "—")}` : ROLE_NAMES[u.role];
  $("app").innerHTML = `<div class="topbar"><div class="logo" style="display:flex;align-items:center;gap:8px;line-height:1"><img src="/favicon.png" alt="" style="width:28px;height:28px;object-fit:contain;display:block;flex-shrink:0;transform:translateY(2px)"><span style="line-height:1;transform:translateY(-1px)">My <b>Dyatel</b></span></div>
    <div class="who"><b>${esc(u.full_name)}</b><small>${sub}</small></div>
    <button class="btn ghost sm" onclick="logout()">Выйти</button></div>
    <div class="tabs">${tabs.map(t => `<button class="tab ${t[0] === state.tab ? "active" : ""}" onclick="go('${t[0]}')">${t[1]}</button>`).join("")}</div>
    <main id="view" class="${state.tab === "cabinet" ? "wide" : ""}"></main>`;
  Promise.resolve(VIEWS[state.tab]()).catch(e => toast(e.message, true));
}
function go(tab) { state.tab = tab; renderShell(); }
function refresh() { Promise.resolve(VIEWS[state.tab]()).catch(e => toast(e.message, true)); }

// ---------- общие компоненты ----------
function profileView() {
  const u = state.user;
  const sigCard = u.role === "doctor" ? `<div class="card"><h3>Личная подпись врача (1:1)</h3>
    <p class="muted small" style="margin-bottom:10px">Используется на печатных справках, больничных, рецептах и направлениях.</p>
    <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
      <div class="sig-preview">${u.signature_data ? `<img src="${u.signature_data}" alt="Подпись врача">` : `<span class="muted small">Подпись не задана</span>`}</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn" onclick="openSignaturePad()">${u.signature_data ? "Изменить подпись" : "Нарисовать подпись"}</button>
        ${u.signature_data ? `<button class="btn ghost sm" onclick="clearSignature()">Удалить подпись</button>` : ""}
      </div>
    </div></div>` : "";
  $("view").innerHTML = `<div class="card"><h3>Мои данные</h3><div class="kv">
      <div><span>ФИО</span>${esc(u.full_name)}</div><div><span>ИИН</span>${esc(u.iin)}</div>
      <div><span>Роль</span>${ROLE_NAMES[u.role]}</div>
      ${u.phone ? `<div><span>Телефон</span>${esc(u.phone)}</div>` : ""}
      ${u.birth_date ? `<div><span>Дата рождения</span>${fmtDate(u.birth_date)} (${calcAge(u.birth_date)})</div>
      <div><span>Участок</span>${esc(u.district || "не указан")}</div>
      <div><span>Поликлиника</span>${esc(u.clinic || "не указана")}</div>
      <div><span>Статус ОСМС</span>${esc(u.osms_status || "Не указан")}</div>
      <div><span>Группа крови</span>${esc(u.blood_group)}</div>
      <div><span>Аллергии</span>${esc(u.allergies || "—")}</div><div><span>Хронические</span>${esc(u.chronic_diseases || "—")}</div>` : ""}
    </div></div>
    <div class="${u.role === "doctor" ? "grid2" : ""}">
      <div class="card" style="${u.role === "doctor" ? "" : "max-width:380px"}"><h3>Смена пароля</h3>
      <form onsubmit="changePassword(event)">
        <div class="field"><label>Текущий пароль</label><input type="password" name="old" required></div>
        <div class="field"><label>Новый пароль (от 6 символов)</label><input type="password" name="new" minlength="6" required></div>
        <button class="btn">Сохранить</button></form></div>
      ${sigCard}
    </div>`;
}
async function clearSignature() {
  const r = await act(() => api("/doctor/signature", { signature_data: "" }), "Подпись удалена");
  if (r && r.user) { state.user = r.user; profileView(); }
}
async function changePassword(e) {
  const f = e.target, r = await act(() => api("/password", formData(e)));
  if (r) {
    f.reset();
    if (r.user) { state.user = r.user; renderShell(); }
  }
}

function apptRows(list, role) {
  return list.map(a => [
    `${fmtDate(a.app_date)}<br><b>${a.time_slot}</b>`,
    role === "patient" ? `${esc(a.doctor_name)}<br><span class="muted small">${esc(a.specialty)} · каб. ${esc(a.cabinet_num)}</span>`
      : `<a href="#" onclick="openPatient(${a.patient_id});return false" style="color:var(--red)">${esc(a.patient_name)}</a><br><span class="muted small">${esc(a.patient_iin)}${role === "superadmin" ? " · " + esc(a.doctor_name) : ""}</span>`,
    esc(a.complaint || "—"), esc(a.diagnosis || "—"), badge(a.status)
  ]);
}

function fmtLabResult(l) {
  let res = l.result || l.result_json;
  if (typeof res === "string") { try { res = JSON.parse(res); } catch (_) {} }
  return res && typeof res === "object" ? Object.entries(res).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join("<br>") : esc(res || "—");
}

// карточка пациента (используется врачом, медсестрой, админом и самим пациентом)
function cardHtml(card, viewerRole) {
  const sections = {
    history: ["Приёмы", () => table(["Дата", "Врач", "Повод обращения", "Диагноз", "Место", ""], card.appointments.map(a => [
      `${fmtDate(a.app_date)} ${a.time_slot}`, `${esc(a.doctor_name)}<br><span class="muted small">${esc(a.specialty)}</span>`,
      esc(a.complaint || "—"), esc(a.diagnosis || "—"), esc(a.place || "Поликлиника"), badge(a.status)]), "Приёмов пока нет")],
    dx: ["Диагнозы", () => table(["Дата", "Врач", "Диагноз", "Запись"], card.records.map(r => [
      fmtDate(r.created_at), `${esc(r.doctor_name)}<br><span class="muted small">${esc(r.doctor_specialty)}</span>`,
      `<b>${esc(r.diagnosis)}</b>`, esc(r.title)]), "Диагнозов пока нет")],
    labs: ["Анализы", () => table(["Дата", "Анализ", "Результат", "Статус"], card.labs.map(l => [
      fmtDate(l.completed_at || l.created_at), esc(l.test_type), fmtLabResult(l) +
        (l.doctor_comment ? `<br><span class="muted small">${esc(l.doctor_comment)}</span>` : ""), badge(l.status)
    ]), "Анализов нет")],
    imaging: ["Снимки и рентген", () => table(["Дата", "Исследование", "Заключение", "Врач"], card.imaging.map(i => [
      fmtDate(i.study_date), `<b>${esc(i.study_type)}</b><br><span class="muted small">${esc(i.body_part)}</span>`,
      esc(i.conclusion), esc(i.doctor_name)]), "Рентген и других снимков нет")],
    rx: ["Рецепты", () => table(["Дата", "Препарат", "Приём", "Врач", "Статус", ""], card.prescriptions.map((p, i) => [
      fmtDate(p.created_at), `<b>${esc(p.medication)}</b>`, `${esc(p.dosage)}<br><span class="muted small">${esc(p.instructions)}</span>`,
      esc(p.doctor_name), badge(p.status), `<button class="btn ghost sm" onclick="printRx(${i})">Печать / PDF</button>`]), "Рецептов нет")],
    ref: ["Направления", () => table(["Дата", "Куда", "Причина", "От кого", "Статус", ""], card.referrals.map((r, i) => [
      fmtDate(r.created_at), `<b>${esc(r.to_specialty)}</b>`, esc(r.reason), esc(r.doctor_from_name || "—"), badge(r.status),
      `<button class="btn ghost sm" onclick="printReferral(${i})">Печать / PDF</button>`]), "Направлений нет")],
    docs: ["Документы", () =>
      `<h3 style="margin:4px 0">Больничные листы</h3>` + table(["Номер", "Период", "Диагноз", "Статус", ""], card.sick_leaves.map((s, i) => [
        esc(s.eln_number), `${fmtDate(s.start_date)} — ${fmtDate(s.end_date)} (${s.days_count} дн.)`, esc(s.diagnosis), badge(s.status),
        `<button class="btn ghost sm" onclick="printSickLeave(${i})">Печать / PDF</button>` +
        (viewerRole === "doctor" && s.status === "active" ? ` <button class="btn ghost sm" onclick="closeSickLeave(${s.id},${card.profile.id})">Закрыть</button>` : "")]), "Нет") +
      `<h3 style="margin:14px 0 4px">Справки</h3>` + table(["Дата", "Справка", "Куда", "Действует до", ""], card.certificates.map((c, i) => [
        fmtDate(c.created_at), esc(c.title), esc(c.target_org), fmtDate(c.valid_until),
        `<button class="btn ghost sm" onclick="printCert(${i})">Печать / PDF</button>`]), "Нет") +
      `<h3 style="margin:14px 0 4px">Прививки</h3>` + table(["Дата", "Вакцина", "Доза", "Реакция"], card.vaccinations.map(v => [
        fmtDate(v.date_given), esc(v.vaccine_name), esc(v.dose_number), esc(v.reaction)]), "Нет")]
  };
  state.cache.sections = sections;
  state.cache.cardProfile = card.profile;
  state.cache.printDocs = {
    sl: card.sick_leaves || [],
    cert: card.certificates || [],
    rx: card.prescriptions || [],
    ref: card.referrals || [],
    profile: card.profile || {}
  };
  const p = card.profile;
  const head = `<div class="card"><div class="row between"><div><b style="font-size:16px">${esc(p.full_name)}</b>
    <div class="muted small">ИИН ${esc(p.iin)} · ${fmtDate(p.birth_date)} (${calcAge(p.birth_date)}) · ${esc(p.phone || "телефон не указан")}</div></div>
    <div class="row">${viewerRole === "doctor" || viewerRole === "nurse" ? `<button class="btn sm" onclick="referralForm(${p.id})">Дать направление</button>` : ""}
    ${viewerRole === "doctor" ? `<button class="btn ghost sm" onclick="imagingForm(${p.id})">+ Снимок</button>
      <button class="btn ghost sm" onclick="sickLeaveForm(${p.id})">+ Больничный</button>
      <button class="btn ghost sm" onclick="certificateForm(${p.id})">+ Справка</button>` : ""}
    ${viewerRole !== "patient" ? `<button class="btn ghost sm" onclick="bookForStaff(${p.id})">Записать</button>
      <button class="btn ghost sm" onclick="attachForm(${p.id})">Прикрепление / ОСМС</button>` : ""}</div></div>
    <div class="kv" style="margin-top:10px"><div><span>Участок</span>${esc(p.district || "не указан")}</div><div><span>Поликлиника</span>${esc(p.clinic || "не указана")}</div>
    <div><span>ОСМС</span>${esc(p.osms_status || "Не указан")}${p.osms_until ? " (до " + fmtDate(p.osms_until) + ")" : ""}</div><div><span>Группа крови</span>${esc(p.blood_group)}</div>
    <div><span>Аллергии</span>${esc(p.allergies || "—")}</div><div><span>Хронические</span>${esc(p.chronic_diseases || "—")}</div></div></div>`;
  const keys = Object.keys(sections);
  return head + `<div class="subtabs">${keys.map((k, i) => `<button class="chip ${i === 0 ? "active" : ""}" data-sec="${k}" onclick="showSection('${k}',this)">${sections[k][0]}${count(card, k)}</button>`).join("")}</div>
    <div class="card" id="secBody">${sections[keys[0]][1]()}</div>`;
}
function count(card, k) {
  const n = { history: card.appointments, dx: card.records, labs: card.labs, imaging: card.imaging, rx: card.prescriptions, ref: card.referrals }[k];
  return n && n.length ? ` <span style="opacity:.7">${n.length}</span>` : "";
}
function showSection(k, btn) {
  document.querySelectorAll(".chip[data-sec]").forEach(c => c.classList.toggle("active", c === btn));
  $("secBody").innerHTML = state.cache.sections[k][1]();
}

async function openPatient(id) {
  const r = await act(() => api("/patient/card?id=" + id));
  if (!r) return;
  state.cache.patientId = id;
  modal("Карта пациента", cardHtml(r.card, state.user.role));
}

function attachForm(pid) {
  const p = state.cache.cardProfile || {};
  modal("Прикрепление и статус ОСМС", `<form onsubmit="saveAttach(event,${pid})">
    <div class="field"><label>Поликлиника прикрепления</label><input name="clinic" value="${esc(p.clinic || "Городская поликлиника №1")}" placeholder="Например: Городская поликлиника №1"></div>
    <div class="field"><label>Участок</label><input name="district" value="${esc(p.district || "")}" placeholder="Например: Участок №5 (ВОП)"></div>
    <div class="grid2">
      <div class="field"><label>Статус ОСМС</label><select name="osms_status">
        <option ${p.osms_status === "Застрахован" ? "selected" : ""}>Застрахован</option>
        <option ${p.osms_status === "Не застрахован" ? "selected" : ""}>Не застрахован</option>
        <option ${!p.osms_status || p.osms_status === "Не указан" ? "selected" : ""}>Не указан</option>
      </select></div>
      <div class="field"><label>Действует до</label><input type="date" name="osms_until" value="${esc((p.osms_until || "").slice(0, 10))}"></div>
    </div>
    <button class="btn">Сохранить</button></form>`, true);
}
async function saveAttach(e, pid) {
  const d = formData(e); d.id = pid;
  if (await act(() => api("/patient/update", d))) { closeModal(); if (state.tab === "cabinet") refresh(); else openPatient(pid); }
}

function referralForm(pid, apptId) {
  api("/doctors").then(r => {
    modal("Добавить направление", `<form onsubmit="saveReferral(event,${pid},${apptId || 0})">
      <div class="field"><label>Куда направляем</label><input name="to_specialty" list="specs" placeholder="Например: Рентген, УЗИ, Кардиолог, ОАК" required>
      <datalist id="specs">${[...new Set(r.doctors.map(d => d.specialty))].map(s => `<option value="${esc(s)}">`).join("")}<option value="Рентген"><option value="УЗИ"><option value="Флюорография"><option value="Анализы крови"></datalist></div>
      <div class="field"><label>Конкретный врач (необязательно)</label><select name="target_doctor_id"><option value="">Любой / диагностический кабинет</option>
      ${r.doctors.map(d => `<option value="${d.id}">${esc(d.full_name)} — ${esc(d.specialty)}</option>`).join("")}</select></div>
      <div class="field"><label>Причина / диагноз при направлении</label><textarea name="reason" rows="3" required></textarea></div>
      <button class="btn">Выдать направление</button></form>`, true);
  });
}
async function saveReferral(e, pid, apptId) {
  const d = formData(e); d.patient_id = pid;
  if (apptId) d.appointment_id = apptId;
  if (await act(() => api("/referrals/create", d))) {
    closeModal();
    if (apptId && state.tab === "cabinet") selectAppt(apptId);
    else openPatient(pid);
  }
}

function imagingForm(pid, apptId) {
  modal("Добавить снимок / исследование", `<form onsubmit="saveImaging(event,${pid},${apptId || 0})">
    <div class="grid2"><div class="field"><label>Вид</label><select name="study_type"><option>Рентген</option><option>УЗИ</option><option>КТ</option><option>МРТ</option><option>ЭКГ</option><option>Флюорография</option></select></div>
    <div class="field"><label>Дата</label><input type="date" name="study_date" value="${today()}"></div></div>
    <div class="field"><label>Область исследования</label><input name="body_part" placeholder="Например: органы грудной клетки" required></div>
    <div class="field"><label>Заключение</label><textarea name="conclusion" rows="3" required></textarea></div>
    <button class="btn">Сохранить</button></form>`, true);
}
async function saveImaging(e, pid, apptId) {
  const d = formData(e); d.patient_id = pid;
  if (apptId) d.appointment_id = apptId;
  if (await act(() => api("/imaging/create", d))) {
    closeModal();
    if (apptId && state.tab === "cabinet") selectAppt(apptId);
    else openPatient(pid);
  }
}

function labForm(apptId) {
  modal("Прикрепить анализ к приёму", `<form onsubmit="saveLab(event,${apptId})">
    <div class="field"><label>Название анализа</label><input name="test_type" list="labTypes" placeholder="Например: Общий анализ крови (ОАК)" required>
      <datalist id="labTypes"><option value="Общий анализ крови (ОАК)"><option value="Общий анализ мочи (ОАМ)"><option value="Биохимия крови"><option value="Глюкоза крови"><option value="Коагулограмма"></datalist></div>
    <div class="field"><label>Результат (если уже готов)</label><textarea name="result" rows="2" placeholder="Оставьте пустым, если анализ только назначен"></textarea></div>
    <div class="grid2">
      <div class="field"><label>Норма / референс</label><input name="normal_range" placeholder="В пределах нормы"></div>
      <div class="field"><label>Комментарий</label><input name="comment"></div>
    </div>
    <button class="btn">Прикрепить</button></form>`, true);
}
async function saveLab(e, apptId) {
  const d = formData(e); d.appointment_id = apptId;
  if (await act(() => api("/labs/add", d))) { closeModal(); selectAppt(apptId); }
}

function labResultModal(labId, apptId) {
  const title = (state.cache.labTitles || {})[labId] || "Анализ";
  modal(`Результат: ${esc(title)}`, `<form onsubmit="saveLabResult(event,${labId},${apptId})">
    <div class="field"><label>Результат анализа</label><textarea name="result" rows="3" required autofocus></textarea></div>
    <button class="btn">Сохранить результат</button></form>`, true);
}
async function saveLabResult(e, labId, apptId) {
  const d = formData(e); d.id = labId;
  if (await act(() => api("/labs/result", d))) { closeModal(); selectAppt(apptId); }
}

// запись пациента сотрудником
async function bookForStaff(pid) {
  const u = state.user;
  let docField = "";
  if (u.role === "superadmin") {
    const r = await api("/doctors");
    if (!r.doctors.length) return toast("Сначала добавьте врача", true);
    docField = `<div class="field"><label>Врач</label><select name="doctor_id" id="bkDoc" onchange="loadSlots()">${r.doctors.map(d => `<option value="${d.id}">${esc(d.full_name)} — ${esc(d.specialty)}</option>`).join("")}</select></div>`;
  } else docField = `<input type="hidden" id="bkDoc" value="${u.role === "doctor" ? u.id : u.doctor_id}">`;
  modal("Записать на приём", bookFormHtml(docField, `saveBooking(${pid})`, true), true);
  loadSlots();
}

async function bookFromQueueModal() {
  const pRes = await act(() => api("/patients?q="));
  if (!pRes) return;
  if (!pRes.patients.length) return newPatientForm();
  const u = state.user;
  const docId = u.role === "doctor" ? u.id : u.doctor_id;
  const patField = `<div class="field"><label>Пациент (<a href="#" onclick="newPatientForm();return false" style="color:var(--red)">+ создать нового</a>)</label>
    <select id="bkPat" required>${pRes.patients.map(p => `<option value="${p.id}">${esc(p.full_name)} (${esc(p.iin)})</option>`).join("")}</select></div>
    <input type="hidden" id="bkDoc" value="${docId}">`;
  modal("Записать пациента в очередь", bookFormHtml(patField, "saveBooking($('bkPat').value)", true), true);
  loadSlots();
}

function bookFormHtml(docField, onSubmit, staff) {
  const staffFields = staff ? `<div class="grid2"><div class="field"><label>Направитель</label><input id="bkOrg" value="Поликлиника"></div>
    <div class="field"><label>Направивший врач (ФИО)</label><input id="bkRefDoc" placeholder="ФИО направившего врача"></div></div>
    <div class="field"><label>Место оказания</label><select id="bkPlace"><option value="Поликлиника">Поликлиника</option><option value="На дому">На дому</option></select></div>` : "";
  return `<form onsubmit="${onSubmit};return false">${docField}
    <div class="field"><label>Дата</label><input type="date" id="bkDate" min="${today()}" value="${today()}" onchange="loadSlots()"></div>
    <div class="field"><label>Время</label><div class="slots" id="bkSlots"></div></div>
    ${staffFields}
    <div class="field"><label>${staff ? "Повод обращения" : "Жалоба / повод обращения"}</label><textarea id="bkComplaint" rows="2" placeholder="Опишите повод обращения"></textarea></div>
    <button class="btn">Записать</button></form>`;
}
async function loadSlots() {
  const doc = $("bkDoc")?.value, date = $("bkDate")?.value;
  if (!doc || !date) return;
  const r = await act(() => api(`/slots?doctor_id=${doc}&date=${date}`));
  if (!r) return;
  state.cache.slot = null;
  $("bkSlots").innerHTML = r.slots.map(s => `<button type="button" class="slot" ${s.free ? "" : "disabled"} onclick="pickSlot(this,'${s.time}')">${s.time}</button>`).join("");
}
function pickSlot(btn, t) {
  document.querySelectorAll(".slot").forEach(b => b.classList.remove("sel"));
  btn.classList.add("sel"); state.cache.slot = t;
}
async function saveBooking(pid) {
  if (!state.cache.slot) return toast("Выберите свободное время", true);
  const d = { doctor_id: $("bkDoc").value, date: $("bkDate").value, time: state.cache.slot, complaint: $("bkComplaint").value };
  if (pid) {
    d.patient_id = pid;
    d.referrer_org = $("bkOrg")?.value; d.referrer_doctor = $("bkRefDoc")?.value; d.place = $("bkPlace")?.value;
  }
  if (await act(() => api("/appointments/book", d))) { closeModal(); refresh(); }
}

async function cancelAppt(id) {
  if (!confirm("Отменить запись?")) return;
  if (await act(() => api("/appointments/cancel", { id }))) refresh();
}

function newPatientForm() {
  modal("Новый пациент", `<form onsubmit="saveNewPatient(event)">
    <div class="field"><label>ФИО пациента *</label><input name="full_name" required></div>
    <div class="grid2">
      <div class="field"><label>ИИН (12 цифр) *</label><input name="iin" maxlength="12" pattern="\\d{12}" required></div>
      <div class="field"><label>Дата рождения *</label><input name="birth_date" type="date" required></div>
    </div>
    <div class="grid2">
      <div class="field"><label>Участок</label><input name="district" placeholder="Например: Участок №3"></div>
      <div class="field"><label>Поликлиника</label><input name="clinic" value="Городская поликлиника"></div>
    </div>
    <div class="grid2">
      <div class="field"><label>Телефон</label><input name="phone"></div>
      <div class="field"><label>Временный пароль (необязательно)</label><input name="password" placeholder="Пусто — автогенерация"></div>
    </div>
    <button class="btn">Создать карту пациента</button></form>`, true);
}
function showTempPasswordModal(roleLabel, r) {
  if (!r || !r.temp_password) return;
  modal(`${esc(roleLabel)} создан`, `<p>${esc(r.message || "")}</p>
    <div class="card" style="text-align:center;font-size:18px;letter-spacing:1px"><b>${esc(r.temp_password)}</b></div>
    <p class="muted small">Передайте временный пароль пользователю.</p>
    <button class="btn" style="width:100%" onclick="closeModal()">Понятно</button>`, true);
}
async function saveNewPatient(e) {
  const r = await act(() => api("/patients/create", formData(e)));
  if (r) { closeModal(); refresh(); showTempPasswordModal("Пациент", r); }
}

// ==================== ПАЦИЕНТ ====================
const VIEWS = {};

VIEWS.home = async () => {
  const [cardRes, docsRes] = await Promise.all([api("/my/card"), api("/doctors")]);
  const card = cardRes.card, docs = docsRes.doctors, p = card.profile;
  state.cache.myCard = card;
  state.cache.clinicDocs = docs;
  const sec = state.cache.ptHome || "clinic";

  const tiles = `<div class="patient-tiles">
    <button type="button" class="pt-tile ${sec === "osms" ? "active" : ""}" onclick="switchPtHome('osms')">
      <span class="t-icon">🛡️</span>
      <span class="t-title">Пакет ОСМС</span>
      <span class="t-sub">Статус: ${esc(p.osms_status || "Не указан")}</span>
    </button>
    <button type="button" class="pt-tile ${sec === "clinic" ? "active" : ""}" onclick="switchPtHome('clinic')">
      <span class="t-icon">🏥</span>
      <span class="t-title">Моя поликлиника</span>
      <span class="t-sub">${esc(p.clinic || "Прикрепление и запись к врачу")}</span>
    </button>
    <button type="button" class="pt-tile ${sec === "data" ? "active" : ""}" onclick="switchPtHome('data')">
      <span class="t-icon">🗂️</span>
      <span class="t-title">Мои данные</span>
      <span class="t-sub">Медкарта, рентген, анализы, рецепты</span>
    </button>
  </div>`;

  let body = "";
  if (sec === "osms") {
    body = `<div class="card"><h3>Пакет ОСМС</h3>
      <div class="kv">
        <div><span>Статус страхования</span><b>${esc(p.osms_status || "Не указан")}</b></div>
        <div><span>Срок действия</span>${p.osms_until ? fmtDate(p.osms_until) : "Бессрочно / по данным фонда"}</div>
        <div><span>Организация прикрепления</span>${esc(p.clinic || "Не указана")}</div>
        <div><span>Участок</span>${esc(p.district || "Не указан")}</div>
      </div>
      <div class="muted small" style="margin-top:12px">В пакет входят: приём участкового врача, консультации профильных специалистов по направлению, лабораторные анализы и инструментальная диагностика (рентген, УЗИ, ЭКГ).</div>
    </div>`;
  } else if (sec === "clinic") {
    const upcoming = card.appointments.filter(a => ["confirmed", "pending", "in_progress"].includes(a.status));
    body = `<div class="card"><div class="row between">
        <div><h3 style="margin:0">${esc(p.clinic || "Моя поликлиника")}</h3>
          <div class="muted small">Участок: ${esc(p.district || "не указан")} · Пациент: ${esc(p.full_name)}</div></div>
        <button class="btn" onclick="newBooking()">+ Записаться к врачу</button>
      </div></div>
      <div class="card"><h3>Ближайшие приёмы</h3>
        ${table(["Дата и время", "Врач", "Повод обращения", "Место", "Статус", ""], upcoming.map(a => [
          `${fmtDate(a.app_date)} <b>${a.time_slot}</b>`,
          `${esc(a.doctor_name)}<br><span class="muted small">${esc(a.specialty)} · каб. ${esc(a.cabinet_num)}</span>`,
          esc(a.complaint || "—"), esc(a.place || "Поликлиника"), badge(a.status),
          `<button class="btn danger sm" onclick="cancelAppt(${a.id})">Отменить</button>`
        ]), "Нет активных записей")}
      </div>
      <div class="card"><h3>Врачи поликлиники</h3>
        ${table(["ФИО врача", "Специальность", "Кабинет", "Часы приёма", ""], docs.map(d => [
          `<b>${esc(d.full_name)}</b>`, esc(d.specialty), esc(d.cabinet_num), esc(d.work_hours || "09:00 - 17:00"),
          `<button class="btn ghost sm" onclick="newBooking(${d.id})">Записаться</button>`
        ]), "Врачи ещё не добавлены администратором")}
      </div>`;
  } else {
    body = cardHtml(card, "patient");
  }

  const upcomingAll = card.appointments.filter(a => ["confirmed", "pending", "in_progress"].includes(a.status));
  const activeRefs = card.referrals.filter(r => r.status === "active");
  const notice = (upcomingAll.length || activeRefs.length)
    ? `<div class="card" style="border-left:4px solid var(--red);padding:10px 14px"><b>Напоминание:</b> ${upcomingAll.length ? `у вас запланировано приёмов: <b>${upcomingAll.length}</b>` : ""}${upcomingAll.length && activeRefs.length ? " · " : ""}${activeRefs.length ? `активных направлений: <b>${activeRefs.length}</b> (см. «Заказы»)` : ""}</div>`
    : "";

  $("view").innerHTML = notice + tiles + body;
};

function switchPtHome(sec) { state.cache.ptHome = sec; VIEWS.home(); }

VIEWS.orders = async () => {
  const r = await api("/my/card"), orders = r.card.orders || [];
  $("view").innerHTML = `<div class="card"><h3>Заказы и направления</h3>
    <p class="muted small" style="margin-bottom:10px">Все ваши записи к врачам, выданные направления на рентген и диагностику, назначенные анализы и рецепты.</p>
    ${orders.length ? orders.map(o => `<div class="order-item">
      <div><span class="badge" style="margin-right:8px">${esc(o.kind)}</span>${esc(o.text)}</div>
      <div class="muted small" style="white-space:nowrap">${fmtDate(o.date)}</div>
    </div>`).join("") : `<div class="empty">Заказов и направлений пока нет</div>`}
  </div>`;
};

VIEWS.visits = async () => {
  const r = await api("/my/card"), card = r.card;
  const upcoming = card.appointments.filter(a => ["confirmed", "pending", "in_progress"].includes(a.status));
  $("view").innerHTML = `<div class="card"><div class="row between"><h3 style="margin:0">Предстоящие записи</h3>
    <button class="btn" onclick="newBooking()">+ Записаться к врачу</button></div>
    ${table(["Дата", "Врач", "Повод обращения", "Место", "", ""], upcoming.map(a => [`${fmtDate(a.app_date)} <b>${a.time_slot}</b>`,
      `${esc(a.doctor_name)}<br><span class="muted small">${esc(a.specialty)} · каб. ${esc(a.cabinet_num)}</span>`, esc(a.complaint || "—"),
      esc(a.place || "Поликлиника"), badge(a.status), `<button class="btn danger sm" onclick="cancelAppt(${a.id})">Отменить</button>`]), "Нет предстоящих записей")}</div>
    <div class="card"><h3>Прошлые записи</h3>${table(["Дата", "Врач", "Повод обращения", "Диагноз", ""],
      card.appointments.filter(a => !upcoming.includes(a)).map(a => [`${fmtDate(a.app_date)} ${a.time_slot}`, `${esc(a.doctor_name)}<br><span class="muted small">${esc(a.specialty)}</span>`,
        esc(a.complaint || "—"), esc(a.diagnosis || "—"), badge(a.status)]), "Пока пусто")}</div>`;
};

async function newBooking(preDocId) {
  const r = await api("/doctors");
  if (!r.doctors.length) return toast("В системе пока нет врачей. Обратитесь к администратору.", true);
  const field = `<div class="field"><label>Врач</label><select id="bkDoc" onchange="loadSlots()">${r.doctors.map(d =>
    `<option value="${d.id}" ${d.id === preDocId ? "selected" : ""}>${esc(d.specialty)} — ${esc(d.full_name)} (каб. ${esc(d.cabinet_num)})</option>`).join("")}</select></div>`;
  modal("Запись к врачу", bookFormHtml(field, "saveBooking()"), true);
  loadSlots();
}

VIEWS.profile = profileView;

// ==================== ЦИФРОВОЙ КАБИНЕТ ВРАЧА И МЕДСЕСТРЫ ====================
VIEWS.cabinet = async () => {
  const u = state.user;
  if (u.role === "nurse" && !u.doctor_id) {
    $("view").innerHTML = `<div class="card empty">Вы ещё не привязаны к врачу. Обратитесь к администратору.</div>`;
    return;
  }
  const date = state.cache.qDate ?? today();
  state.cache.qDate = date;
  const r = await api(`/queue?date=${state.cache.qAll ? "" : date}`);
  const list = r.appointments;
  state.cache.queueList = list;

  if (!list.some(a => a.id === state.cache.activeApptId)) {
    const firstActive = list.find(a => a.status !== "completed" && a.status !== "cancelled") || list[0];
    state.cache.activeApptId = firstActive ? firstActive.id : null;
  }

  $("view").innerHTML = `<div class="cabinet-grid">
    <div class="card">
      <div class="row between" style="margin-bottom:8px">
        <h3 style="margin:0">Очередь</h3>
        <button class="btn sm" onclick="bookFromQueueModal()">+ Записать</button>
      </div>
      <div class="row">
        <input type="date" value="${date}" style="flex:1" onchange="state.cache.qDate=this.value;state.cache.qAll=false;refresh()">
        <button class="btn ghost sm" onclick="state.cache.qAll=!state.cache.qAll;refresh()">${state.cache.qAll ? "На дату" : "Все"}</button>
      </div>
      <div class="q-list" id="qList">
        ${list.length ? list.map(a => `<button type="button" class="q-item ${a.id === state.cache.activeApptId ? "active" : ""}" data-aid="${a.id}" onclick="selectAppt(${a.id})">
          <div class="row between"><b>${a.time_slot}</b>${badge(a.status)}</div>
          <div style="font-weight:600;margin-top:2px">${esc(a.patient_name)}</div>
          <div class="muted small">${fmtDate(a.app_date)} · ${esc(a.complaint || "Без повода")}</div>
        </button>`).join("") : `<div class="empty">В очереди никого нет</div>`}
      </div>
    </div>
    <div id="cabCenter"><div class="card empty">Выберите пациента в очереди слева или запишите нового</div></div>
    <div id="cabRight"><div class="card empty">Прикреплённые анализы появятся при выборе приёма</div></div>
  </div>`;

  if (state.cache.activeApptId) selectAppt(state.cache.activeApptId);
};

async function selectAppt(id) {
  state.cache.activeApptId = id;
  document.querySelectorAll(".q-item").forEach(el => el.classList.toggle("active", Number(el.dataset.aid) === id));
  const r = await act(() => api("/appointment?id=" + id));
  if (!r || !$("cabCenter")) return;
  let a = r.appointment;
  const p = r.patient, u = state.user;
  if (u.role === "doctor" && (a.status === "confirmed" || a.status === "pending")) {
    await api("/appointments/start", { id }).catch(() => {});
    a.status = "in_progress";
  }
  const editable = a.status !== "completed" && a.status !== "cancelled";
  state.cache.rx = 0;
  state.cache.cardProfile = p;

  $("cabCenter").innerHTML = `<div class="card">
    <div class="visit-banner">
      <div class="row between">
        <span class="muted small" style="text-transform:uppercase;font-weight:700;letter-spacing:.5px">Активный приём · ${fmtDate(a.app_date)} ${a.time_slot}</span>
        <div class="row">${badge(a.status)} <button class="btn ghost sm" onclick="openPatient(${p.id})">Медкарта</button>
          <button class="btn ghost sm" onclick="attachForm(${p.id})">Участок / ОСМС</button></div>
      </div>
      <div class="pt-line">${esc(p.full_name)} · ${fmtDate(p.birth_date)} (${calcAge(p.birth_date)}) · Участок: ${esc(p.district || "не указан")}</div>
      <div class="iin-line">ИИН: <b>${esc(p.iin)}</b>${p.phone ? ` · Тел.: ${esc(p.phone)}` : ""}${p.allergies && p.allergies !== "Не выявлено" ? ` · <span style="color:var(--red)">Аллергии: ${esc(p.allergies)}</span>` : ""}</div>
    </div>

    <div class="visit-meta">
      <div class="lbl">Направитель:</div>
      <div><input id="vRefOrg" value="${esc(a.referrer_org || "Поликлиника")}" placeholder="Например: Поликлиника"></div>
      <div class="lbl">Направивший врач:</div>
      <div><input id="vRefDoc" value="${esc(a.referrer_doctor || "")}" placeholder="ФИО направившего врача"></div>
      <div class="lbl">Повод обращения:</div>
      <div><textarea id="vComplaint" rows="2" placeholder="Заполняет врач или медсестра, принимающая заявку">${esc(a.complaint || "")}</textarea></div>
      <div class="lbl">Место оказания:</div>
      <div><select id="vPlace">
        <option value="Поликлиника" ${(a.place || "Поликлиника") === "Поликлиника" ? "selected" : ""}>Поликлиника</option>
        <option value="На дому" ${a.place === "На дому" ? "selected" : ""}>Дома (на дому)</option>
      </select></div>
    </div>
    <div class="row" style="justify-content:flex-end;margin-bottom:10px">
      <button type="button" class="btn ghost sm" onclick="saveIntake(${a.id})">Сохранить данные обращения</button>
    </div>

    ${u.role === "doctor" && editable ? `
      <div style="border-top:1px solid var(--line);padding-top:12px">
        <div class="field"><label>Диагноз по поводу жалобы *</label><input id="vDiagnosis" value="${esc(a.diagnosis || "")}" placeholder="Например: J06.9 Острая инфекция верхних дыхательных путей" required></div>
        <div class="field"><label>Осмотр, рекомендации и назначения</label><textarea id="vNotes" rows="3" placeholder="Объективный статус, план лечения">${esc(a.notes || "")}</textarea></div>
        <div id="rxList"></div>
        <button type="button" class="btn ghost sm" onclick="addRx()">+ Выписать рецепт</button>
      </div>
    ` : `
      <div style="border-top:1px solid var(--line);padding-top:12px">
        <div class="field"><label>Диагноз врача</label><div><b>${esc(a.diagnosis || "Ещё не выставлен")}</b></div></div>
        ${a.notes ? `<div class="field"><label>Заметки / назначения</label><div>${esc(a.notes)}</div></div>` : ""}
      </div>
    `}

    <div class="visit-actions">
      <div class="row">
        <button type="button" class="btn ghost" onclick="referralForm(${p.id},${a.id})">+ Добавить направление</button>
        ${u.role === "doctor" ? `<button type="button" class="btn ghost sm" onclick="sickLeaveForm(${p.id})">+ Больничный</button>
          <button type="button" class="btn ghost sm" onclick="certificateForm(${p.id})">+ Справка</button>` : ""}
        ${editable ? `<button type="button" class="btn danger sm" onclick="cancelAppt(${a.id})">Отменить приём</button>` : ""}
      </div>
      ${u.role === "doctor" && editable ? `<button type="button" class="btn" onclick="completeActiveVisit(${a.id})">Закончить приём</button>` : ""}
    </div>
  </div>`;

  // Правая колонка: прикреплённые анализы, снимки и направления по этому приёму
  const labs = r.labs || [], imgs = r.imaging || [], refs = r.referrals || [];
  state.cache.labTitles = Object.fromEntries(labs.map(l => [l.id, l.test_type]));
  $("cabRight").innerHTML = `<div class="card">
    <div class="row between" style="margin-bottom:10px">
      <h3 style="margin:0">Прикреплённые анализы</h3>
      <div class="row">
        <button class="btn sm" onclick="labForm(${a.id})">+ Анализ</button>
        ${u.role === "doctor" ? `<button class="btn ghost sm" onclick="imagingForm(${p.id},${a.id})">+ Снимок</button>` : ""}
      </div>
    </div>
    ${labs.length ? labs.map(l => `<div class="att-item">
      <div class="row between"><b>${esc(l.test_type)}</b>${badge(l.status)}</div>
      <div class="small" style="margin-top:4px">${fmtLabResult(l)}</div>
      ${l.normal_range ? `<div class="muted small">Норма: ${esc(l.normal_range)}</div>` : ""}
      ${l.doctor_comment ? `<div class="muted small">${esc(l.doctor_comment)}</div>` : ""}
      ${l.status !== "ready" ? `<div style="margin-top:6px"><button class="btn ghost sm" onclick="labResultModal(${l.id},${a.id})">Внести результат</button></div>` : ""}
    </div>`).join("") : `<div class="empty">К этому приёму анализы ещё не прикреплены</div>`}

    <h3 style="margin:14px 0 8px">Снимки по приёму</h3>
    ${imgs.length ? imgs.map(i => `<div class="att-item">
      <div class="row between"><b>${esc(i.study_type)}: ${esc(i.body_part)}</b><span class="muted small">${fmtDate(i.study_date)}</span></div>
      <div class="small" style="margin-top:4px">${esc(i.conclusion)}</div>
    </div>`).join("") : `<div class="muted small">Снимков по этому приёму нет</div>`}

    <h3 style="margin:14px 0 8px">Выданные направления</h3>
    ${refs.length ? refs.map(rf => `<div class="att-item">
      <div class="row between"><b>${esc(rf.to_specialty)}</b>${badge(rf.status)}</div>
      <div class="small" style="margin-top:4px">${esc(rf.reason)}</div>
    </div>`).join("") : `<div class="muted small">Направлений по этому приёму нет</div>`}
  </div>`;
}

function intakePayload(id) {
  return {
    id,
    referrer_org: $("vRefOrg")?.value || "",
    referrer_doctor: $("vRefDoc")?.value || "",
    complaint: $("vComplaint")?.value || "",
    place: $("vPlace")?.value || "Поликлиника"
  };
}
async function saveIntake(id) {
  if (await act(() => api("/appointments/edit", intakePayload(id)))) selectAppt(id);
}

function addRx() {
  const n = state.cache.rx++;
  $("rxList").insertAdjacentHTML("beforeend", `<div class="grid2 rx" style="margin-bottom:8px">
    <input id="med${n}" placeholder="Препарат"><input id="dose${n}" placeholder="Дозировка и схема приёма"></div>`);
}

async function completeActiveVisit(id) {
  const diagnosis = $("vDiagnosis")?.value.trim();
  if (!diagnosis) return toast("Укажите диагноз по поводу жалобы", true);
  const rx = [];
  for (let i = 0; i < (state.cache.rx || 0); i++) {
    const m = $("med" + i)?.value.trim();
    if (m) rx.push({ medication: m, dosage: $("dose" + i)?.value.trim() || "", instructions: "" });
  }
  const payload = {
    ...intakePayload(id),
    appointment_id: id,
    diagnosis,
    notes: $("vNotes")?.value || "",
    prescriptions: rx
  };
  if (await act(() => api("/visit/complete", payload))) refresh();
}

function sickLeaveForm(pid) {
  modal("Оформить больничный лист (ЭЛН)", `<form onsubmit="saveSickLeave(event,${pid})">
    <div class="field"><label>Диагноз *</label><input name="diagnosis" required></div>
    <div class="grid2">
      <div class="field"><label>Количество дней *</label><input type="number" name="days_count" min="1" max="60" value="5" required></div>
      <div class="field"><label>Место работы</label><input name="employer" placeholder="ТОО / Организация"></div>
    </div>
    <button class="btn">Выписать больничный</button></form>`, true);
}
async function saveSickLeave(e, pid) {
  const d = formData(e); d.patient_id = pid;
  if (await act(() => api("/sick-leaves/create", d))) { closeModal(); if (state.tab !== "cabinet") openPatient(pid); }
}
async function closeSickLeave(id, pid) {
  if (!confirm("Закрыть больничный лист?")) return;
  if (await act(() => api("/sick-leaves/close", { id }))) { if (state.tab === "cabinet") openPatient(pid); else refresh(); }
}

function certificateForm(pid) {
  modal("Выдать медицинскую справку", `<form onsubmit="saveCertificate(event,${pid})">
    <div class="grid2">
      <div class="field"><label>Форма справки</label><select name="cert_type"><option value="075/у">Форма 075/у</option><option value="026/у">Форма 026/у (детская)</option><option value="Бассейн">Справка в бассейн</option><option value="Свободная">Свободная форма</option></select></div>
      <div class="field"><label>Действует до</label><input type="date" name="valid_until"></div>
    </div>
    <div class="field"><label>Куда представляется</label><input name="target_org" placeholder="По месту требования" required></div>
    <div class="field"><label>Диагноз</label><input name="diagnosis" value="Практически здоров" required></div>
    <div class="field"><label>Заключение</label><textarea name="conclusion" rows="2" required>Противопоказаний нет</textarea></div>
    <button class="btn">Оформить справку</button></form>`, true);
}
async function saveCertificate(e, pid) {
  const d = formData(e); d.patient_id = pid;
  if (await act(() => api("/certificates/create", d))) { closeModal(); if (state.tab !== "cabinet") openPatient(pid); }
}

function openSignaturePad(onComplete, allowSkip) {
  const cur = state.user?.signature_data || "";
  modal("Личная подпись врача (1:1)", `
    <p class="muted small" style="margin-bottom:10px">Нарисуйте вашу подпись внутри квадрата 1:1. Она автоматически добавится на печатные справки, больничные, рецепты и направления.</p>
    <div class="sig-pad-wrap"><canvas id="sigCanvas" width="320" height="320"></canvas></div>
    <div class="row between" style="margin-top:12px;gap:8px;flex-wrap:wrap">
      <div class="row" style="gap:6px">
        <span class="muted small">Толщина:</span>
        <button type="button" class="chip active" data-lw="2.6" onclick="setSigWidth(2.6,this)">Обычная</button>
        <button type="button" class="chip" data-lw="4.2" onclick="setSigWidth(4.2,this)">Жирнее</button>
      </div>
      <div class="row" style="gap:6px">
        <button type="button" class="btn ghost sm" onclick="clearSigCanvas()">Очистить</button>
        ${allowSkip ? `<button type="button" class="btn ghost sm" id="sigSkipBtn">Пропустить</button>` : ""}
        <button type="button" class="btn" id="sigSaveBtn">Сохранить подпись</button>
      </div>
    </div>`, true);

  const canvas = $("sigCanvas"), ctx = canvas.getContext("2d");
  let drawing = false, hasInk = false, lineWidth = 2.6, last = null;
  ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#1e3a8a";
  if (cur) {
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); hasInk = true; };
    img.src = cur;
  }
  const pt = e => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
  };
  canvas.onpointerdown = e => {
    e.preventDefault(); canvas.setPointerCapture(e.pointerId);
    drawing = true; last = pt(e);
    ctx.beginPath(); ctx.fillStyle = "#1e3a8a"; ctx.arc(last.x, last.y, lineWidth * 0.55, 0, Math.PI * 2); ctx.fill();
    hasInk = true;
  };
  canvas.onpointermove = e => {
    if (!drawing) return;
    const p = pt(e);
    ctx.lineWidth = lineWidth; ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p; hasInk = true;
  };
  canvas.onpointerup = canvas.onpointercancel = () => { drawing = false; last = null; };
  window.setSigWidth = (w, btn) => {
    lineWidth = w;
    document.querySelectorAll("[data-lw]").forEach(b => b.classList.toggle("active", b === btn));
  };
  window.clearSigCanvas = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); hasInk = false; };
  if ($("sigSkipBtn")) $("sigSkipBtn").onclick = () => { closeModal(); if (onComplete) onComplete(""); };
  $("sigSaveBtn").onclick = async () => {
    if (!hasInk) return toast("Нарисуйте подпись или нажмите «Очистить» / «Отмена»", true);
    const dataUrl = canvas.toDataURL("image/png");
    const r = await act(() => api("/doctor/signature", { signature_data: dataUrl }));
    if (!r) return;
    if (r.user) state.user = r.user;
    closeModal();
    if (state.tab === "profile") profileView();
    if (onComplete) onComplete(dataUrl);
  };
}

function makeDoctorSealSvg(name, spec, lic) {
  const parts = String(name || "Врач").trim().split(/\s+/);
  const shortName = parts.length > 1 ? `${parts[0]} ${parts.slice(1).map(x => x[0] + ".").join("")}` : parts[0];
  const uid = "dseal" + Math.random().toString(36).slice(2, 7);
  return `<svg viewBox="0 0 120 120" width="96" height="96" xmlns="http://www.w3.org/2000/svg" style="opacity:.86;transform:rotate(-5deg)">
    <defs><path id="${uid}" d="M 60,60 m -44,0 a 44,44 0 1,1 88,0 a 44,44 0 1,1 -88,0"/></defs>
    <circle cx="60" cy="60" r="56" fill="none" stroke="#1e40af" stroke-width="2.2"/>
    <circle cx="60" cy="60" r="52" fill="none" stroke="#1e40af" stroke-width="0.9"/>
    <circle cx="60" cy="60" r="35" fill="none" stroke="#1e40af" stroke-width="1"/>
    <text fill="#1e40af" font-size="8.2" font-weight="700" font-family="Arial,sans-serif" letter-spacing="0.6">
      <textPath href="#${uid}" startOffset="50%" text-anchor="middle">${esc("ВРАЧ · " + (spec || "СПЕЦИАЛИСТ").toUpperCase().slice(0, 26))}</textPath>
    </text>
    <text x="60" y="56" text-anchor="middle" fill="#1e40af" font-size="9.5" font-weight="700" font-family="Arial,sans-serif">${esc(shortName.slice(0, 18))}</text>
    <text x="60" y="69" text-anchor="middle" fill="#1e40af" font-size="7.2" font-family="Arial,sans-serif">${esc(lic ? "Лиц. " + lic.slice(0, 16) : "ЛИЧНАЯ ПЕЧАТЬ")}</text>
  </svg>`;
}

function makeQrSvg(text, px = 88, color = "#1d4ed8") {
  const bytes = new TextEncoder().encode(String(text || ""));
  const V = [
    [1, 21, 19, 7, []],
    [2, 25, 34, 10, [6, 18]],
    [3, 29, 55, 15, [6, 22]],
    [4, 33, 80, 20, [6, 26]],
    [5, 37, 108, 26, [6, 30]]
  ];
  const ver = V.find(v => bytes.length + 2 <= v[2]) || V[V.length - 1];
  const [vnum, n, dc, ec, align] = ver;
  const maxBytes = dc - 2;
  const payload = bytes.slice(0, maxBytes);
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(4, 4); push(payload.length, 8);
  for (const b of payload) push(b, 8);
  for (let i = 0; i < 4 && bits.length < dc * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; data.push(b);
  }
  for (let i = 0; data.length < dc; i++) data.push(i % 2 ? 0x11 : 0xec);

  const exp = new Uint8Array(512), log = new Uint8Array(256);
  for (let x = 1, i = 0; i < 255; i++) { exp[i] = x; log[x] = i; x = x & 128 ? (x << 1) ^ 0x11d : x << 1; }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
  const mul = (a, b) => (a && b) ? exp[log[a] + log[b]] : 0;
  let gen = [1];
  for (let i = 0; i < ec; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) { next[j] ^= gen[j]; next[j + 1] ^= mul(gen[j], exp[i]); }
    gen = next;
  }
  const msg = data.concat(new Array(ec).fill(0));
  for (let i = 0; i < dc; i++) {
    const k = msg[i];
    if (k) for (let j = 0; j < gen.length; j++) msg[i + j] ^= mul(gen[j], k);
  }
  const code = data.concat(msg.slice(dc));

  const m = Array.from({ length: n }, () => new Int8Array(n).fill(-1));
  const res = Array.from({ length: n }, () => new Uint8Array(n));
  const setF = (r, c, v) => { if (r >= 0 && r < n && c >= 0 && c < n) { m[r][c] = v ? 1 : 0; res[r][c] = 1; } };
  const finder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc0 = -1; dc0 <= 7; dc0++) {
      const inB = dr >= 0 && dr <= 6 && dc0 >= 0 && dc0 <= 6;
      const dark = inB && (dr === 0 || dr === 6 || dc0 === 0 || dc0 === 6 || (dr >= 2 && dr <= 4 && dc0 >= 2 && dc0 <= 4));
      setF(r0 + dr, c0 + dc0, dark);
    }
  };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
  for (const r0 of align) for (const c0 of align) {
    if ((r0 < 9 && c0 < 9) || (r0 < 9 && c0 > n - 10) || (r0 > n - 10 && c0 < 9)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc0 = -2; dc0 <= 2; dc0++) {
      setF(r0 + dr, c0 + dc0, Math.abs(dr) === 2 || Math.abs(dc0) === 2 || (!dr && !dc0));
    }
  }
  setF(n - 8, 8, 1);
  for (let i = 0; i < 9; i++) { if (i !== 6) { res[8][i] = 1; res[i][8] = 1; } }
  for (let i = 0; i < 8; i++) { res[8][n - 1 - i] = 1; if (i < 7) res[n - 1 - i][8] = 1; }

  let bitIdx = 0;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    const up = ((n - 1 - col) >> 1) % 2 === 0;
    for (let k = 0; k < n; k++) {
      const r = up ? n - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (res[r][c]) continue;
        const b = bitIdx < code.length * 8 ? (code[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1 : 0;
        m[r][c] = b ^ ((r + c) % 2 === 0 ? 1 : 0);
        bitIdx++;
      }
    }
  }
  const fmt = 0x77c4; // Level L, mask 0
  const f1 = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  const f2 = [[n - 1, 8], [n - 2, 8], [n - 3, 8], [n - 4, 8], [n - 5, 8], [n - 6, 8], [n - 7, 8], [8, n - 8], [8, n - 7], [8, n - 6], [8, n - 5], [8, n - 4], [8, n - 3], [8, n - 2], [8, n - 1]];
  for (let i = 0; i < 15; i++) {
    const v = (fmt >> (14 - i)) & 1;
    m[f1[i][0]][f1[i][1]] = v;
    m[f2[i][0]][f2[i][1]] = v;
  }
  let rects = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c] === 1) rects += `<rect x="${c + 2}" y="${r + 2}" width="1" height="1"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 4} ${n + 4}" width="${px}" height="${px}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="${color}">${rects}</g></svg>`;
}

function ensureSignatureThenPrint(renderOptsFn) {
  if (state.user?.role === "doctor" && !state.user.signature_data) {
    openSignaturePad(sig => renderOptsFn(sig), true);
    return;
  }
  renderOptsFn(state.user?.signature_data || "");
}

function printSickLeave(idx) {
  const pd = state.cache.printDocs || {}, s = (pd.sl || [])[idx], p = pd.profile || {};
  if (!s) return;
  ensureSignatureThenPrint(fallbackSig => printDoc({
    docTitle: "ЛИСТ О ВРЕМЕННОЙ НЕТРУДОСПОСОБНОСТИ (ЭЛН)",
    docSub: `Номер ЭЛН: ${s.eln_number || "—"} · Статус: ${s.status === "closed" ? "Закрыт" : "Действует"}`,
    docNumber: s.eln_number,
    issuedAt: s.created_at || s.start_date,
    doctorName: s.doctor_name,
    doctorSpec: s.doctor_specialty,
    doctorLicense: s.doctor_license,
    doctorSignature: s.doctor_signature || fallbackSig,
    rows: [
      ["Пациент", `${p.full_name || ""} (ИИН ${p.iin || ""})`],
      ["Дата рождения", fmtDate(p.birth_date)],
      ["Место работы", s.employer || "—"],
      ["Период освобождения от работы", `${fmtDate(s.start_date)} — ${fmtDate(s.end_date)} (${s.days_count} дн.)`],
      ["Диагноз", s.diagnosis || "—"],
      ["Лечащий врач", `${s.doctor_name || ""}${s.doctor_specialty ? " (" + s.doctor_specialty + ")" : ""}`]
    ]
  }));
}

function printCert(idx) {
  const pd = state.cache.printDocs || {}, c = (pd.cert || [])[idx], p = pd.profile || {};
  if (!c) return;
  ensureSignatureThenPrint(fallbackSig => printDoc({
    docTitle: c.title || "МЕДИЦИНСКАЯ СПРАВКА",
    docSub: `№ ${c.cert_number || "—"} · Действует до ${fmtDate(c.valid_until)}`,
    docNumber: c.cert_number,
    issuedAt: c.created_at,
    doctorName: c.doctor_name,
    doctorSpec: c.doctor_specialty,
    doctorLicense: c.doctor_license,
    doctorSignature: c.doctor_signature || fallbackSig,
    rows: [
      ["Пациент", `${p.full_name || ""} (ИИН ${p.iin || ""})`],
      ["Дата рождения", fmtDate(p.birth_date)],
      ["Дата выдачи", fmtDate(c.created_at)],
      ["Место предъявления", c.target_org || "По месту требования"],
      ["Диагноз", c.diagnosis || "—"],
      ["Медицинское заключение", c.conclusion || "—"],
      ["Врач", `${c.doctor_name || ""}${c.doctor_specialty ? " (" + c.doctor_specialty + ")" : ""}`]
    ]
  }));
}

function printRx(idx) {
  const pd = state.cache.printDocs || {}, rx = (pd.rx || [])[idx], p = pd.profile || {};
  if (!rx) return;
  ensureSignatureThenPrint(fallbackSig => printDoc({
    docTitle: "РЕЦЕПТ НА ЛЕКАРСТВЕННОЕ СРЕДСТВО",
    docSub: `№ ${rx.qr_code_str || "—"} · Действителен до ${fmtDate(rx.valid_until)}`,
    docNumber: rx.qr_code_str,
    issuedAt: rx.created_at,
    doctorName: rx.doctor_name,
    doctorSpec: rx.doctor_specialty,
    doctorLicense: rx.doctor_license,
    doctorSignature: rx.doctor_signature || fallbackSig,
    rows: [
      ["Пациент", `${p.full_name || ""} (ИИН ${p.iin || ""})`],
      ["Препарат (Rp:)", rx.medication || "—"],
      ["Дозировка и схема приёма", rx.dosage || "—"],
      ["Дополнительные указания", rx.instructions || "—"],
      ["Врач", `${rx.doctor_name || ""}${rx.doctor_specialty ? " (" + rx.doctor_specialty + ")" : ""}`]
    ]
  }));
}

function printReferral(idx) {
  const pd = state.cache.printDocs || {}, rf = (pd.ref || [])[idx], p = pd.profile || {};
  if (!rf) return;
  ensureSignatureThenPrint(fallbackSig => printDoc({
    docTitle: "НАПРАВЛЕНИЕ НА КОНСУЛЬТАЦИЮ / ИССЛЕДОВАНИЕ",
    docSub: `Направление № REF-${String(rf.id || 0).padStart(5, "0")} · Действует до ${fmtDate(rf.valid_until)}`,
    docNumber: `REF-${String(rf.id || 0).padStart(5, "0")}`,
    issuedAt: rf.created_at,
    doctorName: rf.doctor_from_name,
    doctorSpec: rf.doctor_from_specialty,
    doctorLicense: rf.doctor_license,
    doctorSignature: rf.doctor_signature || fallbackSig,
    noVerifyLookup: true,
    rows: [
      ["Пациент", `${p.full_name || ""} (ИИН ${p.iin || ""})`],
      ["Дата рождения", fmtDate(p.birth_date)],
      ["Направляется к специалисту / на", rf.to_specialty || "—"],
      ["Повод / клиническая причина", rf.reason || "—"],
      ["Направивший врач", `${rf.doctor_from_name || ""}${rf.doctor_from_specialty ? " (" + rf.doctor_from_specialty + ")" : ""}`]
    ]
  }));
}

function printDoc(opts) {
  const w = window.open("", "_blank", "width=840,height=920");
  if (!w) return toast("Разрешите всплывающие окна для печати", true);
  const doc = w.document;
  doc.open();
  doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title></title>
    <style>
      *{box-sizing:border-box}
      body{font-family:"Segoe UI",Arial,sans-serif;padding:28px 34px;color:#111827;background:#fff;line-height:1.45;font-size:13.5px}
      .sheet{max-width:760px;margin:0 auto;border:1px solid #d1d5db;padding:26px 28px}
      .top-head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;border-bottom:2px solid #1e3a8a;padding-bottom:14px;margin-bottom:16px}
      .corner-stamp img{max-width:250px;height:auto;display:block}
      .stamp-meta{font-size:11.5px;color:#1e3a8a;margin-top:6px}
      .doc-head{text-align:right;flex:1}
      .doc-head h1{font-size:16px;margin:0 0 4px;color:#111827;text-transform:uppercase;letter-spacing:.3px}
      .doc-head .sub{font-size:12px;color:#4b5563}
      .info-table{width:100%;border-collapse:collapse;margin:10px 0 20px}
      .info-table th,.info-table td{border:1px solid #e5e7eb;padding:8px 10px;text-align:left;vertical-align:top}
      .info-table th{width:34%;background:#f8fafc;color:#475569;font-weight:600;font-size:12.5px}
      .sign-row{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;margin:22px 0 24px;min-height:126px}
      .doc-sign-left{display:flex;align-items:center;gap:12px}
      .doc-sign-meta{font-size:12.5px;color:#1f2937}
      .sig-seal-box{position:relative;width:270px;height:122px;display:flex;align-items:flex-end;justify-content:center}
      .sig-line{width:100%;border-bottom:1px solid #334155;text-align:center;font-size:10.5px;color:#64748b;padding-top:4px;position:relative;z-index:1}
      .sig-img{position:absolute;left:18px;bottom:14px;width:118px;height:118px;object-fit:contain;z-index:2;pointer-events:none}
      .clinic-seal{position:absolute;right:6px;bottom:2px;width:124px;height:124px;object-fit:contain;opacity:.86;transform:rotate(-7deg);mix-blend-mode:multiply;z-index:3;pointer-events:none}
      .verify-card{border:2px solid #1d4ed8;border-radius:10px;overflow:hidden;margin-top:8px}
      .verify-head{background:#1e3a8a;color:#fff;padding:8px 14px;font-weight:700;font-size:12.5px;letter-spacing:.4px}
      .verify-body{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:12px 14px;background:#fff}
      .verify-fields{flex:1;display:grid;grid-template-columns:145px 1fr;gap:4px 10px;font-size:12px}
      .verify-fields .lbl{color:#1d4ed8;font-weight:700}
      .verify-right{display:flex;flex-direction:column;align-items:center;gap:6px}
      .demo-pill{border:1px solid #dc2626;background:#fef2f2;color:#b91c1c;font-size:10px;font-weight:700;padding:3px 8px;border-radius:4px;white-space:nowrap}
      .qr-lbl{font-size:10px;font-weight:700;color:#1d4ed8;letter-spacing:.3px}
      .verify-foot{border-top:1px solid #bfdbfe;padding:6px 14px;font-size:10.5px;color:#1d4ed8}
      @media print{body{padding:0}.sheet{border:0;padding:10px}}
    </style></head><body></body></html>`);
  doc.close();
  doc.title = String(opts.docTitle || "Медицинский документ");

  const el = (tag, cls, txt) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (txt !== undefined && txt !== null) n.textContent = String(txt);
    return n;
  };
  const sheet = el("div", "sheet");

  // Верхняя шапка с угловым штампом
  const top = el("div", "top-head");
  const corner = el("div", "corner-stamp");
  const stampImg = el("img");
  stampImg.src = location.origin + "/assets/stamp-clinic.png";
  stampImg.alt = "Угловой штамп клиники";
  corner.appendChild(stampImg);
  corner.appendChild(el("div", "stamp-meta", `Исх. № ${opts.docNumber || "—"} от ${fmtDate(opts.issuedAt || today())}`));
  top.appendChild(corner);

  const dHead = el("div", "doc-head");
  dHead.appendChild(el("h1", "", opts.docTitle || "Медицинский документ"));
  if (opts.docSub) dHead.appendChild(el("div", "sub", opts.docSub));
  top.appendChild(dHead);
  sheet.appendChild(top);

  // Таблица реквизитов документа (строго через textContent)
  const tbl = el("table", "info-table");
  const tb = el("tbody");
  for (const [k, v] of opts.rows || []) {
    const tr = el("tr");
    tr.appendChild(el("th", "", k));
    tr.appendChild(el("td", "", v));
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  sheet.appendChild(tbl);

  // Подпись (1:1), личная SVG-печать врача и круглая печать клиники
  const signRow = el("div", "sign-row");
  const left = el("div", "doc-sign-left");
  left.insertAdjacentHTML("beforeend", makeDoctorSealSvg(opts.doctorName, opts.doctorSpec, opts.doctorLicense));
  const dMeta = el("div", "doc-sign-meta");
  dMeta.appendChild(el("div", "", `Врач: ${opts.doctorName || "—"}`));
  if (opts.doctorSpec) dMeta.appendChild(el("div", "", `Специальность: ${opts.doctorSpec}`));
  if (opts.doctorLicense) dMeta.appendChild(el("div", "", `Лицензия: ${opts.doctorLicense}`));
  left.appendChild(dMeta);
  signRow.appendChild(left);

  const box = el("div", "sig-seal-box");
  if (opts.doctorSignature) {
    const sigImg = el("img", "sig-img");
    sigImg.src = opts.doctorSignature;
    sigImg.alt = "Подпись врача";
    box.appendChild(sigImg);
  }
  const sealImg = el("img", "clinic-seal");
  sealImg.src = location.origin + "/assets/seal-clinic.png";
  sealImg.alt = "Круглая печать клиники";
  box.appendChild(sealImg);
  box.appendChild(el("div", "sig-line", opts.doctorSignature ? "Подпись врача / М.П." : "Подпись врача (не задана в профиле) / М.П."));
  signRow.appendChild(box);
  sheet.appendChild(signRow);

  // Синий блок электронной верификации и QR-код
  const vCard = el("div", "verify-card");
  vCard.appendChild(el("div", "verify-head", "ЭЛЕКТРОННАЯ ПОДПИСЬ / ШТАМП ВЕРИФИКАЦИИ"));
  const vBody = el("div", "verify-body");
  const vFields = el("div", "verify-fields");
  const addField = (k, v) => { vFields.appendChild(el("div", "lbl", k)); vFields.appendChild(el("div", "", v)); };
  addField("Номер документа:", opts.docNumber || "—");
  addField("Сформирован:", String(opts.issuedAt || today()).slice(0, 16));
  addField("Подписант:", opts.doctorName || "—");
  addField("Реестр:", "Портал My Dyatel · Локальный реестр");
  vBody.appendChild(vFields);

  const vRight = el("div", "verify-right");
  vRight.appendChild(el("div", "demo-pill", "ЛОКАЛЬНАЯ КОПИЯ • БЕЗ ЭЦП НУЦ"));
  const verifyPath = opts.noVerifyLookup
    ? `${location.origin}/?doc=${encodeURIComponent(opts.docNumber || "")}`
    : `${location.origin}/api/v2/verify?number=${encodeURIComponent(opts.docNumber || "")}`;
  vRight.insertAdjacentHTML("beforeend", makeQrSvg(verifyPath, 88, "#1d4ed8"));
  vRight.appendChild(el("div", "qr-lbl", "ПРОВЕРКА ПО QR"));
  vBody.appendChild(vRight);
  vCard.appendChild(vBody);
  vCard.appendChild(el("div", "verify-foot",
    `Проверка в локальном реестре портала: /api/v2/verify?number=${opts.docNumber || ""}. Не заменяет государственную ЭЦП НУЦ РК.`));
  sheet.appendChild(vCard);

  doc.body.appendChild(sheet);

  const imgs = Array.from(doc.querySelectorAll("img"));
  let fired = false;
  const doPrint = () => { if (!fired) { fired = true; w.focus(); w.print(); } };
  Promise.all(imgs.map(img => img.complete ? Promise.resolve() : new Promise(res => { img.onload = res; img.onerror = res; })))
    .then(() => setTimeout(doPrint, 80));
  setTimeout(doPrint, 900);
}

// ---------- список пациентов и все записи (для админа) ----------
VIEWS.queue = async () => {
  const u = state.user, date = state.cache.qDate ?? today();
  state.cache.qDate = date;
  let doctorSel = "";
  if (u.role === "superadmin") {
    const d = await api("/doctors");
    doctorSel = `<select id="qDoc" onchange="state.cache.qDoctor=this.value;refresh()" style="width:auto"><option value="">Все врачи</option>${d.doctors.map(x =>
      `<option value="${x.id}" ${String(x.id) === state.cache.qDoctor ? "selected" : ""}>${esc(x.full_name)}</option>`).join("")}</select>`;
  }
  const q = `/queue?date=${state.cache.qAll ? "" : date}` + (state.cache.qDoctor ? `&doctor_id=${state.cache.qDoctor}` : "");
  const r = await api(q);
  const rows = r.appointments.map(a => {
    const actions = ["confirmed", "pending"].includes(a.status) ? `<button class="btn danger sm" onclick="cancelAppt(${a.id})">Отмена</button>` : "";
    return [...apptRows([a], u.role)[0], actions];
  });
  $("view").innerHTML = `<div class="card"><div class="row between"><div class="row">
      <input type="date" value="${date}" style="width:auto" onchange="state.cache.qDate=this.value;state.cache.qAll=false;refresh()">
      <button class="btn ghost sm" onclick="state.cache.qAll=!state.cache.qAll;refresh()">${state.cache.qAll ? "Показать только дату" : "Показать за всё время"}</button>${doctorSel}</div>
      <span class="muted">Всего: ${r.appointments.length}</span></div></div>
    <div class="card">${table(["Время", "Пациент", "Повод обращения", "Диагноз", "Статус", ""], rows, "Записей нет")}</div>`;
};

VIEWS.patients = async () => {
  $("view").innerHTML = `<div class="card row"><input id="pq" class="grow" placeholder="Поиск по ФИО или ИИН" oninput="searchPatients()" autofocus>
    <button class="btn" onclick="newPatientForm()">+ Новый пациент</button></div><div class="card" id="plist"></div>`;
  searchPatients();
};
let searchTimer;
function searchPatients() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const r = await act(() => api("/patients?q=" + encodeURIComponent($("pq")?.value || "")));
    if (!r || !$("plist")) return;
    $("plist").innerHTML = table(["ФИО", "ИИН", "Дата рождения", "Телефон", ""], r.patients.map(p => [
      `<b>${esc(p.full_name)}</b>`, esc(p.iin), `${fmtDate(p.birth_date)} (${calcAge(p.birth_date)})`, esc(p.phone || "—"),
      `<button class="btn ghost sm" onclick="openPatient(${p.id})">Открыть карту</button>`]), "Пациентов пока нет");
  }, 200);
}

// ==================== СУПЕРАДМИН ====================
async function overview() { state.cache.ov = (await api("/admin/overview")); return state.cache.ov; }
VIEWS.overview = async () => {
  const o = await overview(), c = o.counts;
  $("view").innerHTML = `<div class="stats">
    <div class="stat"><b>${c.doctors}</b>Врачей</div><div class="stat"><b>${c.nurses}</b>Медсестёр</div>
    <div class="stat"><b>${c.patients}</b>Пациентов</div><div class="stat"><b>${c.appointments}</b>Записей</div>
    <div class="stat"><b>${o.cabinets.length}</b>Кабинетов</div></div>
    <div class="card"><div class="row between"><h3 style="margin:0">Врачи и кабинеты</h3>
      <div class="row"><button class="btn ghost sm" onclick="go('cabinets')">+ Кабинет</button><button class="btn sm" onclick="go('doctors')">+ Врач</button></div></div>
      ${table(["Врач", "Специальность", "Кабинет"], o.doctors.map(d => [esc(d.full_name), esc(d.specialty), esc(d.cabinet_num)]), "База пуста — сначала добавьте кабинеты и врачей")}</div>`;
};
const cabinetSelect = (o, sel) => `<select name="cabinet_num" required>${o.cabinets.map(c => `<option ${c.number === sel ? "selected" : ""} value="${esc(c.number)}">${esc(c.number)}${c.name ? " — " + esc(c.name) : ""}</option>`).join("")}</select>`;

VIEWS.doctors = async () => {
  const o = await overview();
  $("view").innerHTML = `<div class="card"><div class="row between"><h3 style="margin:0">Врачи</h3><button class="btn" onclick="doctorForm()">+ Добавить врача</button></div>
    ${table(["ФИО", "ИИН", "Специальность", "Кабинет", "График", ""], o.doctors.map(d => [`<b>${esc(d.full_name)}</b>`, esc(d.iin), esc(d.specialty), esc(d.cabinet_num), esc(d.work_hours || "08:00 - 16:00"),
      `<button class="btn ghost sm" onclick="userEdit(${d.id})">Изменить</button> <button class="btn danger sm" onclick="userDelete(${d.id})">В архив</button>`]), "Врачей пока нет. Сначала создайте кабинет во вкладке «Кабинеты», затем добавьте врача.")}</div>`;
};
function doctorForm() {
  const o = state.cache.ov;
  if (!o.cabinets.length) return toast("Сначала добавьте хотя бы один кабинет во вкладке «Кабинеты»", true);
  modal("Новый врач", `<form onsubmit="saveDoctor(event)">
    <div class="field"><label>ФИО</label><input name="full_name" required></div>
    <div class="grid2"><div class="field"><label>ИИН (12 цифр)</label><input name="iin" maxlength="12" pattern="\\d{12}" required></div>
    <div class="field"><label>Временный пароль (необязательно)</label><input name="password" placeholder="Пусто — автогенерация"></div></div>
    <div class="grid2"><div class="field"><label>Специальность</label><input name="specialty" placeholder="Терапевт, Кардиолог, Хирург…" required></div>
    <div class="field"><label>Кабинет</label>${cabinetSelect(o)}</div></div>
    <div class="grid2"><div class="field"><label>График работы (ЧЧ:ММ - ЧЧ:ММ)</label><input name="work_hours" value="08:00 - 16:00" placeholder="08:00 - 16:00"></div>
    <div class="field"><label>Номер лицензии</label><input name="license_num"></div></div>
    <div class="field"><label>Телефон</label><input name="phone"></div>
    <button class="btn">Добавить</button></form>`, true);
}
async function saveDoctor(e) {
  const r = await act(() => api("/admin/doctor", formData(e)));
  if (r) { closeModal(); refresh(); showTempPasswordModal("Врач", r); }
}

VIEWS.nurses = async () => {
  const o = await overview();
  $("view").innerHTML = `<div class="card"><div class="row between"><h3 style="margin:0">Медсёстры</h3><button class="btn" onclick="nurseForm()">+ Добавить медсестру</button></div>
    ${table(["ФИО", "ИИН", "Привязана к врачу", ""], o.nurses.map(n => [`<b>${esc(n.full_name)}</b>`, esc(n.iin), esc(n.doctor_name),
      `<button class="btn ghost sm" onclick="userEdit(${n.id})">Изменить</button> <button class="btn danger sm" onclick="userDelete(${n.id})">В архив</button>`]), "Медсестёр пока нет")}</div>`;
};
const doctorSelect = (o, sel) => `<select name="doctor_id" required>${o.doctors.map(d => `<option value="${d.id}" ${d.id === sel ? "selected" : ""}>${esc(d.full_name)} — ${esc(d.specialty)}</option>`).join("")}</select>`;
function nurseForm() {
  const o = state.cache.ov;
  if (!o.doctors.length) return toast("Сначала добавьте врача, к которому будет привязана медсестра", true);
  modal("Новая медсестра", `<form onsubmit="saveNurse(event)">
    <div class="field"><label>ФИО</label><input name="full_name" required></div>
    <div class="grid2"><div class="field"><label>ИИН (12 цифр)</label><input name="iin" maxlength="12" pattern="\\d{12}" required></div>
    <div class="field"><label>Временный пароль (необязательно)</label><input name="password" placeholder="Пусто — автогенерация"></div></div>
    <div class="field"><label>Работает с врачом</label>${doctorSelect(o)}</div>
    <div class="field"><label>Телефон</label><input name="phone"></div>
    <button class="btn">Добавить</button></form>`, true);
}
async function saveNurse(e) {
  const r = await act(() => api("/admin/nurse", formData(e)));
  if (r) { closeModal(); refresh(); showTempPasswordModal("Медсестра", r); }
}

function userEdit(id) {
  const o = state.cache.ov, d = o.doctors.find(x => x.id === id), n = o.nurses.find(x => x.id === id), u = d || n;
  modal(`Изменить: ${esc(u.full_name)}`, `<form onsubmit="saveUser(event,${id})">
    ${d ? `<div class="field"><label>Кабинет</label>${cabinetSelect(o, d.cabinet_num)}</div>
      <div class="field"><label>Специальность</label><input name="specialty" value="${esc(d.specialty)}"></div>
      <div class="field"><label>График работы (ЧЧ:ММ - ЧЧ:ММ)</label><input name="work_hours" value="${esc(d.work_hours || "08:00 - 16:00")}"></div>` : ""}
    ${n ? `<div class="field"><label>Работает с врачом</label>${doctorSelect(o, n.doctor_id)}</div>` : ""}
    <div class="field"><label>Новый пароль (оставьте пустым, чтобы не менять)</label><input name="password" minlength="6"></div>
    <button class="btn">Сохранить</button></form>`, true);
}
async function saveUser(e, id) {
  const d = formData(e); d.id = id;
  if (await act(() => api("/admin/user/update", d))) { closeModal(); refresh(); }
}
async function userDelete(id) {
  if (!confirm("Перенести пользователя в архив? Вход будет закрыт, но история и документы сохранятся.")) return;
  if (await act(() => api("/admin/user/delete", { id }))) refresh();
}

VIEWS.audit = async () => {
  const [aRes, bRes] = await Promise.all([api("/admin/audit"), api("/admin/backups")]);
  $("view").innerHTML = `<div class="card"><div class="row between"><h3 style="margin:0">Резервное копирование БД</h3>
      <button class="btn" onclick="createBackup()">+ Создать резервную копию</button></div>
      <div class="muted small" style="margin-top:8px">${bRes.backups.length ? "Сохранённые копии: " + bRes.backups.slice(0, 5).map(esc).join(", ") : "Резервных копий пока нет"}</div></div>
    <div class="card"><h3>Журнал действий (аудит)</h3>
      ${table(["Время", "Пользователь", "Действие", "Детали"], aRes.logs.map(l => [
        esc(l.created_at), esc(l.user_name || "—"), `<b>${esc(l.action)}</b>`, esc(l.details || "—")
      ]), "Событий пока нет")}</div>`;
};
async function createBackup() { if (await act(() => api("/admin/backup", {}))) refresh(); }

VIEWS.cabinets = async () => {
  const o = await overview();
  $("view").innerHTML = `<div class="card"><h3>Новый кабинет</h3><form class="row" onsubmit="saveCabinet(event)">
    <input name="number" placeholder="Номер, например 215" style="width:180px" required><input name="name" placeholder="Название / отделение (необязательно)" class="grow">
    <button class="btn">Добавить</button></form></div>
    <div class="card"><h3>Кабинеты</h3>${table(["Номер", "Название", "Врачи", ""], o.cabinets.map(c => [`<b>${esc(c.number)}</b>`, esc(c.name || "—"), esc(c.doctors || "свободен"),
      `<button class="btn danger sm" onclick="cabinetDelete(${c.id})">Удалить</button>`]), "Кабинетов пока нет")}</div>`;
};
async function saveCabinet(e) { const f = e.target; if (await act(() => api("/admin/cabinet", formData(e)))) { f.reset(); refresh(); } }
async function cabinetDelete(id) { if (confirm("Удалить кабинет?") && await act(() => api("/admin/cabinet/delete", { id }))) refresh(); }

// ---------- старт ----------
(async function init() {
  if (state.token) {
    try { state.user = (await api("/me")).user; renderShell(); return; } catch (_) { state.token = null; localStorage.removeItem("token"); }
  }
  renderLogin();
})();
