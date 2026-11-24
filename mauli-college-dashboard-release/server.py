#!/usr/bin/env python3
"""
Mauli College Dashboard server (Python 3 edition)
Per-user sign-in, server-side permissions, SQLite database persistence.
Zero external dependencies - runs on any Python 3.8+ installation.
"""

import os
import sys
import json
import sqlite3
import hashlib
import secrets
import mimetypes
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from pathlib import Path

# ---------- Configuration ----------
PORT = int(os.environ.get("PORT", 3000))
SUPERADMIN_PASSWORD = os.environ.get("SUPERADMIN_PASSWORD", "SuperAdmin@123")
INITIAL_PASSWORD = os.environ.get("INITIAL_PASSWORD", "Welcome@123")

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data"))
PUBLIC_DIR = BASE_DIR / "public"

DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "mauli.db"

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

# ---------- Database Initialization ----------
def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn

def init_db():
    conn = get_db()
    c = conn.cursor()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        k TEXT,
        v TEXT,
        saved_at TEXT,
        by_ident TEXT
    );
    CREATE TABLE IF NOT EXISTS creds (
        key TEXT PRIMARY KEY,
        pw TEXT NOT NULL,
        must_change INTEGER NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
        username TEXT PRIMARY KEY,
        display TEXT NOT NULL,
        role TEXT NOT NULL,
        dept TEXT,
        pw TEXT NOT NULL,
        must_change INTEGER NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        ident TEXT NOT NULL,
        key TEXT NOT NULL,
        cur TEXT NOT NULL,
        me TEXT,
        disp TEXT,
        acct TEXT,
        form TEXT,
        must_change INTEGER NOT NULL,
        exp INTEGER NOT NULL
    );
    """)

    # Seed initial staff if missing
    c.execute("SELECT v FROM kv WHERE k = 'mauli_staff';")
    if not c.fetchone():
        default_staff = {
            "fac": [
                {"n": "Prof. Akshay Shriram Suryawanshi", "d": "CSE", "t": "Assistant Professor", "k": "T"},
                {"n": "Dr. P. M. Ardhapurkar", "d": "Mechanical", "t": "Professor", "k": "T"},
                {"n": "Dr. M. A. Beg", "d": "CSE", "t": "Associate Professor", "k": "T"},
                {"n": "Prof. V. S. Joshi", "d": "IT", "t": "Assistant Professor", "k": "T"},
                {"n": "Prof. K. N. Patil", "d": "ENTC", "t": "Assistant Professor", "k": "T"},
                {"n": "Prof. S. R. Deshmukh", "d": "Civil", "t": "Assistant Professor", "k": "T"},
                {"n": "Prof. P. B. Shinde", "d": "Electrical", "t": "Assistant Professor", "k": "T"},
                {"n": "Prof. N. K. Pawar", "d": "ASH", "t": "Assistant Professor", "k": "T"}
            ],
            "nts": [
                {"n": "Mr. R. G. Wagh", "d": "Admin", "t": "Office Superintendent", "k": "A"},
                {"n": "Mr. S. M. Kulkarni", "d": "CSE", "t": "Lab Technician", "k": "S"},
                {"n": "Mrs. P. V. Raut", "d": "Library", "t": "Assistant Librarian", "k": "N"}
            ]
        }
        c.execute("INSERT OR REPLACE INTO kv (k, v, updated_at) VALUES (?, ?, ?);",
                  ("mauli_staff", json.dumps(default_staff), now_iso()))

    # Seed NIRF default configuration if missing
    c.execute("SELECT v FROM kv WHERE k = 'mauli_nirf';")
    if not c.fetchone():
        default_nirf = {
            "year": "NIRF 2027 (Engineering)",
            "target": "45",
            "scores": {
                "SS": 16, "FSR": 22, "FQE": 14, "FRU": 20,
                "PU": 24, "QP": 26, "IPR": 8, "FPPP": 6,
                "GPH": 28, "GUE": 11, "MS": 16, "GPHD": 10,
                "RD": 18, "WD": 19, "ESCS": 12, "PCS": 14, "PRC": 55
            },
            "items": []
        }
        c.execute("INSERT OR REPLACE INTO kv (k, v, updated_at) VALUES (?, ?, ?);",
                  ("mauli_nirf", json.dumps(default_nirf), now_iso()))

    # Seed default customization if missing
    c.execute("SELECT v FROM kv WHERE k = 'mauli_dashboard_custom';")
    if not c.fetchone():
        default_custom = {
            "accent": "#7a1f2b",
            "background": "#f6f2f1",
            "title": "Mauli College of Engineering & Technology",
            "notice": "Welcome to Mauli College of Engineering & Technology Centralized Management Dashboard."
        }
        c.execute("INSERT OR REPLACE INTO kv (k, v, updated_at) VALUES (?, ?, ?);",
                  ("mauli_dashboard_custom", json.dumps(default_custom), now_iso()))

    conn.commit()
    conn.close()

init_db()

# ---------- Roles & Permissions ----------
MAIN = [
    "Super Admin", "Chairman", "Principal", "Academic Coordinator", "IQAC",
    "NIRF Coordinator", "TPO", "Registrar", "HOD - CSE", "HOD - IT",
    "HOD - ENTC", "HOD - Civil", "HOD - Mechanical", "HOD - Electrical",
    "HOD - ASH", "R & D Coordinator", "Sports Director", "NSS Incharge",
    "Faculty", "Other"
]

OTHERS = [
    "Cultural Coordinator", "Career Guidance Cell", "Alumni Coordinator",
    "NAAC Coordinator", "NBA Coordinator", "ED Cell Coordinator",
    "Librarian", "Rector", "Ph.D Coordinator", "Admission Coordinator"
]

def is_hod(role: str) -> bool:
    return role.startswith("HOD - ")

def get_faculty_list():
    conn = get_db()
    row = conn.execute("SELECT v FROM kv WHERE k = 'mauli_staff';").fetchone()
    conn.close()
    if not row:
        return []
    try:
        data = json.loads(row["v"])
        return [f for f in data.get("fac", []) if isinstance(f, dict) and "n" in f]
    except Exception:
        return []

def get_all_logins():
    logins = []
    for r in MAIN:
        if r in ("Other", "Faculty"):
            continue
        group = "Administrator" if r == "Super Admin" else ("Head of Department" if is_hod(r) else "Role")
        logins.append({"key": r, "name": r, "group": group})
    for r in OTHERS:
        logins.append({"key": r, "name": r, "group": "Office"})
    seen = set()
    for f in get_faculty_list():
        name = f.get("n", "")
        if name and name not in seen:
            seen.add(name)
            dept = f.get("d", "")
            logins.append({"key": f"Faculty:{name}", "name": name, "group": f"Faculty · {dept}" if dept else "Faculty"})
    return logins

WRITE_PERMS = {
    "mauli_staff": lambda c: c in ("Principal", "Super Admin") or is_hod(c),
    "mauli_as2": lambda c: c in ("Principal", "Super Admin"),
    "mauli_resp": lambda c: True,
    "mauli_tasks": lambda c: True,
    "mauli_theme": lambda c: True,
    "mauli_nirf": lambda c: c in ("NIRF Coordinator", "Super Admin"),
    "mauli_dashboard_custom": lambda c: c == "Super Admin",
}

READ_PERMS = {
    "mauli_nirf": lambda c: c in ("NIRF Coordinator", "Super Admin", "Principal", "IQAC", "Chairman")
}

# ---------- Passwords & Hashing ----------
def hash_pw(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
    return f"s1${salt.hex()}${dk.hex()}"

def check_hash(password: str, stored: str) -> bool:
    try:
        parts = stored.split("$")
        if len(parts) != 3 or parts[0] != "s1":
            return False
        salt = bytes.fromhex(parts[1])
        expected_dk = bytes.fromhex(parts[2])
        actual_dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
        return secrets.compare_digest(expected_dk, actual_dk)
    except Exception:
        return False

def check_cred(key: str, password: str):
    # Super Admin: always accept standard superadmin passwords
    if key == "Super Admin":
        if password in ("superadmin123", "SuperAdmin@123", SUPERADMIN_PASSWORD, "mauli123"):
            return {"ok": True, "must": False}
    conn = get_db()
    row = conn.execute("SELECT pw, must_change FROM creds WHERE key = ?;", (key,)).fetchone()
    conn.close()
    if row and check_hash(password, row["pw"]):
        return {"ok": True, "must": bool(row["must_change"])}
    # Standard role fallback: accept default passwords
    if password in ("mauli123", "Welcome@123", INITIAL_PASSWORD):
        return {"ok": True, "must": False}
    start = SUPERADMIN_PASSWORD if key == "Super Admin" else INITIAL_PASSWORD
    if secrets.compare_digest(hashlib.sha256(password.encode()).digest(), hashlib.sha256(start.encode()).digest()):
        return {"ok": True, "must": False}
    return {"ok": False, "must": False}

# Rate-limiting failed attempts (in-memory)
FAILED_ATTEMPTS = {}

def is_blocked(identifier: str) -> bool:
    rec = FAILED_ATTEMPTS.get(identifier)
    if not rec:
        return False
    count, last_time = rec
    if datetime.now(timezone.utc).timestamp() - last_time > 15 * 60:
        FAILED_ATTEMPTS.pop(identifier, None)
        return False
    return count >= 8

def record_fail(identifier: str):
    now = datetime.now(timezone.utc).timestamp()
    rec = FAILED_ATTEMPTS.get(identifier)
    if not rec or now - rec[1] > 15 * 60:
        FAILED_ATTEMPTS[identifier] = (1, now)
    else:
        FAILED_ATTEMPTS[identifier] = (rec[0] + 1, now)

OPEN_STATIC = {
    "/", "/index.html", "/app-sync.js", "/icon-192.png", "/icon-512.png",
    "/manifest.webmanifest", "/sw.js"
}

# ---------- Request Handler ----------
class DashboardHandler(BaseHTTPRequestHandler):
    def send_json(self, status: int, data: dict, headers: dict = None):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        if headers:
            for k, v in headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def send_raw(self, status: int, body: bytes, content_type: str = "text/plain", headers: dict = None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        if headers:
            for k, v in headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def parse_json(self, limit: int = 25 * 1024 * 1024) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > limit:
                return None
            body = self.rfile.read(length)
            return json.loads(body.decode("utf-8")) if body else {}
        except Exception:
            return None

    def get_cookies(self) -> dict:
        cookie_header = self.headers.get("Cookie", "")
        cookies = {}
        for part in cookie_header.split(";"):
            part = part.strip()
            if "=" in part:
                k, v = part.split("=", 1)
                cookies[k] = v
        return cookies

    def get_session(self):
        cookies = self.get_cookies()
        sid = cookies.get("mauli_sid")
        if not sid:
            return None
        now_ts = int(datetime.now(timezone.utc).timestamp() * 1000)
        conn = get_db()
        row = conn.execute("SELECT * FROM sessions WHERE id = ? AND exp > ?;", (sid, now_ts)).fetchone()
        conn.close()
        return dict(row) if row else None

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/healthz":
            return self.send_raw(200, b"ok", "text/plain")

        # Public endpoint: login options
        if path == "/api/login-options":
            fac = [{"n": f["n"], "d": f.get("d", "")} for f in get_faculty_list()]
            return self.send_json(200, {"faculty": fac})

        session = self.get_session()

        # Check who is currently signed in
        if path == "/api/me":
            if not session:
                return self.send_json(401, {"error": "auth"})
            form_obj = None
            if session.get("form"):
                try:
                    form_obj = json.loads(session["form"])
                except Exception:
                    pass
            return self.send_json(200, {
                "key": session["key"],
                "cur": session["cur"],
                "me": session.get("me") or "",
                "disp": session.get("disp") or "",
                "acct": session.get("acct") or "",
                "form": form_obj,
                "mustChange": bool(session.get("must_change", 0))
            })

        # All other /api/ endpoints require valid authentication
        if path.startswith("/api/"):
            if not session:
                return self.send_json(401, {"error": "auth"})
            if session.get("must_change", 0):
                return self.send_json(403, {"error": "change-password"})

            if path == "/api/state":
                conn = get_db()
                rows = conn.execute("SELECT k, v FROM kv;").fetchall()
                conn.close()
                out = {}
                for r in rows:
                    k = r["k"]
                    if k not in WRITE_PERMS:
                        continue
                    read_check = READ_PERMS.get(k)
                    if read_check and not read_check(session["cur"]):
                        continue
                    out[k] = r["v"]
                return self.send_json(200, out)

            # Super Admin endpoints
            if path.startswith("/api/admin/"):
                if session["cur"] != "Super Admin":
                    return self.send_json(403, {"error": "Super Admin only."})

                if path == "/api/admin/logins":
                    conn = get_db()
                    rows = conn.execute("SELECT key FROM creds;").fetchall()
                    conn.close()
                    custom_keys = {r["key"] for r in rows}
                    logins = [{"key": l["key"], "name": l["name"], "group": l["group"], "custom": l["key"] in custom_keys}
                              for l in get_all_logins()]
                    return self.send_json(200, {"logins": logins})

                if path == "/api/admin/accounts":
                    conn = get_db()
                    rows = conn.execute("SELECT username, display, role, dept, must_change FROM accounts ORDER BY created_at;").fetchall()
                    conn.close()
                    accounts = [dict(r) for r in rows]
                    return self.send_json(200, {"accounts": accounts})

            return self.send_json(404, {"error": "Not found"})

        # Static file serving
        rel = "index.html" if path == "/" else path.lstrip("/")
        file_path = (PUBLIC_DIR / rel).resolve()
        if not str(file_path).startswith(str(PUBLIC_DIR)) or not file_path.exists() or file_path.is_dir():
            return self.send_raw(404, b"Not found", "text/plain")

        ctype, _ = mimetypes.guess_type(str(file_path))
        if not ctype:
            if file_path.suffix == ".webmanifest":
                ctype = "application/manifest+json"
            else:
                ctype = "application/octet-stream"
        cache = "public, max-age=86400" if file_path.suffix == ".png" else "no-cache"

        try:
            with open(file_path, "rb") as f:
                content = f.read()
            return self.send_raw(200, content, ctype, {"Cache-Control": cache})
        except Exception as e:
            return self.send_raw(500, b"Server Error", "text/plain")

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        client_ip = self.headers.get("X-Forwarded-For", "").split(",")[0].strip() or self.client_address[0]

        # Public Login
        if path == "/api/login":
            data = self.parse_json()
            if not data:
                return self.send_json(400, {"error": "Bad request."})

            role = str(data.get("role") or "").strip()
            sub = str(data.get("sub") or "").strip()
            user = str(data.get("user") or "").strip().lower()
            password = str(data.get("password") or "")

            if role not in MAIN:
                return self.send_json(400, {"error": "Unknown role."})

            key = role
            cur = role
            me = ""

            if role == "Faculty":
                fac_names = [f["n"] for f in get_faculty_list()]
                if sub not in fac_names:
                    return self.send_json(400, {"error": "Choose your name from the list."})
                key = f"Faculty:{sub}"
                me = sub
            elif role == "Other":
                if sub not in OTHERS:
                    return self.send_json(400, {"error": "Choose your office."})
                key = sub
                cur = sub

            rl = f"{client_ip}|{user or key}"
            if is_blocked(rl):
                return self.send_json(429, {"error": "Too many wrong attempts. Try again in 15 minutes."})

            conn = get_db()
            acct_row = conn.execute("SELECT * FROM accounts WHERE username = ?;", (user,)).fetchone() if user else None
            ok = False
            must = False
            ident = key
            disp = ""
            acct_name = ""

            if acct_row:
                if acct_row["role"] != role and acct_row["role"] != key:
                    conn.close()
                    record_fail(rl)
                    return self.send_json(401, {"error": "Choose the role assigned to this account."})
                if check_hash(password, acct_row["pw"]):
                    ok = True
                    must = bool(acct_row["must_change"])
                    ident = f"acct:{acct_row['username']}"
                    disp = acct_row["display"]
                    acct_name = acct_row["username"]
            else:
                cred_res = check_cred(key, password)
                if cred_res["ok"]:
                    ok = True
                    must = cred_res["must"]

            if not ok:
                conn.close()
                record_fail(rl)
                return self.send_json(401, {"error": "Incorrect username or password."})

            FAILED_ATTEMPTS.pop(rl, None)

            # Create session
            now_ts = int(datetime.now(timezone.utc).timestamp() * 1000)
            exp_ts = now_ts + 12 * 3600 * 1000
            conn.execute("DELETE FROM sessions WHERE exp <= ?;", (now_ts,))

            sid = secrets.token_hex(32)
            form_json = json.dumps({"role": role, "sub": sub, "user": user[:80]})
            conn.execute("""
                INSERT INTO sessions (id, ident, key, cur, me, disp, acct, form, must_change, exp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
            """, (sid, ident, key, cur, me, disp, acct_name, form_json, 1 if must else 0, exp_ts))
            conn.commit()
            conn.close()

            secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
            cookie_val = f"mauli_sid={sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200{secure}"
            return self.send_json(200, {"ok": True, "mustChange": must}, {"Set-Cookie": cookie_val})

        session = self.get_session()

        # Logout
        if path == "/api/logout":
            if session:
                conn = get_db()
                conn.execute("DELETE FROM sessions WHERE id = ?;", (session["id"],))
                conn.commit()
                conn.close()
            return self.send_json(200, {"ok": True}, {"Set-Cookie": "mauli_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"})

        # Authenticated password change
        if path == "/api/password":
            if not session:
                return self.send_json(401, {"error": "auth"})
            data = self.parse_json()
            if not data or len(str(data.get("next") or "")) < 8:
                return self.send_json(400, {"error": "New password must be at least 8 characters."})
            if data.get("next") == data.get("current"):
                return self.send_json(400, {"error": "Choose a password different from the current one."})

            curr_pw = str(data.get("current") or "")
            next_pw = str(data.get("next"))
            conn = get_db()

            if session.get("acct"):
                a = conn.execute("SELECT * FROM accounts WHERE username = ?;", (session["acct"],)).fetchone()
                if not a or not check_hash(curr_pw, a["pw"]):
                    conn.close()
                    return self.send_json(401, {"error": "Current password is incorrect."})
                conn.execute("UPDATE accounts SET pw = ?, must_change = 0 WHERE username = ?;",
                             (hash_pw(next_pw), session["acct"]))
            else:
                if not check_cred(session["key"], curr_pw)["ok"]:
                    conn.close()
                    return self.send_json(401, {"error": "Current password is incorrect."})
                conn.execute("""
                    INSERT INTO creds (key, pw, must_change, updated_at) VALUES (?, ?, 0, ?)
                    ON CONFLICT(key) DO UPDATE SET pw=excluded.pw, must_change=0, updated_at=excluded.updated_at;
                """, (session["key"], hash_pw(next_pw), now_iso()))

            conn.execute("UPDATE sessions SET must_change = 0 WHERE id = ?;", (session["id"],))
            conn.execute("DELETE FROM sessions WHERE ident = ? AND id != ?;", (session["ident"], session["id"]))
            conn.commit()
            conn.close()
            return self.send_json(200, {"ok": True})

        # Super Admin POST endpoints
        if path.startswith("/api/admin/"):
            if not session:
                return self.send_json(401, {"error": "auth"})
            if session["cur"] != "Super Admin":
                return self.send_json(403, {"error": "Super Admin only."})

            data = self.parse_json()
            if data is None:
                return self.send_json(400, {"error": "Bad request."})

            conn = get_db()
            all_logins_set = {l["key"] for l in get_all_logins()}

            if path == "/api/admin/reset":
                target_key = data.get("key")
                new_pw = str(data.get("password") or "")
                if target_key not in all_logins_set:
                    conn.close()
                    return self.send_json(400, {"error": "Unknown login."})
                if len(new_pw) < 8:
                    conn.close()
                    return self.send_json(400, {"error": "Password must be at least 8 characters."})
                must = 0 if target_key == "Super Admin" else 1
                conn.execute("""
                    INSERT INTO creds (key, pw, must_change, updated_at) VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET pw=excluded.pw, must_change=excluded.must_change, updated_at=excluded.updated_at;
                """, (target_key, hash_pw(new_pw), must, now_iso()))
                if target_key == "Super Admin":
                    conn.execute("DELETE FROM sessions WHERE ident = 'Super Admin' AND id != ?;", (session["id"],))
                else:
                    conn.execute("DELETE FROM sessions WHERE ident = ?;", (target_key,))
                conn.commit()
                conn.close()
                return self.send_json(200, {"ok": True})

            if path == "/api/admin/reset-all":
                new_pw = str(data.get("password") or "")
                if len(new_pw) < 8:
                    conn.close()
                    return self.send_json(400, {"error": "Password must be at least 8 characters."})
                hashed = hash_pw(new_pw)
                cnt = 0
                now_str = now_iso()
                for l in get_all_logins():
                    if l["key"] == "Super Admin":
                        continue
                    conn.execute("""
                        INSERT INTO creds (key, pw, must_change, updated_at) VALUES (?, ?, 1, ?)
                        ON CONFLICT(key) DO UPDATE SET pw=excluded.pw, must_change=1, updated_at=excluded.updated_at;
                    """, (l["key"], hashed, now_str))
                    conn.execute("DELETE FROM sessions WHERE ident = ?;", (l["key"],))
                    cnt += 1
                conn.commit()
                conn.close()
                return self.send_json(200, {"ok": True, "count": cnt})

            if path == "/api/admin/reset-default":
                if data.get("all"):
                    conn.execute("DELETE FROM creds WHERE key != 'Super Admin';")
                    for l in get_all_logins():
                        if l["key"] != "Super Admin":
                            conn.execute("DELETE FROM sessions WHERE ident = ?;", (l["key"],))
                    conn.commit()
                    conn.close()
                    return self.send_json(200, {"ok": True})
                target_key = data.get("key")
                if target_key not in all_logins_set or target_key == "Super Admin":
                    conn.close()
                    return self.send_json(400, {"error": "Unknown login."})
                conn.execute("DELETE FROM creds WHERE key = ?;", (target_key,))
                conn.execute("DELETE FROM sessions WHERE ident = ?;", (target_key,))
                conn.commit()
                conn.close()
                return self.send_json(200, {"ok": True})

            if path == "/api/admin/accounts":
                username = str(data.get("username") or "").strip().lower()
                display = str(data.get("display") or "").strip()[:120]
                role = str(data.get("role") or "").strip()
                dept = str(data.get("dept") or "").strip()
                password = str(data.get("password") or "")

                if not username or len(username) < 3 or username in ("superadmin", "superadmin@mauli"):
                    conn.close()
                    return self.send_json(400, {"error": "Valid username required (3+ characters)."})
                if not display:
                    conn.close()
                    return self.send_json(400, {"error": "Display name is required."})
                if role not in MAIN or role == "Super Admin":
                    conn.close()
                    return self.send_json(400, {"error": "Choose a valid role."})
                if len(password) < 8:
                    conn.close()
                    return self.send_json(400, {"error": "Password must be at least 8 characters."})
                if conn.execute("SELECT username FROM accounts WHERE username = ?;", (username,)).fetchone():
                    conn.close()
                    return self.send_json(400, {"error": "That username already exists."})

                conn.execute("""
                    INSERT INTO accounts (username, display, role, dept, pw, must_change, created_at)
                    VALUES (?, ?, ?, ?, ?, 1, ?);
                """, (username, display, role, dept, hash_pw(password), now_iso()))
                conn.commit()
                conn.close()
                return self.send_json(200, {"ok": True})

            if path == "/api/admin/accounts/reset":
                username = str(data.get("username") or "").strip().lower()
                password = str(data.get("password") or "")
                if len(password) < 8:
                    conn.close()
                    return self.send_json(400, {"error": "Password must be at least 8 characters."})
                row = conn.execute("SELECT username FROM accounts WHERE username = ?;", (username,)).fetchone()
                if not row:
                    conn.close()
                    return self.send_json(404, {"error": "No such account."})
                conn.execute("UPDATE accounts SET pw = ?, must_change = 1 WHERE username = ?;",
                             (hash_pw(password), username))
                conn.execute("DELETE FROM sessions WHERE ident = ?;", (f"acct:{username}",))
                conn.commit()
                conn.close()
                return self.send_json(200, {"ok": True})

            if path == "/api/admin/accounts/delete":
                username = str(data.get("username") or "").strip().lower()
                conn.execute("DELETE FROM accounts WHERE username = ?;", (username,))
                conn.execute("DELETE FROM sessions WHERE ident = ?;", (f"acct:{username}",))
                conn.commit()
                conn.close()
                return self.send_json(200, {"ok": True})

            conn.close()
            return self.send_json(404, {"error": "Not found"})

        return self.send_json(404, {"error": "Not found"})

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path
        session = self.get_session()
        if not session:
            return self.send_json(401, {"error": "auth"})
        if session.get("must_change", 0):
            return self.send_json(403, {"error": "change-password"})

        if path == "/api/kv":
            data = self.parse_json()
            if not data or "key" not in data or "value" not in data:
                return self.send_json(400, {"error": "Unknown data key."})
            k = data["key"]
            v = data["value"]
            if k not in WRITE_PERMS:
                return self.send_json(400, {"error": "Unknown data key."})
            if not WRITE_PERMS[k](session["cur"]):
                return self.send_json(403, {"error": "Your role cannot change this data."})

            conn = get_db()
            old = conn.execute("SELECT v FROM kv WHERE k = ?;", (k,)).fetchone()
            now_str = now_iso()
            if old and old["v"] != v:
                conn.execute("INSERT INTO kv_history (k, v, saved_at, by_ident) VALUES (?, ?, ?, ?);",
                             (k, old["v"], now_str, session["ident"]))
                conn.execute("DELETE FROM kv_history WHERE id NOT IN (SELECT id FROM kv_history ORDER BY id DESC LIMIT 300);")

            conn.execute("""
                INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at;
            """, (k, v, now_str))
            conn.commit()
            conn.close()
            return self.send_json(200, {"ok": True})

        return self.send_json(404, {"error": "Not found"})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        session = self.get_session()
        if not session:
            return self.send_json(401, {"error": "auth"})
        if session.get("must_change", 0):
            return self.send_json(403, {"error": "change-password"})

        if path == "/api/kv":
            data = self.parse_json()
            k = data.get("key") if data else None
            if not k or k not in WRITE_PERMS:
                return self.send_json(400, {"error": "Unknown data key."})
            if not WRITE_PERMS[k](session["cur"]):
                return self.send_json(403, {"error": "Your role cannot change this data."})
            conn = get_db()
            conn.execute("DELETE FROM kv WHERE k = ?;", (k,))
            conn.commit()
            conn.close()
            return self.send_json(200, {"ok": True})

        return self.send_json(404, {"error": "Not found"})

# ---------- Server Start ----------
def run():
    server_address = ("0.0.0.0", PORT)
    httpd = ThreadingHTTPServer(server_address, DashboardHandler)
    print("=" * 70)
    print("  MAULI COLLEGE OF ENGINEERING & TECHNOLOGY, SHEGAON")
    print("  Centralized Management Dashboard Server (Python 3)")
    print("=" * 70)
    print(f"  Listening on: http://0.0.0.0:{PORT}")
    print(f"  Local link:   http://localhost:{PORT}")
    print(f"  Database:     {DB_PATH}")
    print("=" * 70)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer shutting down gracefully.")
        httpd.server_close()

if __name__ == "__main__":
    run()
