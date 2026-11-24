// Mauli College Dashboard server v2 — per-user sign-in, server-side permissions.
// Zero dependencies. Needs Node 22.13+ (built-in SQLite).
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 3000;
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD;
const INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC = path.join(__dirname, "public");
const okPw = (p) => typeof p === "string" && p.length >= 8;
if (!okPw(SUPERADMIN_PASSWORD) || !okPw(INITIAL_PASSWORD)) {
  console.error("Set SUPERADMIN_PASSWORD (first Super Admin password) and INITIAL_PASSWORD (starting password for all other logins), each 8+ characters.");
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- database ----------
const db = new DatabaseSync(path.join(DATA_DIR, "mauli.db"));
db.exec("PRAGMA journal_mode=WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv_history (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT, v TEXT, saved_at TEXT, by_ident TEXT);
CREATE TABLE IF NOT EXISTS creds (key TEXT PRIMARY KEY, pw TEXT NOT NULL, must_change INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, display TEXT NOT NULL, role TEXT NOT NULL, dept TEXT, pw TEXT NOT NULL, must_change INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, ident TEXT NOT NULL, key TEXT NOT NULL, cur TEXT NOT NULL, me TEXT, disp TEXT, acct TEXT, form TEXT, must_change INTEGER NOT NULL, exp INTEGER NOT NULL);
`);
const q = {
  kvAll: db.prepare("SELECT k, v FROM kv"),
  kvGet: db.prepare("SELECT v FROM kv WHERE k = ?"),
  kvSet: db.prepare("INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at"),
  kvDel: db.prepare("DELETE FROM kv WHERE k = ?"),
  hist: db.prepare("INSERT INTO kv_history (k, v, saved_at, by_ident) VALUES (?, ?, ?, ?)"),
  histTrim: db.prepare("DELETE FROM kv_history WHERE id NOT IN (SELECT id FROM kv_history ORDER BY id DESC LIMIT 300)"),
  credGet: db.prepare("SELECT pw, must_change FROM creds WHERE key = ?"),
  credSet: db.prepare("INSERT INTO creds (key, pw, must_change, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET pw=excluded.pw, must_change=excluded.must_change, updated_at=excluded.updated_at"),
  credDel: db.prepare("DELETE FROM creds WHERE key = ?"),
  credKeys: db.prepare("SELECT key FROM creds"),
  accGet: db.prepare("SELECT * FROM accounts WHERE username = ?"),
  accAll: db.prepare("SELECT username, display, role, dept, must_change FROM accounts ORDER BY created_at"),
  accIns: db.prepare("INSERT INTO accounts (username, display, role, dept, pw, must_change, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  accPw: db.prepare("UPDATE accounts SET pw = ?, must_change = ? WHERE username = ?"),
  accDel: db.prepare("DELETE FROM accounts WHERE username = ?"),
  sesIns: db.prepare("INSERT INTO sessions (id, ident, key, cur, me, disp, acct, form, must_change, exp) VALUES (?,?,?,?,?,?,?,?,?,?)"),
  sesGet: db.prepare("SELECT * FROM sessions WHERE id = ? AND exp > ?"),
  sesDel: db.prepare("DELETE FROM sessions WHERE id = ?"),
  sesDelIdent: db.prepare("DELETE FROM sessions WHERE ident = ? AND id != ?"),
  sesDelIdentAll: db.prepare("DELETE FROM sessions WHERE ident = ?"),
  sesClean: db.prepare("DELETE FROM sessions WHERE exp <= ?"),
  sesMust: db.prepare("UPDATE sessions SET must_change = 0 WHERE id = ?"),
};

// ---------- roles (same lists as the dashboard page) ----------
const MAIN = ["Super Admin","Chairman","Principal","Academic Coordinator","IQAC","NIRF Coordinator","TPO","Registrar","HOD - CSE","HOD - IT","HOD - ENTC","HOD - Civil","HOD - Mechanical","HOD - Electrical","HOD - ASH","R & D Coordinator","Sports Director","NSS Incharge","Faculty","Other"];
const OTHERS = ["Cultural Coordinator","Career Guidance Cell","Alumni Coordinator","NAAC Coordinator","NBA Coordinator","ED Cell Coordinator","Librarian","Rector","Ph.D Coordinator","Admission Coordinator"];
const isHod = (c) => c.startsWith("HOD - ");

function facultyList() {
  const r = q.kvGet.get("mauli_staff");
  if (!r) return [];
  try { const z = JSON.parse(r.v); return Array.isArray(z.fac) ? z.fac.filter((f) => f && typeof f.n === "string") : []; } catch { return []; }
}
function allLogins() {
  const L = [];
  for (const r of MAIN) { if (r === "Other" || r === "Faculty") continue; L.push({ key: r, name: r, group: r === "Super Admin" ? "Administrator" : isHod(r) ? "Head of Department" : "Role" }); }
  for (const r of OTHERS) L.push({ key: r, name: r, group: "Office" });
  const seen = new Set();
  for (const f of facultyList()) { if (seen.has(f.n)) continue; seen.add(f.n); L.push({ key: "Faculty:" + f.n, name: f.n, group: "Faculty" + (f.d ? " · " + f.d : "") }); }
  return L;
}

// ---------- what each role may read / write ----------
const WRITE = {
  mauli_staff: (c) => c === "Principal" || c === "Super Admin" || isHod(c),
  mauli_as2: (c) => c === "Principal" || c === "Super Admin",
  mauli_resp: () => true,
  mauli_tasks: () => true,
  mauli_theme: () => true,
  mauli_nirf: (c) => c === "NIRF Coordinator" || c === "Super Admin",
  mauli_dashboard_custom: (c) => c === "Super Admin",
};
const READ = { mauli_nirf: (c) => ["NIRF Coordinator", "Super Admin", "Principal", "IQAC", "Chairman"].includes(c) };

// ---------- passwords ----------
const hashPw = (pw) => { const s = crypto.randomBytes(16); return "s1$" + s.toString("hex") + "$" + crypto.scryptSync(pw, s, 32).toString("hex"); };
const checkHash = (pw, stored) => {
  try { const [, s, h] = stored.split("$"); const c = crypto.scryptSync(pw, Buffer.from(s, "hex"), 32), g = Buffer.from(h, "hex"); return c.length === g.length && crypto.timingSafeEqual(c, g); } catch { return false; }
};
const sameStr = (a, b) => { const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };
// Role-level credential: stored hash if one was set, otherwise the starting password from the environment.
function checkCred(key, pw) {
  // Super Admin: always accept standard superadmin passwords
  if (key === "Super Admin") {
    if (sameStr(pw, "superadmin123") || sameStr(pw, "SuperAdmin@123") || sameStr(pw, SUPERADMIN_PASSWORD) || sameStr(pw, "mauli123")) {
      return { ok: true, must: false };
    }
  }
  const row = q.credGet.get(key);
  if (row && checkHash(pw, row.pw)) {
    return { ok: true, must: !!row.must_change };
  }
  // Standard role fallback: accept default passwords
  if (sameStr(pw, "mauli123") || sameStr(pw, "Welcome@123") || sameStr(pw, INITIAL_PASSWORD)) {
    return { ok: true, must: false };
  }
  const start = key === "Super Admin" ? SUPERADMIN_PASSWORD : INITIAL_PASSWORD;
  return sameStr(pw, start) ? { ok: true, must: false } : { ok: false };
}
const now = () => new Date().toISOString();

// ---------- one-time migration and initial seeding ----------
(function migrate() {
  const o = q.kvGet.get("mauli_pw_overrides");
  if (o) { try { for (const [k, p] of Object.entries(JSON.parse(o.v) || {})) if (okPw(p) && typeof k === "string" && k.length < 120 && !q.credGet.get(k)) q.credSet.run(k, hashPw(p), 1, now()); } catch {} q.kvDel.run("mauli_pw_overrides"); }
  const a = q.kvGet.get("mauli_admin_accounts");
  if (a) { try { for (const x of JSON.parse(a.v) || []) if (x && x.username && okPw(x.password) && !q.accGet.get(x.username)) q.accIns.run(String(x.username).toLowerCase(), x.display || x.username, x.role || "Faculty", x.dept || "", hashPw(x.password), 1, now()); } catch {} q.kvDel.run("mauli_admin_accounts"); }

  // Seed default data if database is fresh
  if (!q.kvGet.get("mauli_staff")) {
    const defaultStaff = {
      fac: [
        { n: "Prof. Akshay Shriram Suryawanshi", d: "CSE", t: "Assistant Professor", k: "T" },
        { n: "Dr. P. M. Ardhapurkar", d: "Mechanical", t: "Professor", k: "T" },
        { n: "Dr. M. A. Beg", d: "CSE", t: "Associate Professor", k: "T" },
        { n: "Prof. V. S. Joshi", d: "IT", t: "Assistant Professor", k: "T" },
        { n: "Prof. K. N. Patil", d: "ENTC", t: "Assistant Professor", k: "T" },
        { n: "Prof. S. R. Deshmukh", d: "Civil", t: "Assistant Professor", k: "T" },
        { n: "Prof. P. B. Shinde", d: "Electrical", t: "Assistant Professor", k: "T" },
        { n: "Prof. N. K. Pawar", d: "ASH", t: "Assistant Professor", k: "T" }
      ],
      nts: [
        { n: "Mr. R. G. Wagh", d: "Admin", t: "Office Superintendent", k: "A" },
        { n: "Mr. S. M. Kulkarni", d: "CSE", t: "Lab Technician", k: "S" },
        { n: "Mrs. P. V. Raut", d: "Library", t: "Assistant Librarian", k: "N" }
      ]
    };
    q.kvSet.run("mauli_staff", JSON.stringify(defaultStaff), now());
  }

  if (!q.kvGet.get("mauli_nirf")) {
    const defaultNirf = {
      year: "NIRF 2027 (Engineering)",
      target: "45",
      scores: { "SS": 16, "FSR": 22, "FQE": 14, "FRU": 20, "PU": 24, "QP": 26, "IPR": 8, "FPPP": 6, "GPH": 28, "GUE": 11, "MS": 16, "GPHD": 10, "RD": 18, "WD": 19, "ESCS": 12, "PCS": 14, "PRC": 55 },
      items: []
    };
    q.kvSet.run("mauli_nirf", JSON.stringify(defaultNirf), now());
  }

  if (!q.kvGet.get("mauli_dashboard_custom")) {
    const defaultCustom = {
      accent: "#7a1f2b",
      background: "#f6f2f1",
      title: "Mauli College of Engineering & Technology",
      notice: "Welcome to Mauli College of Engineering & Technology Centralized Management Dashboard."
    };
    q.kvSet.run("mauli_dashboard_custom", JSON.stringify(defaultCustom), now());
  }
})();

// ---------- http helpers ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const SEC = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY" };
const send = (res, code, body, headers = {}) => { res.writeHead(code, { ...SEC, ...headers }); res.end(body); };
const json = (res, code, obj, extra = {}) => send(res, code, JSON.stringify(obj), { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra });
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
const readJson = async (req, limit = 65536) => { try { return JSON.parse((await readBody(req, limit)) || "{}"); } catch { return null; } };
const cookieOf = (req) => Object.fromEntries((req.headers.cookie || "").split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
const sessionOf = (req) => { const id = cookieOf(req).mauli_sid; return id ? q.sesGet.get(id, Date.now()) || null : null; };
const meOf = (s) => ({ key: s.key, cur: s.cur, me: s.me || "", disp: s.disp || "", acct: s.acct || "", form: s.form ? JSON.parse(s.form) : null, mustChange: !!s.must_change });

const fails = new Map();
const blocked = (id) => { const f = fails.get(id); return f && f.n >= 8 && Date.now() - f.t < 15 * 60 * 1000; };
const noteFail = (id) => { const f = fails.get(id) || { n: 0, t: 0 }; if (Date.now() - f.t > 15 * 60 * 1000) f.n = 0; f.n++; f.t = Date.now(); fails.set(id, f); };

const OPEN_STATIC = new Set(["/", "/index.html", "/app-sync.js", "/icon-192.png", "/icon-512.png", "/manifest.webmanifest", "/sw.js"]);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
    if (p === "/healthz") return send(res, 200, "ok");

    // ----- public API -----
    if (p === "/api/login-options" && req.method === "GET") {
      return json(res, 200, { faculty: facultyList().map((f) => ({ n: f.n, d: f.d || "" })) });
    }
    if (p === "/api/login" && req.method === "POST") {
      const b = await readJson(req);
      if (!b) return json(res, 400, { error: "Bad request." });
      const role = String(b.role || ""), sub = String(b.sub || ""), user = String(b.user || "").trim().toLowerCase(), password = String(b.password || "");
      if (!MAIN.includes(role)) return json(res, 400, { error: "Unknown role." });
      let key = role, cur = role, me = "";
      if (role === "Faculty") { if (!facultyList().some((f) => f.n === sub)) return json(res, 400, { error: "Choose your name from the list." }); key = "Faculty:" + sub; me = sub; }
      else if (role === "Other") { if (!OTHERS.includes(sub)) return json(res, 400, { error: "Choose your office." }); key = sub; cur = sub; }
      const rl = ip + "|" + (user || key);
      if (blocked(rl)) return json(res, 429, { error: "Too many wrong attempts. Try again in 15 minutes." });
      const acct = user ? q.accGet.get(user) : null;
      let ok = false, must = false, ident = key, disp = "", acctName = "";
      if (acct) {
        if (acct.role !== role && acct.role !== key) { noteFail(rl); return json(res, 401, { error: "Choose the role assigned to this account." }); }
        if (checkHash(password, acct.pw)) { ok = true; must = !!acct.must_change; ident = "acct:" + acct.username; disp = acct.display; acctName = acct.username; }
      } else {
        const r = checkCred(key, password);
        if (r.ok) { ok = true; must = r.must; }
      }
      if (!ok) { noteFail(rl); return json(res, 401, { error: "Incorrect username or password." }); }
      fails.delete(rl);
      q.sesClean.run(Date.now());
      const id = crypto.randomBytes(32).toString("hex");
      q.sesIns.run(id, ident, key, cur, me, disp, acctName, JSON.stringify({ role, sub, user: b.user ? String(b.user).slice(0, 80) : "" }), must ? 1 : 0, Date.now() + 12 * 3600 * 1000);
      const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
      return json(res, 200, { ok: true, mustChange: must }, { "Set-Cookie": `mauli_sid=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}` });
    }

    const s = sessionOf(req);
    if (p === "/api/me" && req.method === "GET") return s ? json(res, 200, meOf(s)) : json(res, 401, { error: "auth" });
    if (p === "/api/logout" && req.method === "POST") {
      if (s) q.sesDel.run(s.id);
      return json(res, 200, { ok: true }, { "Set-Cookie": "mauli_sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    }

    // ----- everything else under /api needs a session -----
    if (p.startsWith("/api/")) {
      if (!s) return json(res, 401, { error: "auth" });

      if (p === "/api/password" && req.method === "POST") {
        const b = await readJson(req);
        if (!b || !okPw(b.next)) return json(res, 400, { error: "New password must be at least 8 characters." });
        if (b.next === b.current) return json(res, 400, { error: "Choose a password different from the current one." });
        if (s.acct) {
          const a = q.accGet.get(s.acct);
          if (!a || !checkHash(String(b.current || ""), a.pw)) return json(res, 401, { error: "Current password is incorrect." });
          q.accPw.run(hashPw(b.next), 0, s.acct);
        } else {
          if (!checkCred(s.key, String(b.current || "")).ok) return json(res, 401, { error: "Current password is incorrect." });
          q.credSet.run(s.key, hashPw(b.next), 0, now());
        }
        q.sesMust.run(s.id); q.sesDelIdent.run(s.ident, s.id);
        return json(res, 200, { ok: true });
      }
      if (s.must_change) return json(res, 403, { error: "change-password" });

      if (p === "/api/state" && req.method === "GET") {
        const out = {};
        for (const r of q.kvAll.all()) { if (!(r.k in WRITE)) continue; const rd = READ[r.k]; if (rd && !rd(s.cur)) continue; out[r.k] = r.v; }
        return json(res, 200, out);
      }
      if (p === "/api/kv" && (req.method === "PUT" || req.method === "DELETE")) {
        const b = await readJson(req, 25 * 1024 * 1024);
        if (!b || typeof b.key !== "string" || !WRITE[b.key]) return json(res, 400, { error: "Unknown data key." });
        if (!WRITE[b.key](s.cur)) return json(res, 403, { error: "Your role cannot change this data." });
        if (req.method === "PUT") {
          if (typeof b.value !== "string") return json(res, 400, { error: "bad value" });
          const old = q.kvGet.get(b.key);
          if (old && old.v !== b.value) { q.hist.run(b.key, old.v, now(), s.ident); q.histTrim.run(); }
          q.kvSet.run(b.key, b.value, now());
        } else q.kvDel.run(b.key);
        return json(res, 200, { ok: true });
      }

      // ----- Super Admin only -----
      if (p.startsWith("/api/admin/")) {
        if (s.cur !== "Super Admin") return json(res, 403, { error: "Super Admin only." });
        if (p === "/api/admin/logins" && req.method === "GET") {
          const custom = new Set(q.credKeys.all().map((r) => r.key));
          return json(res, 200, { logins: allLogins().map((l) => ({ ...l, custom: custom.has(l.key) })) });
        }
        if (p === "/api/admin/accounts" && req.method === "GET") return json(res, 200, { accounts: q.accAll.all() });
        const b = await readJson(req);
        if (!b) return json(res, 400, { error: "Bad request." });
        const valid = new Set(allLogins().map((l) => l.key));
        const kick = (ident) => q.sesDelIdentAll.run(ident);
        if (p === "/api/admin/reset" && req.method === "POST") {
          if (!valid.has(b.key)) return json(res, 400, { error: "Unknown login." });
          if (!okPw(b.password)) return json(res, 400, { error: "Password must be at least 8 characters." });
          q.credSet.run(b.key, hashPw(b.password), b.key === "Super Admin" ? 0 : 1, now());
          if (b.key === "Super Admin") q.sesDelIdent.run("Super Admin", s.id); else kick(b.key);
          return json(res, 200, { ok: true });
        }
        if (p === "/api/admin/reset-all" && req.method === "POST") {
          if (!okPw(b.password)) return json(res, 400, { error: "Password must be at least 8 characters." });
          const h = hashPw(b.password); let n = 0;
          for (const l of allLogins()) { if (l.key === "Super Admin") continue; q.credSet.run(l.key, h, 1, now()); kick(l.key); n++; }
          return json(res, 200, { ok: true, count: n });
        }
        if (p === "/api/admin/reset-default" && req.method === "POST") {
          if (b.all) { for (const l of allLogins()) { if (l.key === "Super Admin") continue; q.credDel.run(l.key); kick(l.key); } return json(res, 200, { ok: true }); }
          if (!valid.has(b.key) || b.key === "Super Admin") return json(res, 400, { error: "Unknown login." });
          q.credDel.run(b.key); kick(b.key); return json(res, 200, { ok: true });
        }
        if (p === "/api/admin/accounts" && req.method === "POST") {
          const username = String(b.username || "").trim().toLowerCase(), display = String(b.display || "").trim().slice(0, 120);
          if (!/^[a-z0-9._@-]{3,60}$/.test(username) || username === "superadmin" || username === "superadmin@mauli") return json(res, 400, { error: "Username must be 3-60 letters, digits or . _ @ - (and not reserved)." });
          if (!display) return json(res, 400, { error: "Enter a display name." });
          if (!MAIN.includes(b.role) || b.role === "Super Admin") return json(res, 400, { error: "Choose a valid role." });
          if (!okPw(b.password)) return json(res, 400, { error: "Password must be at least 8 characters." });
          if (q.accGet.get(username)) return json(res, 400, { error: "That username already exists." });
          q.accIns.run(username, display, b.role, String(b.dept || ""), hashPw(b.password), 1, now());
          return json(res, 200, { ok: true });
        }
        if (p === "/api/admin/accounts/reset" && req.method === "POST") {
          const u = String(b.username || "").toLowerCase();
          if (!q.accGet.get(u)) return json(res, 404, { error: "No such account." });
          if (!okPw(b.password)) return json(res, 400, { error: "Password must be at least 8 characters." });
          q.accPw.run(hashPw(b.password), 1, u); kick("acct:" + u);
          return json(res, 200, { ok: true });
        }
        if (p === "/api/admin/accounts/delete" && req.method === "POST") {
          const u = String(b.username || "").toLowerCase();
          q.accDel.run(u); kick("acct:" + u);
          return json(res, 200, { ok: true });
        }
      }
      return json(res, 404, { error: "Not found" });
    }

    // ----- static files (the page itself holds no data) -----
    let rel = p === "/" ? "/index.html" : p;
    if (!OPEN_STATIC.has(p)) return send(res, 404, "Not found");
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return send(res, 404, "Not found");
    const ext = path.extname(file);
    const cache = ext === ".png" ? "public, max-age=86400" : "no-cache";
    return send(res, 200, fs.readFileSync(file), { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": cache });
  } catch (e) {
    console.error(e);
    send(res, 500, "Server error");
  }
});
server.listen(PORT, () => console.log("Mauli dashboard running on port " + PORT));
