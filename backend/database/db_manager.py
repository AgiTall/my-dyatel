"""
Медицинский портал 'My Dyatel'
Модуль управления базой данных SQLite (db_manager.py)
Связывает реляционную БД SQLite с полиморфными объектными моделями ООП.
"""

import sqlite3
import json
import os
import hashlib
import hmac
import secrets
import time
import random
import uuid
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional, Tuple


DB_FILE = os.path.join(os.path.dirname(__file__), "..", "..", "damumed_portal.db")


def _now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _today_str() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def hash_password(password: str) -> str:
    """Хеширование пароля через scrypt с индивидуальной случайной солью."""
    salt = secrets.token_hex(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt.encode("utf-8"), n=16384, r=8, p=1, dklen=32)
    return f"scrypt${salt}${dk.hex()}"


def is_legacy_hash(stored_hash: str) -> bool:
    return not str(stored_hash).startswith("scrypt$")


def verify_password(password: str, stored_hash: str) -> bool:
    """Проверка пароля (поддерживает scrypt и устаревший SHA-256 для плавной миграции)."""
    if not stored_hash:
        return False
    if stored_hash.startswith("scrypt$"):
        parts = stored_hash.split("$")
        if len(parts) != 3:
            return False
        _, salt, hex_dk = parts
        dk = hashlib.scrypt(password.encode("utf-8"), salt=salt.encode("utf-8"), n=16384, r=8, p=1, dklen=32)
        return hmac.compare_digest(dk.hex(), hex_dk)
    # Обратная совместимость со старым SHA-256
    legacy = hashlib.sha256((password + "mydyatel_med_salt_2026").encode("utf-8")).hexdigest()
    return hmac.compare_digest(legacy, stored_hash)


