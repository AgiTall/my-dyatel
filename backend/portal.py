"""
Ролевой API портала (v2): superadmin, врач, медсестра, пациент.
Подключается из server.py: маршруты /api/v2/*.
"""

import os
import re
import secrets
import sqlite3
import json
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from backend.database.db_manager import hash_password, verify_password, is_legacy_hash

ROLES = ("superadmin", "doctor", "nurse", "patient")
PLACES = ("Поликлиника", "На дому")
DEFAULT_SLOTS = [f"{h:02d}:{m:02d}" for h in range(9, 17) for m in (0, 30)]

# token -> user_id (в памяти; после перезапуска сервера нужно войти заново)
SESSIONS: Dict[str, int] = {}


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ==================== МИГРАЦИЯ СХЕМЫ ====================
def migrate(db) -> None:
    conn = sqlite3.connect(db.db_path)
    conn.row_factory = sqlite3.Row
    try:
        sql = conn.execute("SELECT sql FROM sqlite_master WHERE name='users'").fetchone()["sql"]
        if "nurse" not in sql:
            conn.commit()
            conn.execute("PRAGMA foreign_keys = OFF")
            conn.execute("""
            CREATE TABLE users_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                iin TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                full_name TEXT NOT NULL,
                email TEXT,
                phone TEXT,
                role TEXT NOT NULL CHECK(role IN ('patient', 'doctor', 'nurse', 'superadmin')),
                created_at TEXT NOT NULL
            )""")
            conn.execute("INSERT INTO users_new SELECT id, iin, password_hash, full_name, email, phone, role, created_at FROM users")
            conn.execute("DROP TABLE users")
            conn.execute("ALTER TABLE users_new RENAME TO users")
            conn.commit()
            conn.execute("PRAGMA foreign_keys = ON")

        conn.executescript("""
        CREATE TABLE IF NOT EXISTS nurse_profiles (
            user_id INTEGER PRIMARY KEY,
            doctor_id INTEGER NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (doctor_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS cabinets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            number TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS imaging_studies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            patient_id INTEGER NOT NULL,
            doctor_id INTEGER NOT NULL,
            study_type TEXT NOT NULL,
            body_part TEXT NOT NULL,
            conclusion TEXT NOT NULL,
            study_date TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (doctor_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            user_name TEXT NOT NULL DEFAULT '',
            action TEXT NOT NULL,
            target_type TEXT NOT NULL DEFAULT '',
            target_id INTEGER,
            details TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        );
        """)

        # Кабинеты из профилей врачей
        for r in conn.execute("SELECT DISTINCT cabinet_num FROM doctor_profiles").fetchall():
            conn.execute("INSERT OR IGNORE INTO cabinets (number, name) VALUES (?, '')", (r["cabinet_num"],))

        # Суперадмин
        if not conn.execute("SELECT 1 FROM users WHERE role='superadmin'").fetchone():
            init_pw = os.environ.get("PORTAL_ADMIN_PASSWORD") or "admin123"
            conn.execute(
                "INSERT INTO users (iin, password_hash, full_name, email, phone, role, created_at) "
                "VALUES ('999999999999', ?, 'Главный администратор', '', '', 'superadmin', ?)",
                (hash_password(init_pw), now()))

        # Новые колонки (для существующих баз)
        def add_col(table, col, ddl):
            cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
            if col not in cols:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
        add_col("appointments", "referrer_org", "TEXT DEFAULT ''")
        add_col("appointments", "referrer_doctor", "TEXT DEFAULT ''")
        add_col("appointments", "place", "TEXT DEFAULT 'Поликлиника'")
        add_col("patient_profiles", "district", "TEXT DEFAULT ''")
        add_col("patient_profiles", "clinic", "TEXT DEFAULT ''")
        add_col("patient_profiles", "osms_status", "TEXT DEFAULT 'Не указан'")
        add_col("patient_profiles", "osms_until", "TEXT DEFAULT ''")
        add_col("lab_orders", "appointment_id", "INTEGER")
        add_col("imaging_studies", "appointment_id", "INTEGER")
        add_col("referrals", "appointment_id", "INTEGER")
        add_col("users", "is_active", "INTEGER NOT NULL DEFAULT 1")
        add_col("users", "archived_at", "TEXT DEFAULT ''")
        add_col("users", "must_change_password", "INTEGER NOT NULL DEFAULT 0")
        add_col("patient_profiles", "created_by", "INTEGER")
        add_col("doctor_profiles", "signature_data", "TEXT DEFAULT ''")

        # Сброс принудительной смены пароля для всех пользователей
        conn.execute("UPDATE users SET must_change_password=0 WHERE must_change_password=1")

        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_slot_active "
            "ON appointments(doctor_id, app_date, time_slot) WHERE status != 'cancelled'"
        )
        conn.commit()
    finally:
        conn.close()


# ==================== ВСПОМОГАТЕЛЬНОЕ ====================
def _q(db, sql: str, args: tuple = ()):
    with db.get_connection() as conn:
        return [dict(r) for r in conn.execute(sql, args).fetchall()]


def _one(db, sql: str, args: tuple = ()):
    rows = _q(db, sql, args)
    return rows[0] if rows else None


def _exec(db, sql: str, args: tuple = ()) -> int:
    with db.get_connection() as conn:
        cur = conn.execute(sql, args)
        conn.commit()
        return cur.lastrowid