class DatabaseManager:
    """Синглтон/Менеджер подключений и запросов к SQLite"""

    def __init__(self, db_path: str = DB_FILE):
        self.db_path = os.path.abspath(db_path)
        self.init_schema()
        self.seed_sample_data()

    def get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON;")
        return conn

    def init_schema(self):
        """Создание таблиц SQLite базы данных медпортала"""
        with self.get_connection() as conn:
            cursor = conn.cursor()

            # 1. Таблица пользователей
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                iin TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                full_name TEXT NOT NULL,
                email TEXT,
                phone TEXT,
                role TEXT NOT NULL CHECK(role IN ('patient', 'doctor')),
                created_at TEXT NOT NULL
            );
            """)

            # 2. Профили врачей
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS doctor_profiles (
                user_id INTEGER PRIMARY KEY,
                license_num TEXT NOT NULL,
                specialty TEXT NOT NULL,
                cabinet_num TEXT NOT NULL,
                experience_years INTEGER NOT NULL,
                category TEXT NOT NULL,
                work_hours TEXT NOT NULL,
                signature_data TEXT DEFAULT '',
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """)

            # 3. Профили пациентов
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS patient_profiles (
                user_id INTEGER PRIMARY KEY,
                birth_date TEXT NOT NULL,
                blood_group TEXT NOT NULL,
                allergies TEXT,
                chronic_diseases TEXT,
                emergency_contact TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """)

            # 4. Записи на прием (Appointments)
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS appointments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                patient_id INTEGER NOT NULL,
                doctor_id INTEGER NOT NULL,
                app_date TEXT NOT NULL,
                time_slot TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled')),
                complaint TEXT,
                diagnosis TEXT,
                notes TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (doctor_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """)

            # 5. Электронная медицинская карта (Medical Records)
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS medical_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                patient_id INTEGER NOT NULL,
                doctor_id INTEGER NOT NULL,
                record_type TEXT NOT NULL,
                title TEXT NOT NULL,
                diagnosis TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (doctor_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """)

            # 6. Электронные рецепты (Prescriptions)
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS prescriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                patient_id INTEGER NOT NULL,
                doctor_id INTEGER NOT NULL,
                medication TEXT NOT NULL,
                dosage TEXT NOT NULL,
                instructions TEXT NOT NULL,
                qr_code_str TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('active', 'dispensed', 'expired')),
                valid_until TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (doctor_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """)

            # 7. Электронные больничные листы (ЭЛН)
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS sick_leaves (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                patient_id INTEGER NOT NULL,
                doctor_id INTEGER NOT NULL,
                eln_number TEXT UNIQUE NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                days_count INTEGER NOT NULL,
                diagnosis TEXT NOT NULL,
                employer TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('active', 'closed', 'extended')),
                created_at TEXT NOT NULL,
                FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (doctor_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """)

            # 8. Направления к узким специалистам и на диагностику
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS referrals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                patient_id INTEGER NOT NULL,
                from_doctor_id INTEGER NOT NULL,
                to_specialty TEXT NOT NULL,
                target_doctor_id INTEGER,
                reason TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('active', 'used', 'expired')),
                valid_until TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (from_doctor_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """)

            # 9. Паспорт вакцинации и прививочная карта
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS vaccination_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                patient_id INTEGER NOT NULL,
                doctor_id INTEGER NOT NULL,
                vaccine_name TEXT NOT NULL,
                dose_number TEXT NOT NULL,
                date_given TEXT NOT NULL,
                batch_number TEXT NOT NULL,
                reaction TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (doctor_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """)

            # 10. Направления на анализы и лабораторные исследования (ЛИС)
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS lab_orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                patient_id INTEGER NOT NULL,
                doctor_id INTEGER NOT NULL,
                test_type TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('ordered', 'in_progress', 'ready')),
                result_json TEXT,
                normal_range TEXT,
                doctor_comment TEXT,
                completed_at TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (doctor_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """)

            # 11. Официальные медицинские справки и медосмотры (Форма 075/у, 026/у, бассейн и др.)
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS medical_certificates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                patient_id INTEGER NOT NULL,
                doctor_id INTEGER NOT NULL,
                cert_type TEXT NOT NULL,
                cert_number TEXT UNIQUE NOT NULL,
                title TEXT NOT NULL,
                target_org TEXT NOT NULL,
                diagnosis TEXT NOT NULL,
                conclusion TEXT NOT NULL,
                valid_until TEXT NOT NULL,
                qr_code TEXT NOT NULL,
                payload_json TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (patient_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (doctor_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """)

            conn.commit()

    def seed_sample_data(self):
        return

    def register_patient(self, data: Dict[str, Any]) -> Tuple[bool, str, Optional[int]]:
        """Регистрация нового пациента в системе"""
        iin = data.get("iin", "").strip()
        password = data.get("password", "").strip()
        if len(password) < 6:
            return False, "Пароль должен содержать минимум 6 символов", None
        full_name = data.get("full_name", "").strip()
        email = data.get("email", "").strip()
        phone = data.get("phone", "").strip()
        birth_date = data.get("birth_date", "2000-01-01").strip()
        blood_group = data.get("blood_group", "O(I) Rh+").strip()
        allergies = data.get("allergies", "Не выявлено").strip()
        chronic_diseases = data.get("chronic_diseases", "Нет").strip()
        emergency_contact = data.get("emergency_contact", "").strip()

        if len(iin) != 12 or not iin.isdigit():
            return False, "ИИН должен содержать ровно 12 цифр", None

        if not full_name:
            return False, "Укажите ФИО пациента", None

        now_str = _now_str()
        pwd_hash = hash_password(password)

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("""
                INSERT INTO users (iin, password_hash, full_name, email, phone, role, created_at)
                VALUES (?, ?, ?, ?, ?, 'patient', ?)
                """, (iin, pwd_hash, full_name, email, phone, now_str))
                uid = cursor.lastrowid

                cursor.execute("""
                INSERT INTO patient_profiles (user_id, birth_date, blood_group, allergies, chronic_diseases, emergency_contact)
                VALUES (?, ?, ?, ?, ?, ?)
                """, (uid, birth_date, blood_group, allergies, chronic_diseases, emergency_contact))

                conn.commit()
                return True, "Пациент успешно зарегистрирован", uid
        except sqlite3.IntegrityError:
            return False, "Пользователь с таким ИИН уже зарегистрирован в системе", None

    def register_doctor(self, data: Dict[str, Any]) -> Tuple[bool, str, Optional[int]]:
        """Регистрация нового врача в системе"""
        iin = data.get("iin", "").strip()
        password = data.get("password", "").strip()
        if len(password) < 6:
            return False, "Пароль должен содержать минимум 6 символов", None
        full_name = data.get("full_name", "").strip()
        email = data.get("email", "").strip()
        phone = data.get("phone", "").strip()
        license_num = data.get("license_num", "").strip()
        specialty = data.get("specialty", "Терапевт (ВОП)").strip()
        cabinet_num = data.get("cabinet_num", "101").strip()
        experience_years = int(data.get("experience_years", 5))
        category = data.get("category", "Вторая категория").strip()
        work_hours = data.get("work_hours", "08:00 - 16:00").strip()

        if len(iin) != 12 or not iin.isdigit():
            return False, "ИИН должен состоять из 12 цифр", None
        if not full_name:
            return False, "Укажите ФИО врача", None
        if not license_num:
            return False, "Укажите номер государственной медицинской лицензии", None

        now_str = _now_str()
        pwd_hash = hash_password(password)

        try:
            with self.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("""
                INSERT INTO users (iin, password_hash, full_name, email, phone, role, created_at)
                VALUES (?, ?, ?, ?, ?, 'doctor', ?)
                """, (iin, pwd_hash, full_name, email, phone, now_str))
                uid = cursor.lastrowid

                cursor.execute("""
                INSERT INTO doctor_profiles (user_id, license_num, specialty, cabinet_num, experience_years, category, work_hours)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (uid, license_num, specialty, cabinet_num, experience_years, category, work_hours))

                conn.commit()
                return True, "Врач успешно зарегистрирован в реестре My Dyatel", uid
        except sqlite3.IntegrityError:
            return False, "Пользователь с таким ИИН уже зарегистрирован в системе", None

    # ================== ОПЕРАЦИИ С ЗАПИСЯМИ И ДАШБОРДАМИ ==================

    def get_all_doctors_list(self) -> List[Dict[str, Any]]:
        """Получить список доступных врачей для онлайн-записи"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            SELECT u.id, u.full_name, u.phone, u.email,
                   d.license_num, d.specialty, d.cabinet_num, d.experience_years, d.category, d.work_hours
            FROM users u
            JOIN doctor_profiles d ON u.id = d.user_id
            WHERE u.role = 'doctor'
            ORDER BY d.specialty, u.full_name
            """)
            rows = cursor.fetchall()
            return [dict(r) for r in rows]

    def get_all_patients_list(self) -> List[Dict[str, Any]]:
        """Получить список пациентов для врачебного кабинета"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            SELECT u.id, u.iin, u.full_name, u.phone,
                   p.birth_date, p.blood_group, p.allergies, p.chronic_diseases, p.emergency_contact
            FROM users u
            JOIN patient_profiles p ON u.id = p.user_id
            WHERE u.role = 'patient'
            ORDER BY u.full_name
            """)
            rows = cursor.fetchall()
            return [dict(r) for r in rows]

    def get_user_appointments(self, user_id: int, role: str) -> List[Dict[str, Any]]:
        """Получить записи на прием для пациента или врача"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            if role == "doctor":
                cursor.execute("""
                SELECT a.*, p.full_name AS patient_name, p.phone AS patient_phone, p.iin AS patient_iin
                FROM appointments a
                JOIN users p ON a.patient_id = p.id
                WHERE a.doctor_id = ?
                ORDER BY a.app_date DESC, a.time_slot ASC
                """, (user_id,))
            else:
                cursor.execute("""
                SELECT a.*, d.full_name AS doctor_name, dp.specialty AS doctor_specialty, dp.cabinet_num AS doctor_cabinet
                FROM appointments a
                JOIN users d ON a.doctor_id = d.id
                JOIN doctor_profiles dp ON d.id = dp.user_id
                WHERE a.patient_id = ?
                ORDER BY a.app_date DESC, a.time_slot ASC
                """, (user_id,))
            rows = cursor.fetchall()
            return [dict(r) for r in rows]

    def book_appointment(self, patient_id: int, doctor_id: int, app_date: str, time_slot: str, complaint: str) -> Tuple[bool, str]:
        """Создание записи на прием"""
        now_str = _now_str()
        with self.get_connection() as conn:
            cursor = conn.cursor()
            # Проверим, не занят ли слот
            cursor.execute("""
            SELECT id FROM appointments
            WHERE doctor_id = ? AND app_date = ? AND time_slot = ? AND status != 'cancelled'
            """, (doctor_id, app_date, time_slot))
            if cursor.fetchone():
                return False, "Выбранное время уже занято другим пациентом. Пожалуйста, выберите другой слот."

            cursor.execute("""
            INSERT INTO appointments (patient_id, doctor_id, app_date, time_slot, status, complaint, diagnosis, notes, created_at)
            VALUES (?, ?, ?, ?, 'confirmed', ?, '', '', ?)
            """, (patient_id, doctor_id, app_date, time_slot, complaint, now_str))
            conn.commit()
            return True, "Запись на прием успешно зарегистрирована в My Dyatel!"

    def get_patient_medical_records(self, patient_id: int) -> List[Dict[str, Any]]:
        """Получить электронную медицинскую карту (ЭМК) пациента"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            SELECT mr.*, d.full_name AS doctor_name, dp.specialty AS doctor_specialty
            FROM medical_records mr
            JOIN users d ON mr.doctor_id = d.id
            JOIN doctor_profiles dp ON d.id = dp.user_id
            WHERE mr.patient_id = ?
            ORDER BY mr.created_at DESC
            """, (patient_id,))
            rows = cursor.fetchall()
            result = []
            for r in rows:
                item = dict(r)
                try:
                    item["payload"] = json.loads(item["payload_json"])
                except Exception:
                    item["payload"] = {}
                result.append(item)
            return result

    def get_patient_prescriptions(self, patient_id: int) -> List[Dict[str, Any]]:
        """Получить активные электронные рецепты пациента"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            SELECT pr.*, d.full_name AS doctor_name, dp.specialty AS doctor_specialty,
                   dp.license_num AS doctor_license, dp.signature_data AS doctor_signature
            FROM prescriptions pr
            JOIN users d ON pr.doctor_id = d.id
            JOIN doctor_profiles dp ON d.id = dp.user_id
            WHERE pr.patient_id = ?
            ORDER BY pr.created_at DESC
            """, (patient_id,))
            rows = cursor.fetchall()
            return [dict(r) for r in rows]

    def add_medical_record(self, patient_id: int, doctor_id: int, record_type: str, title: str, diagnosis: str, payload: Dict[str, Any]) -> int:
        """Добавить запись в медицинскую карту пациента"""
        now_str = _now_str()
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            INSERT INTO medical_records (patient_id, doctor_id, record_type, title, diagnosis, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (patient_id, doctor_id, record_type, title, diagnosis, json.dumps(payload, ensure_ascii=False), now_str))
            rec_id = cursor.lastrowid
            conn.commit()
            return rec_id

    def issue_prescription(self, patient_id: int, doctor_id: int, medication: str, dosage: str, instructions: str, valid_until: str = "2026-12-31") -> int:
        """Выписать электронный рецепт с защитным QR-кодом"""
        now_str = _now_str()
        rand_suffix = uuid.uuid4().hex[:6].upper()
        qr_code = f"DYATEL-RX-{patient_id:04d}-{doctor_id:03d}-{rand_suffix}"
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            INSERT INTO prescriptions (patient_id, doctor_id, medication, dosage, instructions, qr_code_str, status, valid_until, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
            """, (patient_id, doctor_id, medication, dosage, instructions, qr_code, valid_until, now_str))
            rx_id = cursor.lastrowid
            conn.commit()
            return rx_id

    # ================== КЛИНИЧЕСКИЕ ОПЕРАЦИИ (БОЛЬНИЧНЫЕ, НАПРАВЛЕНИЯ, ЛИС, ВАКЦИНЫ) ==================

    def create_sick_leave(self, patient_id: int, doctor_id: int, days_count: int, diagnosis: str, employer: str = "ТОО 'Казахстан Инжиниринг'") -> Dict[str, Any]:
        """Официальная выдача электронного листа нетрудоспособности (ЭЛН)"""
        now_str = _now_str()
        start_date = _today_str()
        end_date = (datetime.now() + timedelta(days=max(1, int(days_count)))).strftime("%Y-%m-%d")
        rand_code = uuid.uuid4().hex[:6].upper()
        eln_num = f"DYATEL-ELN-{patient_id:04d}-{rand_code}"

        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            INSERT INTO sick_leaves (patient_id, doctor_id, eln_number, start_date, end_date, days_count, diagnosis, employer, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
            """, (patient_id, doctor_id, eln_num, start_date, end_date, days_count, diagnosis, employer, now_str))
            eln_id = cursor.lastrowid
            conn.commit()
            return {
                "id": eln_id,
                "eln_number": eln_num,
                "start_date": start_date,
                "end_date": end_date,
                "days_count": days_count,
                "diagnosis": diagnosis,
                "employer": employer,
                "status": "active"
            }

    def get_patient_sick_leaves(self, patient_id: int) -> List[Dict[str, Any]]:
        """Получить больничные листы пациента"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            SELECT sl.*, d.full_name AS doctor_name, dp.specialty AS doctor_specialty,
                   dp.license_num AS doctor_license, dp.signature_data AS doctor_signature
            FROM sick_leaves sl
            JOIN users d ON sl.doctor_id = d.id
            JOIN doctor_profiles dp ON d.id = dp.user_id
            WHERE sl.patient_id = ?
            ORDER BY sl.created_at DESC
            """, (patient_id,))
            rows = cursor.fetchall()
            return [dict(r) for r in rows]

    def close_sick_leave(self, eln_id: int) -> bool:
        """Закрытие больничного листа и выписка к труду"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE sick_leaves SET status = 'closed' WHERE id = ?", (eln_id,))
            conn.commit()
            return True

    def create_referral(self, patient_id: int, from_doctor_id: int, to_specialty: str, reason: str, target_doctor_id: Optional[int] = None) -> int:
        """Выписка направления к профильному специалисту"""
        now_str = _now_str()
        valid_until = "2026-12-15"
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            INSERT INTO referrals (patient_id, from_doctor_id, to_specialty, target_doctor_id, reason, status, valid_until, created_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
            """, (patient_id, from_doctor_id, to_specialty, target_doctor_id, reason, valid_until, now_str))
            ref_id = cursor.lastrowid
            conn.commit()
            return ref_id

    def get_patient_referrals(self, patient_id: int) -> List[Dict[str, Any]]:
        """Получить направления пациента"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            SELECT ref.*, d.full_name AS doctor_from_name, dp.specialty AS doctor_from_specialty,
                   dp.license_num AS doctor_license, dp.signature_data AS doctor_signature
            FROM referrals ref
            JOIN users d ON ref.from_doctor_id = d.id
            JOIN doctor_profiles dp ON d.id = dp.user_id
            WHERE ref.patient_id = ?
            ORDER BY ref.created_at DESC
            """, (patient_id,))
            rows = cursor.fetchall()
            return [dict(r) for r in rows]

    def create_vaccination(self, patient_id: int, doctor_id: int, vaccine_name: str, dose_number: str, batch_number: str = "SER-2026-KZ", reaction: str = "Реакция отсутствует, место инъекции спокойно") -> int:
        """Фиксация выполненной вакцинации в иммунный паспорт"""
        now_str = _today_str()
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            INSERT INTO vaccination_records (patient_id, doctor_id, vaccine_name, dose_number, date_given, batch_number, reaction, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (patient_id, doctor_id, vaccine_name, dose_number, now_str, batch_number, reaction, now_str))
            vac_id = cursor.lastrowid
            conn.commit()
            return vac_id

    def get_patient_vaccinations(self, patient_id: int) -> List[Dict[str, Any]]:
        """Получить прививочную карту пациента"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            SELECT vr.*, d.full_name AS doctor_name
            FROM vaccination_records vr
            JOIN users d ON vr.doctor_id = d.id
            WHERE vr.patient_id = ?
            ORDER BY vr.date_given DESC
            """, (patient_id,))
            rows = cursor.fetchall()
            return [dict(r) for r in rows]

    def create_lab_order(self, patient_id: int, doctor_id: int, test_type: str, result_json: Optional[Dict[str, Any]] = None, normal_range: str = "В пределах возрастной нормы") -> int:
        """Направление и внесение результатов в ЛИС (Лабораторную систему)"""
        now_str = _now_str()
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            INSERT INTO lab_orders (patient_id, doctor_id, test_type, status, result_json, normal_range, doctor_comment, completed_at, created_at)
            VALUES (?, ?, ?, 'ready', ?, ?, 'Результат валидирован клинической лабораторией', ?, ?)
            """, (patient_id, doctor_id, test_type, json.dumps(result_json or {}, ensure_ascii=False), normal_range, now_str, now_str))
            lab_id = cursor.lastrowid
            conn.commit()
            return lab_id

    def get_patient_lab_orders(self, patient_id: int) -> List[Dict[str, Any]]:
        """Получить анализы пациента"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            SELECT lo.*, d.full_name AS doctor_name, dp.specialty AS doctor_specialty
            FROM lab_orders lo
            JOIN users d ON lo.doctor_id = d.id
            JOIN doctor_profiles dp ON d.id = dp.user_id
            WHERE lo.patient_id = ?
            ORDER BY lo.created_at DESC
            """, (patient_id,))
            rows = cursor.fetchall()
            result = []
            for r in rows:
                item = dict(r)
                try:
                    item["result"] = json.loads(item["result_json"])
                except Exception:
                    item["result"] = {}
                result.append(item)
            return result

    def get_full_patient_profile(self, patient_id: int) -> Optional[Dict[str, Any]]:
        """Полное клиническое досье пациента для врача при начале приема"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            SELECT u.id, u.iin, u.full_name, u.phone, u.email,
                   p.birth_date, p.blood_group, p.allergies, p.chronic_diseases, p.emergency_contact
            FROM users u
            JOIN patient_profiles p ON u.id = p.user_id
            WHERE u.id = ?
            """, (patient_id,))
            row = cursor.fetchone()
            if not row:
                return None
            data = dict(row)

            # Прикрепляем историю
            data["medical_records"] = self.get_patient_medical_records(patient_id)
            data["recent_records"] = data["medical_records"]
            data["prescriptions"] = self.get_patient_prescriptions(patient_id)
            data["sick_leaves"] = self.get_patient_sick_leaves(patient_id)
            data["referrals"] = self.get_patient_referrals(patient_id)
            data["vaccinations"] = self.get_patient_vaccinations(patient_id)
            data["lab_orders"] = self.get_patient_lab_orders(patient_id)
            data["certificates"] = self.get_patient_certificates(patient_id)
            return data

    # ================== АВТОМАТИЗАЦИЯ МЕДИЦИНСКИХ СПРАВОК И PDF ==================

    def create_medical_certificate(
        self,
        patient_id: int,
        doctor_id: int,
        cert_type: str,
        target_org: str,
        diagnosis: str,
        conclusion: str,
        valid_until: str = "2027-05-15",
        payload: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Официальная автоматизированная выписка справки с QR-кодом для PDF экспорта"""
        now_str = _now_str()
        rand_code = uuid.uuid4().hex[:6].upper()
        cert_num = f"MD-CERT-2026-{rand_code}"
        qr_code = f"/api/v2/verify?number={cert_num}"

        title_map = {
            "075/у": "Форма № 075/у: Врачебное профессионально-консультативное заключение",
            "026/у": "Форма № 026/у: Паспорт здоровья ребенка (для школы / детсада)",
            "037/у": "Форма № 037/у: Справка о временной нетрудоспособности студента",
            "027/у": "Форма № 027/у: Выписка из медицинской карты амбулаторного больного",
            "Бассейн": "Медицинская справка для посещения плавательного бассейна и спортивных секций",
            "Эпидокружение": "Справка об отсутствии контактов с инфекционными больными (эпидокружение)"
        }
        title = title_map.get(cert_type, f"Медицинская справка ({cert_type})")

        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            INSERT INTO medical_certificates (patient_id, doctor_id, cert_type, cert_number, title, target_org, diagnosis, conclusion, valid_until, qr_code, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (patient_id, doctor_id, cert_type, cert_num, title, target_org, diagnosis, conclusion, valid_until, qr_code, json.dumps(payload or {}, ensure_ascii=False), now_str))
            cert_id = cursor.lastrowid
            conn.commit()
            return {
                "id": cert_id,
                "cert_number": cert_num,
                "cert_type": cert_type,
                "title": title,
                "target_org": target_org,
                "diagnosis": diagnosis,
                "conclusion": conclusion,
                "valid_until": valid_until,
                "qr_code": qr_code,
                "created_at": now_str
            }

    def get_patient_certificates(self, patient_id: int) -> List[Dict[str, Any]]:
        """Получить все справки пациента"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            SELECT mc.*, d.full_name AS doctor_name, dp.specialty AS doctor_specialty,
                   dp.license_num AS doctor_license, dp.signature_data AS doctor_signature,
                   p.full_name AS patient_name, p.iin AS patient_iin
            FROM medical_certificates mc
            JOIN users d ON mc.doctor_id = d.id
            JOIN doctor_profiles dp ON d.id = dp.user_id
            JOIN users p ON mc.patient_id = p.id
            WHERE mc.patient_id = ?
            ORDER BY mc.created_at DESC
            """, (patient_id,))
            rows = cursor.fetchall()
            res = []
            for r in rows:
                item = dict(r)
                try:
                    item["payload"] = json.loads(item["payload_json"])
                except Exception:
                    item["payload"] = {}
                res.append(item)
            return res

    def get_all_certificates(self) -> List[Dict[str, Any]]:
        """Получить все выданные справки в поликлинике"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            SELECT mc.*, d.full_name AS doctor_name, dp.specialty AS doctor_specialty,
                   dp.license_num AS doctor_license, dp.signature_data AS doctor_signature,
                   p.full_name AS patient_name, p.iin AS patient_iin
            FROM medical_certificates mc
            JOIN users d ON mc.doctor_id = d.id
            JOIN doctor_profiles dp ON d.id = dp.user_id
            JOIN users p ON mc.patient_id = p.id
            ORDER BY mc.created_at DESC
            """)
            rows = cursor.fetchall()
            res = []
            for r in rows:
                item = dict(r)
                try:
                    item["payload"] = json.loads(item["payload_json"])
                except Exception:
                    item["payload"] = {}
                res.append(item)
            return res

    def get_certificate_by_id(self, cert_id: int) -> Optional[Dict[str, Any]]:
        """Получить конкретную справку со всеми реквизитами для PDF"""
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
            SELECT mc.*, d.full_name AS doctor_name, dp.specialty AS doctor_specialty, dp.license_num AS doctor_license,
                   p.full_name AS patient_name, p.iin AS patient_iin, pp.birth_date, pp.blood_group
            FROM medical_certificates mc
            JOIN users d ON mc.doctor_id = d.id
            JOIN doctor_profiles dp ON d.id = dp.user_id
            JOIN users p ON mc.patient_id = p.id
            LEFT JOIN patient_profiles pp ON p.id = pp.user_id
            WHERE mc.id = ?
            """, (cert_id,))
            row = cursor.fetchone()
            if not row:
                return None
            item = dict(row)
            try:
                item["payload"] = json.loads(item["payload_json"])
            except Exception:
                item["payload"] = {}
            return item