def load_user(db, user_id: int) -> Optional[Dict[str, Any]]:
    u = _one(db, "SELECT id, iin, full_name, phone, email, role, must_change_password FROM users WHERE id=? AND is_active=1", (user_id,))
    if not u:
        return None
    u["must_change_password"] = bool(u.get("must_change_password"))
    if u["role"] == "doctor":
        u.update(_one(db, "SELECT specialty, cabinet_num, work_hours, license_num, signature_data FROM doctor_profiles WHERE user_id=?", (u["id"],)) or {})
    elif u["role"] == "nurse":
        n = _one(db, "SELECT n.doctor_id, d.full_name AS doctor_name, p.specialty, p.cabinet_num "
                     "FROM nurse_profiles n JOIN users d ON d.id=n.doctor_id "
                     "JOIN doctor_profiles p ON p.user_id=d.id WHERE n.user_id=? AND d.is_active=1", (u["id"],))
        u.update(n or {"doctor_id": None})
    elif u["role"] == "patient":
        u.update(_one(db, "SELECT birth_date, blood_group, allergies, chronic_diseases, emergency_contact, "
                          "district, clinic, osms_status, osms_until FROM patient_profiles WHERE user_id=?", (u["id"],)) or {})
    return u


def audit(db, user: Optional[Dict[str, Any]], action: str, target_type: str = "", target_id: Optional[int] = None, details: str = "") -> None:
    _exec(db, "INSERT INTO audit_log (user_id, user_name, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          (user["id"] if user else None, user["full_name"] if user else "Система", action, target_type, target_id, details, now()))


def slots_for_doctor(db, doctor_id: int) -> List[str]:
    prof = _one(db, "SELECT work_hours FROM doctor_profiles WHERE user_id=?", (doctor_id,))
    wh = (prof or {}).get("work_hours") or ""
    m = re.match(r"^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$", wh)
    if not m:
        return list(DEFAULT_SLOTS)
    sh, sm, eh, em = map(int, m.groups())
    start_min, end_min = sh * 60 + sm, eh * 60 + em
    if end_min <= start_min or end_min > 24 * 60:
        return list(DEFAULT_SLOTS)
    res = []
    cur = start_min
    while cur + 30 <= end_min:
        res.append(f"{cur // 60:02d}:{cur % 60:02d}")
        cur += 30
    return res or list(DEFAULT_SLOTS)


def require(user: Dict[str, Any], *roles: str) -> None:
    if user["role"] not in roles:
        raise ApiError("Недостаточно прав для этого действия", 403)


def staff_doctor_id(user: Dict[str, Any]) -> Optional[int]:
    """ID врача, чьи записи видит сотрудник (врач — свои, медсестра — своего врача)."""
    if user["role"] == "doctor":
        return user["id"]
    if user["role"] == "nurse":
        return user.get("doctor_id")
    return None

def appt_for_staff(db, user, appt_id: int) -> Dict[str, Any]:
    a = _one(db, "SELECT * FROM appointments WHERE id=?", (appt_id,))
    if not a:
        raise ApiError("Запись не найдена", 404)
    if user["role"] != "superadmin" and a["doctor_id"] != staff_doctor_id(user):
        raise ApiError("Это запись другого врача", 403)
    return a


def can_view_patient(db, user: Dict[str, Any], patient_id: int) -> bool:
    if user["role"] == "superadmin":
        return True
    if user["role"] == "patient":
        return user["id"] == patient_id
    if user["role"] in ("doctor", "nurse"):
        did = staff_doctor_id(user)
        if not did:
            return False
        if _one(db, "SELECT 1 FROM appointments WHERE doctor_id=? AND patient_id=?", (did, patient_id)):
            return True
        if _one(db, "SELECT 1 FROM referrals WHERE (from_doctor_id=? OR target_doctor_id=?) AND patient_id=?", (did, did, patient_id)):
            return True
        if _one(db, "SELECT 1 FROM patient_profiles WHERE user_id=? AND created_by IN (?, ?)", (patient_id, did, user["id"])):
            return True
    return False


def patient_card(db, patient_id: int, for_role: str) -> Dict[str, Any]:
    prof = load_user(db, patient_id)
    if not prof or prof["role"] != "patient":
        raise ApiError("Пациент не найден", 404)
    c = {
        "profile": prof,
        "appointments": _q(db,
            "SELECT a.id, a.app_date, a.time_slot, a.status, a.complaint, a.diagnosis, a.notes, "
            "a.referrer_org, a.referrer_doctor, a.place, d.full_name AS doctor_name, dp.specialty, dp.cabinet_num "
            "FROM appointments a JOIN users d ON d.id=a.doctor_id JOIN doctor_profiles dp ON dp.user_id=d.id "
            "WHERE a.patient_id=? ORDER BY a.app_date DESC, a.time_slot DESC", (patient_id,)),
        "records": db.get_patient_medical_records(patient_id),
        "prescriptions": db.get_patient_prescriptions(patient_id),
        "referrals": db.get_patient_referrals(patient_id),
        "labs": db.get_patient_lab_orders(patient_id),
        "imaging": _q(db,
            "SELECT i.*, d.full_name AS doctor_name FROM imaging_studies i JOIN users d ON d.id=i.doctor_id "
            "WHERE i.patient_id=? ORDER BY i.study_date DESC", (patient_id,)),
        "sick_leaves": db.get_patient_sick_leaves(patient_id),
        "vaccinations": db.get_patient_vaccinations(patient_id),
        "certificates": db.get_patient_certificates(patient_id),
    }
    for rec in c["records"]:
        rec.pop("payload_json", None)
    c["orders"] = build_orders(c)
    return c


def build_orders(c: Dict[str, Any]):
    """Лента «Заказы» пациента: записи, направления, анализы, снимки, рецепты."""
    ev = []
    for a in c["appointments"]:
        txt = f"Вы были записаны к врачу: {a['doctor_name']} ({a['specialty']}), {a['app_date']} в {a['time_slot']}"
        if a["status"] == "cancelled":
            txt = f"Запись отменена: {a['doctor_name']}, {a['app_date']} {a['time_slot']}"
        elif a["status"] == "completed":
            txt = f"Приём завершён: {a['doctor_name']}, {a['app_date']}" + (f". Диагноз: {a['diagnosis']}" if a["diagnosis"] else "")
        ev.append((a["app_date"] + " " + a["time_slot"], "Запись", txt))
    for r in c["referrals"]:
        ev.append((r["created_at"], "Направление", f"Вы были записаны на направление: {r['to_specialty']} ({r['reason']})"))
    for l in c["labs"]:
        ev.append((l.get("completed_at") or l["created_at"], "Анализ",
                   f"{'Готов результат анализа' if l['status'] == 'ready' else 'Вы были записаны на анализ'}: {l['test_type']}"))
    for i in c["imaging"]:
        ev.append((i["study_date"], "Снимок", f"Проведено исследование ({i['study_type']}): {i['body_part']}"))
    for p in c["prescriptions"]:
        ev.append((p["created_at"], "Рецепт", f"Выписан рецепт: {p['medication']} {p['dosage']}".strip()))
    ev.sort(key=lambda e: e[0], reverse=True)
    return [{"date": e[0], "kind": e[1], "text": e[2]} for e in ev]


# ==================== ОБРАБОТЧИКИ ====================
def handle(db, method: str, path: str, query: Dict[str, list], body: Dict[str, Any],
           token: str) -> Tuple[int, Dict[str, Any]]:
    """Возвращает (http_status, json). path — без префикса /api/v2."""
    try:
        return 200, _route(db, method, path, query, body, token)
    except ApiError as e:
        return e.status, {"success": False, "error": e.message}
    except (ValueError, KeyError, TypeError) as e:
        return 400, {"success": False, "error": f"Некорректные данные: {e}"}


def _route(db, method, path, query, body, token):
    # --- без авторизации ---
    if method == "GET" and path == "/verify":
        num = (query.get("number") or [""])[0].strip()
        if not num:
            raise ApiError("Укажите номер документа")
        cert = _one(db, "SELECT cert_number, cert_type, title, valid_until, created_at FROM medical_certificates WHERE cert_number=?", (num,))
        if cert:
            return {"success": True, "valid": True, "kind": "Справка", "number": cert["cert_number"],
                    "title": cert["title"], "issued_at": cert["created_at"][:10], "valid_until": cert["valid_until"]}
        sl = _one(db, "SELECT eln_number, start_date, end_date, status, created_at FROM sick_leaves WHERE eln_number=?", (num,))
        if sl:
            return {"success": True, "valid": True, "kind": "Больничный лист (ЭЛН)", "number": sl["eln_number"],
                    "title": f"Статус: {sl['status']}", "issued_at": sl["start_date"], "valid_until": sl["end_date"]}
        rx = _one(db, "SELECT qr_code_str, medication, status, valid_until, created_at FROM prescriptions WHERE qr_code_str=?", (num,))
        if rx:
            return {"success": True, "valid": True, "kind": "Рецепт", "number": rx["qr_code_str"],
                    "title": f"Рецепт ({rx['status']})", "issued_at": rx["created_at"][:10], "valid_until": rx["valid_until"]}
        return {"success": True, "valid": False, "error": "Документ с таким номером не найден в локальном реестре"}

    if method == "POST" and path == "/login":
        iin = str(body.get("iin", "")).strip()
        pw = str(body.get("password", ""))
        row = _one(db, "SELECT id, password_hash, is_active FROM users WHERE iin=?", (iin,))
        if not row or not row["is_active"] or not verify_password(pw, row["password_hash"]):
            raise ApiError("Неверный ИИН или пароль", 401)
        if is_legacy_hash(row["password_hash"]):
            _exec(db, "UPDATE users SET password_hash=? WHERE id=?", (hash_password(pw), row["id"]))
        tok = secrets.token_hex(24)
        SESSIONS[tok] = row["id"]
        u = load_user(db, row["id"])
        audit(db, u, "login", "user", row["id"], f"Вход ({u['role']})")
        return {"success": True, "token": tok, "user": u}

    if method == "POST" and path == "/register":
        ok, msg, uid = db.register_patient({
            "iin": str(body.get("iin", "")), "full_name": str(body.get("full_name", "")),
            "password": str(body.get("password", "")),
            "phone": str(body.get("phone", "")), "birth_date": str(body.get("birth_date", "2000-01-01")) or "2000-01-01"})
        if not ok:
            raise ApiError(msg)
        tok = secrets.token_hex(24)
        SESSIONS[tok] = uid
        return {"success": True, "token": tok, "user": load_user(db, uid)}

    # --- авторизованные ---
    uid = SESSIONS.get(token)
    user = load_user(db, uid) if uid else None
    if not user:
        raise ApiError("Требуется вход", 401)
    role = user["role"]

    if method == "POST" and path == "/logout":
        SESSIONS.pop(token, None)
        return {"success": True}

    if method == "GET" and path == "/me":
        return {"success": True, "user": user}

    if method == "POST" and path == "/password":
        old, new = str(body.get("old", "")), str(body.get("new", ""))
        if len(new) < 6:
            raise ApiError("Новый пароль — минимум 6 символов")
        if new == old:
            raise ApiError("Новый пароль должен отличаться от текущего")
        row = _one(db, "SELECT password_hash FROM users WHERE id=?", (user["id"],))
        if not row or not verify_password(old, row["password_hash"]):
            raise ApiError("Старый пароль неверен")
        _exec(db, "UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?", (hash_password(new), user["id"]))
        audit(db, user, "password_change", "user", user["id"], "Смена пароля")
        return {"success": True, "message": "Пароль изменён", "user": load_user(db, user["id"])}

    if method == "GET" and path == "/doctors":
        return {"success": True, "doctors": _q(db,
            "SELECT u.id, u.full_name, d.specialty, d.cabinet_num, d.work_hours "
            "FROM users u JOIN doctor_profiles d ON d.user_id=u.id WHERE u.role='doctor' AND u.is_active=1 ORDER BY d.specialty, u.full_name")}

    if method == "GET" and path == "/slots":
        did, date = int(query["doctor_id"][0]), query["date"][0]
        busy = {r["time_slot"] for r in _q(db,
            "SELECT time_slot FROM appointments WHERE doctor_id=? AND app_date=? AND status!='cancelled'", (did, date))}
        return {"success": True, "slots": [{"time": s, "free": s not in busy} for s in slots_for_doctor(db, did)]}

    # --- пациент ---
    if method == "GET" and path == "/my/card":
        require(user, "patient")
        return {"success": True, "card": patient_card(db, user["id"], role)}

    if method == "POST" and path == "/appointments/book":
        if role == "patient":
            pid = user["id"]
        elif role in ("doctor", "nurse", "superadmin"):
            pid = int(body["patient_id"])
        else:
            raise ApiError("Недостаточно прав", 403)
        if role == "nurse":
            doctor_id = user.get("doctor_id")
        elif role == "doctor":
            doctor_id = user["id"]
        else:
            doctor_id = int(body["doctor_id"])
        if not doctor_id:
            raise ApiError("Медсестра не привязана к врачу")
        date, time_ = str(body["date"]), str(body["time"])
        if time_ not in slots_for_doctor(db, doctor_id):
            raise ApiError("Выбранное время не входит в график работы врача")
        staff = role != "patient"
        place = str(body.get("place", "")) if str(body.get("place", "")) in PLACES else PLACES[0]
        try:
            aid = _exec(db, "INSERT INTO appointments (patient_id, doctor_id, app_date, time_slot, status, complaint, diagnosis, notes, created_at, referrer_org, referrer_doctor, place) "
                      "VALUES (?, ?, ?, ?, 'confirmed', ?, '', '', ?, ?, ?, ?)",
                  (pid, doctor_id, date, time_, str(body.get("complaint", "")).strip() or "Консультация", now(),
                   (str(body.get("referrer_org", "")).strip() or "Поликлиника") if staff else "Самообращение",
                   str(body.get("referrer_doctor", "")).strip() if staff else "", place))
        except sqlite3.IntegrityError:
            raise ApiError("Это время уже занято, выберите другое")
        audit(db, user, "appointment_book", "appointment", aid, f"Запись на {date} {time_}")
        return {"success": True, "message": "Запись создана"}

    if method == "POST" and path == "/appointments/cancel":
        a = _one(db, "SELECT * FROM appointments WHERE id=?", (int(body["id"]),))
        if not a:
            raise ApiError("Запись не найдена", 404)
        allowed = (role == "superadmin" or (role == "patient" and a["patient_id"] == user["id"])
                   or (role in ("doctor", "nurse") and a["doctor_id"] == staff_doctor_id(user)))
        if not allowed:
            raise ApiError("Недостаточно прав", 403)
        if a["status"] in ("completed", "cancelled"):
            raise ApiError("Эту запись нельзя отменить")
        _exec(db, "UPDATE appointments SET status='cancelled' WHERE id=?", (a["id"],))
        return {"success": True, "message": "Запись отменена"}

    # --- общее для персонала ---
    if method == "GET" and path == "/queue":
        require(user, "doctor", "nurse", "superadmin")
        date = (query.get("date") or [""])[0]
        did = staff_doctor_id(user) if role != "superadmin" else (int(query["doctor_id"][0]) if query.get("doctor_id") else None)
        sql = ("SELECT a.id, a.patient_id, a.app_date, a.time_slot, a.status, a.complaint, a.diagnosis, "
               "p.full_name AS patient_name, p.iin AS patient_iin, p.phone AS patient_phone, "
               "d.full_name AS doctor_name, dp.specialty "
               "FROM appointments a JOIN users p ON p.id=a.patient_id JOIN users d ON d.id=a.doctor_id "
               "JOIN doctor_profiles dp ON dp.user_id=d.id WHERE 1=1")
        args = []
        if did:
            sql += " AND a.doctor_id=?"; args.append(did)
        elif role == "nurse":
            return {"success": True, "appointments": []}
        if date:
            sql += " AND a.app_date=?"; args.append(date)
        sql += " ORDER BY a.app_date DESC, a.time_slot ASC LIMIT 300" if not date else " ORDER BY a.time_slot ASC LIMIT 300"
        return {"success": True, "appointments": _q(db, sql, tuple(args))}

    if method == "GET" and path == "/patients":
        require(user, "doctor", "nurse", "superadmin")
        q = (query.get("q") or [""])[0].strip()
        like = f"%{q}%"
        sql = ("SELECT u.id, u.iin, u.full_name, u.phone, p.birth_date "
               "FROM users u JOIN patient_profiles p ON p.user_id=u.id "
               "WHERE u.role='patient' AND u.is_active=1 AND (u.full_name LIKE ? OR u.iin LIKE ?)")
        args: list = [like, like]
        if role in ("doctor", "nurse"):
            did = staff_doctor_id(user) or -1
            sql += (" AND (u.id IN (SELECT patient_id FROM appointments WHERE doctor_id=?) "
                    "OR u.id IN (SELECT patient_id FROM referrals WHERE from_doctor_id=? OR target_doctor_id=?) "
                    "OR p.created_by IN (?, ?))")
            args.extend([did, did, did, did, user["id"]])
        sql += " ORDER BY u.full_name LIMIT 100"
        return {"success": True, "patients": _q(db, sql, tuple(args))}

    if method == "GET" and path == "/patient/card":
        pid = int(query["id"][0])
        if not can_view_patient(db, user, pid):
            raise ApiError("Нет доступа к карте этого пациента", 403)
        if role != "patient":
            audit(db, user, "patient_card_view", "patient", pid, "Просмотр медкарты")
        return {"success": True, "card": patient_card(db, pid, role)}

    if method == "POST" and path == "/appointments/start":
        require(user, "doctor")
        a = _one(db, "SELECT doctor_id, status FROM appointments WHERE id=?", (int(body["id"]),))
        if not a or a["doctor_id"] != user["id"]:
            raise ApiError("Запись не найдена", 404)
        if a["status"] in ("confirmed", "pending"):
            _exec(db, "UPDATE appointments SET status='in_progress' WHERE id=?", (int(body["id"]),))
            audit(db, user, "appointment_start", "appointment", int(body["id"]), "Приём начат")
        return {"success": True}

    if method == "POST" and path == "/referrals/create":
        require(user, "doctor", "nurse")
        pid = int(body["patient_id"])
        if not can_view_patient(db, user, pid):
            raise ApiError("Нет доступа к пациенту", 403)
        spec = str(body.get("to_specialty", "")).strip()
        reason = str(body.get("reason", "")).strip()
        if not spec or not reason:
            raise ApiError("Укажите, куда направляете и причину")
        from_id = staff_doctor_id(user)
        if not from_id:
            raise ApiError("Медсестра не привязана к врачу")
        tid = body.get("target_doctor_id")
        _exec(db, "INSERT INTO referrals (patient_id, from_doctor_id, to_specialty, target_doctor_id, reason, status, valid_until, created_at, appointment_id) "
                  "VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)",
              (pid, from_id, spec, int(tid) if tid else None,
               reason + (f" (выдала мед. сестра {user['full_name']})" if role == "nurse" else ""),
               (datetime.now() + timedelta(days=30)).strftime("%Y-%m-%d"), now(),
               int(body["appointment_id"]) if body.get("appointment_id") else None))
        return {"success": True, "message": "Направление выдано"}

    # --- только врач ---
    if method == "POST" and path == "/visit/complete":
        require(user, "doctor")
        a = _one(db, "SELECT * FROM appointments WHERE id=?", (int(body["appointment_id"]),))
        if not a or a["doctor_id"] != user["id"]:
            raise ApiError("Запись не найдена", 404)
        if a["status"] in ("completed", "cancelled"):
            raise ApiError("Этот приём уже завершён или отменён", 400)
        diagnosis = str(body.get("diagnosis", "")).strip()
        if not diagnosis:
            raise ApiError("Укажите диагноз")
        notes = str(body.get("notes", "")).strip()
        complaint = str(body.get("complaint", a["complaint"] or "")).strip()
        ref_org = str(body.get("referrer_org", a["referrer_org"] or "")).strip()
        ref_doc = str(body.get("referrer_doctor", a["referrer_doctor"] or "")).strip()
        place = str(body.get("place", a["place"] or "Поликлиника")).strip()
        if place not in PLACES:
            place = PLACES[0]
        ts = now()
        valid_until = (datetime.now() + timedelta(days=30)).strftime("%Y-%m-%d")
        payload = json.dumps({"complaint": complaint, "notes": notes, "place": place, "referrer_org": ref_org, "referrer_doctor": ref_doc}, ensure_ascii=False)
        with db.get_connection() as conn:
            conn.execute(
                "UPDATE appointments SET status='completed', diagnosis=?, notes=?, complaint=?, referrer_org=?, referrer_doctor=?, place=? WHERE id=?",
                (diagnosis, notes, complaint, ref_org, ref_doc, place, a["id"]),
            )
            conn.execute(
                "INSERT INTO medical_records (patient_id, doctor_id, record_type, title, diagnosis, payload_json, created_at) VALUES (?, ?, 'visit', ?, ?, ?, ?)",
                (a["patient_id"], user["id"], f"Приём: {user.get('specialty', 'врач')}", diagnosis, payload, ts),
            )
            for m in body.get("prescriptions", []) or []:
                med = str(m.get("medication", "")).strip()
                if med:
                    qr = f"DYATEL-RX-{a['patient_id']:04d}-{user['id']:03d}-{secrets.token_hex(3).upper()}"
                    conn.execute(
                        "INSERT INTO prescriptions (patient_id, doctor_id, medication, dosage, instructions, qr_code_str, status, valid_until, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)",
                        (a["patient_id"], user["id"], med, str(m.get("dosage", "")), str(m.get("instructions", "")), qr, valid_until, ts),
                    )
            conn.commit()
        audit(db, user, "visit_complete", "appointment", a["id"], f"Диагноз: {diagnosis}")
        return {"success": True, "message": "Приём завершён, диагноз сохранён"}

    if method == "POST" and path == "/sick-leaves/create":
        require(user, "doctor")
        pid = int(body["patient_id"])
        if not can_view_patient(db, user, pid):
            raise ApiError("Нет доступа к пациенту", 403)
        days = int(body.get("days_count", 5))
        diag = str(body.get("diagnosis", "")).strip()
        empl = str(body.get("employer", "")).strip() or "По месту требования"
        if not diag or days < 1 or days > 60:
            raise ApiError("Укажите диагноз и срок от 1 до 60 дней")
        res = db.create_sick_leave(pid, user["id"], days, diag, empl)
        audit(db, user, "sick_leave_create", "patient", pid, f"ЭЛН {res['eln_number']} ({days} дн.)")
        return {"success": True, "sick_leave": res, "message": f"Больничный {res['eln_number']} выписан"}

    if method == "POST" and path == "/sick-leaves/close":
        require(user, "doctor")
        sl = _one(db, "SELECT id, doctor_id, eln_number FROM sick_leaves WHERE id=?", (int(body["id"]),))
        if not sl or sl["doctor_id"] != user["id"]:
            raise ApiError("Больничный не найден", 404)
        db.close_sick_leave(sl["id"])
        audit(db, user, "sick_leave_close", "sick_leave", sl["id"], f"Закрыт ЭЛН {sl['eln_number']}")
        return {"success": True, "message": "Больничный закрыт"}

    if method == "POST" and path == "/certificates/create":
        require(user, "doctor")
        pid = int(body["patient_id"])
        if not can_view_patient(db, user, pid):
            raise ApiError("Нет доступа к пациенту", 403)
        cert_type = str(body.get("cert_type", "075/у")).strip()
        target_org = str(body.get("target_org", "")).strip() or "По месту требования"
        diag = str(body.get("diagnosis", "")).strip() or "Практически здоров"
        concl = str(body.get("conclusion", "")).strip() or "Противопоказаний нет"
        valid_until = str(body.get("valid_until", "")).strip() or (datetime.now() + timedelta(days=180)).strftime("%Y-%m-%d")
        res = db.create_medical_certificate(pid, user["id"], cert_type, target_org, diag, concl, valid_until)
        audit(db, user, "certificate_create", "patient", pid, f"Справка {res['cert_number']} ({cert_type})")
        return {"success": True, "certificate": res, "message": f"Справка {res['cert_number']} оформлена"}

    if method == "POST" and path == "/imaging/create":
        require(user, "doctor")
        pid = int(body["patient_id"])
        if not can_view_patient(db, user, pid):
            raise ApiError("Нет доступа к карте этого пациента", 403)
        aid = int(body["appointment_id"]) if body.get("appointment_id") else None
        if aid:
            appt = appt_for_staff(db, user, aid)
            if appt["patient_id"] != pid:
                raise ApiError("Приём относится к другому пациенту", 400)
        for f in ("study_type", "body_part", "conclusion"):
            if not str(body.get(f, "")).strip():
                raise ApiError("Заполните все поля исследования")
        _exec(db, "INSERT INTO imaging_studies (patient_id, doctor_id, study_type, body_part, conclusion, study_date, created_at, appointment_id) "
                  "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              (pid, user["id"], body["study_type"].strip(), body["body_part"].strip(),
               body["conclusion"].strip(), body.get("study_date") or now()[:10], now(), aid))
        audit(db, user, "imaging_create", "patient", pid, f"{body['study_type'].strip()} ({body['body_part'].strip()})")
        return {"success": True, "message": "Исследование добавлено"}

    if method == "POST" and path == "/doctor/signature":
        require(user, "doctor")
        sig = str(body.get("signature_data", "")).strip()
        if sig and (not sig.startswith("data:image/png;base64,") or len(sig) > 350000):
            raise ApiError("Некорректный формат подписи")
        _exec(db, "UPDATE doctor_profiles SET signature_data=? WHERE user_id=?", (sig, user["id"]))
        audit(db, user, "signature_update", "user", user["id"], "Обновлена личная подпись врача")
        return {"success": True, "message": "Подпись сохранена", "user": load_user(db, user["id"])}

    # --- рабочее место приёма (врач / медсестра) ---
    if method == "GET" and path == "/appointment":
        require(user, "doctor", "nurse", "superadmin")
        a = appt_for_staff(db, user, int(query["id"][0]))
        aid = a["id"]
        return {"success": True, "appointment": a, "patient": load_user(db, a["patient_id"]),
                "labs": _q(db, "SELECT * FROM lab_orders WHERE appointment_id=? ORDER BY id", (aid,)),
                "imaging": _q(db, "SELECT * FROM imaging_studies WHERE appointment_id=? ORDER BY id", (aid,)),
                "referrals": _q(db, "SELECT * FROM referrals WHERE appointment_id=? ORDER BY id", (aid,))}

    if method == "POST" and path == "/appointments/edit":
        require(user, "doctor", "nurse", "superadmin")
        a = appt_for_staff(db, user, int(body["id"]))
        place = str(body.get("place", a["place"]))
        if place not in PLACES:
            place = PLACES[0]
        _exec(db, "UPDATE appointments SET complaint=?, referrer_org=?, referrer_doctor=?, place=? WHERE id=?",
              (str(body.get("complaint", "")).strip(), str(body.get("referrer_org", "")).strip(),
               str(body.get("referrer_doctor", "")).strip(), place, a["id"]))
        return {"success": True, "message": "Данные приёма сохранены"}

    if method == "POST" and path == "/labs/add":
        require(user, "doctor", "nurse")
        a = appt_for_staff(db, user, int(body["appointment_id"]))
        test = str(body.get("test_type", "")).strip()
        if not test:
            raise ApiError("Укажите название анализа")
        result = str(body.get("result", "")).strip()
        _exec(db, "INSERT INTO lab_orders (patient_id, doctor_id, test_type, status, result_json, normal_range, doctor_comment, completed_at, created_at, appointment_id) "
                  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              (a["patient_id"], a["doctor_id"], test, "ready" if result else "ordered",
               json.dumps({"Результат": result}, ensure_ascii=False) if result else None,
               str(body.get("normal_range", "")).strip(), str(body.get("comment", "")).strip(),
               now() if result else None, now(), a["id"]))
        return {"success": True, "message": "Анализ прикреплён к приёму"}

    if method == "POST" and path == "/labs/result":
        require(user, "doctor", "nurse")
        lab = _one(db, "SELECT * FROM lab_orders WHERE id=?", (int(body["id"]),))
        if not lab or not lab["appointment_id"]:
            raise ApiError("Анализ не найден", 404)
        appt_for_staff(db, user, lab["appointment_id"])
        result = str(body.get("result", "")).strip()
        if not result:
            raise ApiError("Введите результат")
        _exec(db, "UPDATE lab_orders SET result_json=?, status='ready', completed_at=? WHERE id=?",
              (json.dumps({"Результат": result}, ensure_ascii=False), now(), lab["id"]))
        return {"success": True, "message": "Результат сохранён"}

    if method == "POST" and path == "/patients/create":
        require(user, "doctor", "nurse", "superadmin")
        raw_pw = str(body.get("password", "")).strip()
        temp_pw = raw_pw or secrets.token_urlsafe(6)
        ok, msg, pid = db.register_patient({
            "iin": str(body.get("iin", "")), "full_name": str(body.get("full_name", "")),
            "password": temp_pw, "phone": str(body.get("phone", "")),
            "birth_date": str(body.get("birth_date", "")) or "2000-01-01"})
        if not ok:
            raise ApiError(msg)
        creator = staff_doctor_id(user) or user["id"]
        _exec(db, "UPDATE patient_profiles SET district=?, clinic=?, created_by=? WHERE user_id=?",
              (str(body.get("district", "")).strip(), str(body.get("clinic", "")).strip(), creator, pid))
        audit(db, user, "patient_create", "patient", pid, f"Создана карта пациента {body.get('full_name', '')}")
        return {"success": True, "message": f"Пациент добавлен. Временный пароль: {temp_pw}", "id": pid, "temp_password": temp_pw}

    if method == "POST" and path == "/patient/update":
        require(user, "doctor", "nurse", "superadmin")
        pid = int(body["id"])
        if not can_view_patient(db, user, pid):
            raise ApiError("Нет доступа к пациенту", 403)
        _exec(db, "UPDATE patient_profiles SET district=?, clinic=?, osms_status=?, osms_until=? WHERE user_id=?",
              (str(body.get("district", "")).strip(), str(body.get("clinic", "")).strip(),
               str(body.get("osms_status", "Не указан")).strip() or "Не указан", str(body.get("osms_until", "")).strip(), pid))
        return {"success": True, "message": "Данные пациента сохранены"}

    # --- суперадмин ---
    if path.startswith("/admin/"):
        require(user, "superadmin")
        return _admin(db, method, path[len("/admin"):], query, body, user)

    raise ApiError("Маршрут не найден", 404)


def _admin(db, method, path, query, body, user):
    if method == "GET" and path == "/overview":
        cnt = lambda r: _one(db, "SELECT COUNT(*) AS c FROM users WHERE role=? AND is_active=1", (r,))["c"]
        return {
            "success": True,
            "counts": {"doctors": cnt("doctor"), "nurses": cnt("nurse"), "patients": cnt("patient"),
                       "appointments": _one(db, "SELECT COUNT(*) AS c FROM appointments")["c"]},
            "doctors": _q(db, "SELECT u.id, u.iin, u.full_name, u.phone, d.specialty, d.cabinet_num, d.license_num, d.work_hours "
                              "FROM users u JOIN doctor_profiles d ON d.user_id=u.id WHERE u.role='doctor' AND u.is_active=1 ORDER BY u.full_name"),
            "nurses": _q(db, "SELECT u.id, u.iin, u.full_name, u.phone, n.doctor_id, d.full_name AS doctor_name "
                             "FROM users u JOIN nurse_profiles n ON n.user_id=u.id JOIN users d ON d.id=n.doctor_id WHERE u.is_active=1 ORDER BY u.full_name"),
            "cabinets": _q(db, "SELECT c.id, c.number, c.name, "
                               "(SELECT group_concat(u.full_name, ', ') FROM doctor_profiles d JOIN users u ON u.id=d.user_id "
                               " WHERE d.cabinet_num=c.number AND u.is_active=1) AS doctors FROM cabinets c ORDER BY c.number"),
        }

    if method == "GET" and path == "/audit":
        return {"success": True, "logs": _q(db, "SELECT * FROM audit_log ORDER BY id DESC LIMIT 200")}

    if method == "GET" and path == "/backups":
        bdir = os.path.join(os.path.dirname(db.db_path), "backups")
        files = sorted([f for f in os.listdir(bdir) if f.endswith(".db")], reverse=True) if os.path.isdir(bdir) else []
        return {"success": True, "backups": files}

    if method == "POST" and path == "/backup":
        bdir = os.path.join(os.path.dirname(db.db_path), "backups")
        os.makedirs(bdir, exist_ok=True)
        fname = f"portal_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.db"
        dest = os.path.join(bdir, fname)
        src = sqlite3.connect(db.db_path)
        dst = sqlite3.connect(dest)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        audit(db, user, "db_backup", "system", None, f"Создана резервная копия {fname}")
        return {"success": True, "file": fname, "message": f"Резервная копия создана: {fname}"}

    if method == "POST" and path == "/doctor":
        number = str(body.get("cabinet_num", "")).strip()
        if not number:
            raise ApiError("Выберите кабинет")
        raw_pw = str(body.get("password", "")).strip()
        temp_pw = raw_pw or secrets.token_urlsafe(6)
        ok, msg, uid = db.register_doctor({
            "iin": str(body.get("iin", "")), "full_name": str(body.get("full_name", "")),
            "password": temp_pw, "phone": str(body.get("phone", "")),
            "license_num": str(body.get("license_num", "")) or "KZ-MED-" + str(body.get("iin", ""))[-5:],
            "specialty": str(body.get("specialty", "")) or "Терапевт (ВОП)", "cabinet_num": number,
            "work_hours": str(body.get("work_hours", "")).strip() or "08:00 - 16:00"})
        if not ok:
            raise ApiError(msg)
        audit(db, user, "doctor_create", "user", uid, f"Добавлен врач {body.get('full_name', '')}")
        return {"success": True, "message": f"Врач добавлен. Временный пароль: {temp_pw}", "id": uid, "temp_password": temp_pw}

    if method == "POST" and path == "/nurse":
        iin, name = str(body.get("iin", "")).strip(), str(body.get("full_name", "")).strip()
        if len(iin) != 12 or not iin.isdigit() or not name:
            raise ApiError("Нужны ФИО и ИИН из 12 цифр")
        doc = _one(db, "SELECT id FROM users WHERE id=? AND role='doctor'", (int(body.get("doctor_id", 0)),))
        if not doc:
            raise ApiError("Выберите врача, к которому привязана медсестра")
        raw_pw = str(body.get("password", "")).strip()
        temp_pw = raw_pw or secrets.token_urlsafe(6)
        if len(temp_pw) < 6:
            raise ApiError("Пароль — минимум 6 символов")
        try:
            uid = _exec(db, "INSERT INTO users (iin, password_hash, full_name, email, phone, role, must_change_password, created_at) "
                            "VALUES (?, ?, ?, '', ?, 'nurse', 0, ?)",
                        (iin, hash_password(temp_pw), name, str(body.get("phone", "")), now()))
        except sqlite3.IntegrityError:
            raise ApiError("Пользователь с таким ИИН уже есть")
        _exec(db, "INSERT INTO nurse_profiles (user_id, doctor_id) VALUES (?, ?)", (uid, doc["id"]))
        audit(db, user, "nurse_create", "user", uid, f"Добавлена медсестра {name}")
        return {"success": True, "message": f"Медсестра добавлена. Временный пароль: {temp_pw}", "id": uid, "temp_password": temp_pw}

    if method == "POST" and path == "/cabinet":
        number = str(body.get("number", "")).strip()
        if not number:
            raise ApiError("Укажите номер кабинета")
        try:
            _exec(db, "INSERT INTO cabinets (number, name) VALUES (?, ?)", (number, str(body.get("name", "")).strip()))
        except sqlite3.IntegrityError:
            raise ApiError("Такой кабинет уже существует")
        return {"success": True, "message": "Кабинет добавлен"}

    if method == "POST" and path == "/cabinet/delete":
        c = _one(db, "SELECT number FROM cabinets WHERE id=?", (int(body["id"]),))
        if not c:
            raise ApiError("Кабинет не найден", 404)
        if _one(db, "SELECT 1 FROM doctor_profiles WHERE cabinet_num=?", (c["number"],)):
            raise ApiError("В кабинете работает врач — сначала переназначьте его")
        _exec(db, "DELETE FROM cabinets WHERE id=?", (int(body["id"]),))
        return {"success": True, "message": "Кабинет удалён"}

    if method == "POST" and path == "/user/update":
        u = _one(db, "SELECT id, role FROM users WHERE id=?", (int(body["id"]),))
        if not u:
            raise ApiError("Пользователь не найден", 404)
        if body.get("password"):
            if len(str(body["password"])) < 6:
                raise ApiError("Пароль — минимум 6 символов")
            _exec(db, "UPDATE users SET password_hash=? WHERE id=?",
                  (hash_password(str(body["password"])), u["id"]))
        if u["role"] == "doctor" and body.get("cabinet_num"):
            _exec(db, "UPDATE doctor_profiles SET cabinet_num=? WHERE user_id=?", (str(body["cabinet_num"]), u["id"]))
        if u["role"] == "doctor" and body.get("specialty"):
            _exec(db, "UPDATE doctor_profiles SET specialty=? WHERE user_id=?", (str(body["specialty"]), u["id"]))
        if u["role"] == "doctor" and body.get("work_hours"):
            _exec(db, "UPDATE doctor_profiles SET work_hours=? WHERE user_id=?", (str(body["work_hours"]).strip(), u["id"]))
        if u["role"] == "nurse" and body.get("doctor_id"):
            _exec(db, "UPDATE nurse_profiles SET doctor_id=? WHERE user_id=?", (int(body["doctor_id"]), u["id"]))
        audit(db, user, "user_update", "user", u["id"], "Обновлены данные пользователя")
        return {"success": True, "message": "Сохранено"}

    if method == "POST" and path == "/user/delete":
        u = _one(db, "SELECT id, role, full_name FROM users WHERE id=?", (int(body["id"]),))
        if not u:
            raise ApiError("Пользователь не найден", 404)
        if u["role"] == "superadmin":
            raise ApiError("Нельзя удалить администратора")
        _exec(db, "DELETE FROM users WHERE id=?", (u["id"],))
        for t, uid in list(SESSIONS.items()):
            if uid == u["id"]:
                SESSIONS.pop(t, None)
        audit(db, user, "user_delete", "user", u["id"], f"Удалён пользователь {u['full_name']} ({u['role']})")
        return {"success": True, "message": f"Пользователь {u['full_name']} удалён"}

    if method == "POST" and path == "/reset-db":
        with db.get_connection() as conn:
            for tbl in ("appointments", "medical_records", "prescriptions", "sick_leaves",
                        "referrals", "vaccination_records", "lab_orders", "imaging_studies",
                        "medical_certificates", "nurse_profiles", "doctor_profiles",
                        "patient_profiles", "cabinets", "audit_log"):
                conn.execute(f"DELETE FROM {tbl}")
            conn.execute("DELETE FROM users WHERE role != 'superadmin'")
            conn.commit()
        for t, uid in list(SESSIONS.items()):
            if uid != user["id"]:
                SESSIONS.pop(t, None)
        audit(db, user, "db_reset", "system", None, "Полная очистка базы данных администратором")
        return {"success": True, "message": "База данных полностью очищена"}

    raise ApiError("Маршрут не найден", 404)