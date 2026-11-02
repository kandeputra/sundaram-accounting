"use strict";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const { pool, migrate } = require("./db"); // also loads .env

/* ---------- configuration ---------- */
const ROOT = path.join(__dirname, "..");
const BOOKS = JSON.parse(fs.readFileSync(path.join(__dirname, "books.json"), "utf8"));
const BOOK_IDS = new Set(BOOKS.map((b) => b.id));
const COLLS = new Set(["accounts", "transactions", "invoices", "bookings", "settings"]);
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const USER_RE = /^[a-z0-9._-]{3,60}$/;
const ROLES = new Set(["admin", "editor", "viewer"]);
const MAX_DOC = 256 * 1024;

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const SECRET = process.env.SESSION_SECRET || "";
const SETUP_TOKEN = (process.env.SETUP_TOKEN || "").trim();
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 14;
const DEFAULT_BOOK = (process.env.DEFAULT_BOOK || "").trim();
const BASE = (process.env.BASE_PATH || "").trim().replace(/\/+$/, "").replace(/^(?!\/)(.)/, "/$1");
const COOKIE = "pembukuan_sesi";

if (SECRET.length < 32) {
  console.error("SESSION_SECRET di file server/.env wajib diisi, minimal 32 karakter acak.");
  console.error("Buat dengan: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  process.exit(1);
}

/* ---------- helpers ---------- */
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, status, msg) => res.status(status).json({ error: msg });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
function verify(tok) {
  if (typeof tok !== "string") return null;
  const [body, sig] = tok.split(".");
  if (!body || !sig) return null;
  const want = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p && p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}
function safeEqual(x, y) {
  const a = crypto.createHash("sha256").update(String(x)).digest();
  const b = crypto.createHash("sha256").update(String(y)).digest();
  return crypto.timingSafeEqual(a, b);
}
function readCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  }
  return out;
}
function secure(req) {
  const v = (process.env.COOKIE_SECURE || "auto").toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return req.secure;
}
function setSession(req, res, user) {
  const tok = sign({ uid: user.id, tv: user.token_version, exp: Date.now() + SESSION_DAYS * 864e5 });
  res.setHeader("Set-Cookie",
    `${COOKIE}=${tok}; Path=${BASE || "/"}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure(req) ? "; Secure" : ""}`);
}
function clearSession(req, res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=${BASE || "/"}; HttpOnly; SameSite=Lax; Max-Age=0${secure(req) ? "; Secure" : ""}`);
}
function publicUser(u) {
  return {
    id: u.id, username: u.username, name: u.name, role: u.role,
    books: u.books === "*" ? "*" : u.books.split(",").filter(Boolean),
    active: !!u.active, last_login: u.last_login || null, created_at: u.created_at || undefined,
  };
}
const canBook = (u, b) => u.books === "*" || u.books.split(",").includes(b);
function parseBooks(v) {
  if (v === "*") return "*";
  if (!Array.isArray(v) || !v.length) return null;
  const uniq = [...new Set(v)];
  if (!uniq.every((b) => BOOK_IDS.has(b))) return null;
  return uniq.join(",");
}
function summary(coll, d) {
  if (!isObj(d)) return "";
  let s = "";
  if (coll === "transactions") s = [d.no, d.desc].filter(Boolean).join(" · ");
  else if (coll === "invoices") s = [d.no, d.customer].filter(Boolean).join(" · ");
  else if (coll === "accounts") s = [d.code, d.name].filter(Boolean).join(" ");
  else if (coll === "bookings") s = [d.no, d.guest].filter(Boolean).join(" · ");
  else if (coll === "settings") s = "Pengaturan";
  return String(s).slice(0, 250);
}
async function bumpRev(conn, book) {
  await conn.query("INSERT INTO books (id, rev) VALUES (?, 1) ON DUPLICATE KEY UPDATE rev = rev + 1", [book]);
}
async function audit(conn, book, user, action, coll, docId, sum) {
  await conn.query(
    "INSERT INTO audit_log (book, user_id, username, action, coll, doc_id, summary) VALUES (?,?,?,?,?,?,?)",
    [book, user.id, user.username, action, coll || "", String(docId || "").slice(0, 200), sum || ""]);
}
async function activeAdmins() {
  const [r] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1");
  return Number(r[0].n);
}
async function userCount() {
  const [r] = await pool.query("SELECT COUNT(*) AS n FROM users");
  return Number(r[0].n);
}

/* login throttling: 10 failed tries per IP per 15 minutes */
const fails = new Map();
function tooMany(ip) {
  const now = Date.now();
  const list = (fails.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  if (list.length) fails.set(ip, list); else fails.delete(ip);
  return list.length >= 10;
}
function noteFail(ip) {
  const list = fails.get(ip) || [];
  list.push(Date.now());
  fails.set(ip, list);
}
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", 10);

/* ---------- middleware ---------- */
async function auth(req, res, next) {
  try {
    const p = verify(readCookies(req)[COOKIE]);
    if (!p) return bad(res, 401, "Silakan masuk dulu.");
    const [rows] = await pool.query(
      "SELECT id, username, name, role, books, active, token_version, last_login FROM users WHERE id=?", [p.uid]);
    const u = rows[0];
    if (!u || !u.active || u.token_version !== p.tv) return bad(res, 401, "Sesi berakhir. Silakan masuk lagi.");
    req.user = u;
    next();
  } catch (e) { next(e); }
}
function book(req, res, next) {
  const b = req.params.book;
  if (!BOOK_IDS.has(b)) return bad(res, 404, "Buku tidak ditemukan.");
  if (!canBook(req.user, b)) return bad(res, 403, "Akun Anda tidak punya akses ke buku ini.");
  next();
}
function writer(req, res, next) {
  if (req.user.role !== "admin" && req.user.role !== "editor") return bad(res, 403, "Akun Anda hanya bisa melihat data.");
  next();
}
function admin(req, res, next) {
  if (req.user.role !== "admin") return bad(res, 403, "Hanya admin yang bisa melakukan ini.");
  next();
}

/* ---------- app ---------- */
const app = express();
app.disable("x-powered-by");
const tp = process.env.TRUST_PROXY;
app.set("trust proxy", tp === undefined || tp === "" ? 1 : /^\d+$/.test(tp) ? Number(tp) : tp === "true" ? true : tp === "false" ? false : tp);

const r = express.Router();
r.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  next();
});

/* API */
const api = express.Router();
api.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("X-Requested-With") !== "pembukuan")
    return bad(res, 403, "Permintaan ditolak.");
  next();
});
api.use("/books/:book/import", express.json({ limit: "25mb" }));
api.use(express.json({ limit: "1mb" }));

api.get("/health", h(async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
}));

api.get("/setup", h(async (req, res) => {
  res.json({ needed: (await userCount()) === 0, configured: !!SETUP_TOKEN });
}));

api.post("/setup", h(async (req, res) => {
  if ((await userCount()) > 0) return bad(res, 403, "Admin sudah ada. Silakan masuk.");
  if (!SETUP_TOKEN) return bad(res, 403, "SETUP_TOKEN belum diisi di file .env server.");
  const { token, username, name, password } = req.body || {};
  if (tooMany(req.ip)) return bad(res, 429, "Terlalu banyak percobaan. Coba lagi 15 menit lagi.");
  if (!safeEqual(String(token || "").trim(), SETUP_TOKEN)) { noteFail(req.ip); return bad(res, 403, "Kode setup salah."); }
  const un = String(username || "").trim().toLowerCase();
  if (!USER_RE.test(un)) return bad(res, 400, "Username hanya huruf kecil, angka, titik, garis bawah, atau tanda hubung (3–60 karakter).");
  if (typeof password !== "string" || password.length < 8) return bad(res, 400, "Password minimal 8 karakter.");
  const hash = await bcrypt.hash(password, 12);
  const [ins] = await pool.query(
    "INSERT INTO users (username, name, password_hash, role, books, last_login) VALUES (?, ?, ?, 'admin', '*', NOW())",
    [un, String(name || "").trim().slice(0, 120) || un, hash]);
  const [rows] = await pool.query("SELECT * FROM users WHERE id=?", [ins.insertId]);
  setSession(req, res, rows[0]);
  res.json({ user: publicUser(rows[0]) });
}));

api.post("/login", h(async (req, res) => {
  if (tooMany(req.ip)) return bad(res, 429, "Terlalu banyak percobaan gagal. Coba lagi 15 menit lagi.");
  const { username, password } = req.body || {};
  const un = String(username || "").trim().toLowerCase();
  const [rows] = await pool.query("SELECT * FROM users WHERE username=?", [un]);
  const u = rows[0];
  const ok = await bcrypt.compare(String(password || ""), u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) { noteFail(req.ip); return bad(res, 401, "Username atau password salah."); }
  if (!u.active) return bad(res, 403, "Akun Anda dinonaktifkan. Hubungi admin.");
  await pool.query("UPDATE users SET last_login=NOW() WHERE id=?", [u.id]);
  fails.delete(req.ip);
  setSession(req, res, u);
  res.json({ user: publicUser(u) });
}));

api.post("/logout", (req, res) => { clearSession(req, res); res.json({ ok: true }); });

api.use(auth);

api.get("/me", (req, res) => {
  res.json({ user: publicUser(req.user), books: BOOKS.filter((b) => canBook(req.user, b.id)).map(({ id, name, path: p }) => ({ id, name, path: BASE + p + "/" })) });
});

api.post("/me/password", h(async (req, res) => {
  const { current, password } = req.body || {};
  if (typeof password !== "string" || password.length < 8) return bad(res, 400, "Password baru minimal 8 karakter.");
  const [rows] = await pool.query("SELECT * FROM users WHERE id=?", [req.user.id]);
  if (!(await bcrypt.compare(String(current || ""), rows[0].password_hash))) return bad(res, 400, "Password lama salah.");
  const hash = await bcrypt.hash(password, 12);
  await pool.query("UPDATE users SET password_hash=?, token_version=token_version+1 WHERE id=?", [hash, req.user.id]);
  const [fresh] = await pool.query("SELECT * FROM users WHERE id=?", [req.user.id]);
  setSession(req, res, fresh[0]);
  res.json({ ok: true });
}));

/* books & documents */
api.get("/books/:book/rev", book, h(async (req, res) => {
  const [r1] = await pool.query("SELECT rev FROM books WHERE id=?", [req.params.book]);
  res.json({ rev: r1.length ? Number(r1[0].rev) : 0 });
}));

api.get("/books/:book/data", book, h(async (req, res) => {
  const b = req.params.book;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [docs] = await conn.query("SELECT coll, doc_id, data FROM documents WHERE book=?", [b]);
    const [r1] = await conn.query("SELECT rev FROM books WHERE id=?", [b]);
    await conn.commit();
    const out = { accounts: [], transactions: [], invoices: [], bookings: [], settings: {}, rev: r1.length ? Number(r1[0].rev) : 0 };
    for (const d of docs) {
      let v;
      try { v = JSON.parse(d.data); } catch { continue; }
      if (d.coll === "settings") out.settings[d.doc_id] = v;
      else if (out[d.coll]) { v.id = d.doc_id; out[d.coll].push(v); }
    }
    res.json(out);
  } finally { conn.release(); }
}));

api.put("/books/:book/docs/:coll/:id", book, writer, h(async (req, res) => {
  const { book: b, coll, id } = req.params;
  if (!COLLS.has(coll)) return bad(res, 400, "Jenis data tidak dikenal.");
  if (!ID_RE.test(id)) return bad(res, 400, "ID data tidak valid.");
  const data = req.body && req.body.data;
  if (!isObj(data)) return bad(res, 400, "Isi data harus berupa objek.");
  delete data.id;
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json) > MAX_DOC) return bad(res, 413, "Data terlalu besar (maks. 256 KB per catatan).");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [ins] = await conn.query(
      `INSERT INTO documents (book, coll, doc_id, data, updated_at, updated_by) VALUES (?, ?, ?, ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE data=VALUES(data), updated_at=VALUES(updated_at), updated_by=VALUES(updated_by)`,
      [b, coll, id, json, req.user.id]);
    await bumpRev(conn, b);
    await audit(conn, b, req.user, ins.affectedRows === 1 ? "create" : "update", coll, id, summary(coll, data));
    await conn.commit();
    res.json({ ok: true });
  } catch (e) { await conn.rollback().catch(() => {}); throw e; } finally { conn.release(); }
}));

api.delete("/books/:book/docs/:coll/:id", book, writer, h(async (req, res) => {
  const { book: b, coll, id } = req.params;
  if (!COLLS.has(coll) || !ID_RE.test(id)) return bad(res, 400, "Data tidak valid.");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [old] = await conn.query("SELECT data FROM documents WHERE book=? AND coll=? AND doc_id=? FOR UPDATE", [b, coll, id]);
    if (old.length) {
      await conn.query("DELETE FROM documents WHERE book=? AND coll=? AND doc_id=?", [b, coll, id]);
      let d = null; try { d = JSON.parse(old[0].data); } catch { /* ignore */ }
      await bumpRev(conn, b);
      await audit(conn, b, req.user, "delete", coll, id, summary(coll, d));
    }
    await conn.commit();
    res.json({ ok: true });
  } catch (e) { await conn.rollback().catch(() => {}); throw e; } finally { conn.release(); }
}));

api.get("/books/:book/export", book, admin, h(async (req, res) => {
  const b = req.params.book;
  const [docs] = await pool.query("SELECT coll, doc_id, data FROM documents WHERE book=?", [b]);
  const out = { format: "pembukuan-backup", version: 1, book: b, exportedAt: new Date().toISOString(), accounts: [], transactions: [], invoices: [], bookings: [], settings: {} };
  for (const d of docs) {
    let v; try { v = JSON.parse(d.data); } catch { continue; }
    if (d.coll === "settings") out.settings[d.doc_id] = v; else if (out[d.coll]) { v.id = d.doc_id; out[d.coll].push(v); }
  }
  res.set("Content-Disposition", `attachment; filename="backup-${b}-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(out);
}));

api.post("/books/:book/import", book, admin, h(async (req, res) => {
  const b = req.params.book;
  const body = req.body || {};
  const mode = body.mode === "merge" ? "merge" : "replace";
  const rows = [];
  for (const coll of ["accounts", "transactions", "invoices", "bookings"]) {
    const list = body[coll] === undefined ? [] : body[coll];
    if (!Array.isArray(list)) return bad(res, 400, `Bagian ${coll} di file backup tidak valid.`);
    for (const item of list) {
      if (!isObj(item) || !ID_RE.test(String(item.id || ""))) return bad(res, 400, `Ada catatan ${coll} tanpa ID yang valid.`);
      const { id, ...rest } = item;
      const json = JSON.stringify(rest);
      if (Buffer.byteLength(json) > MAX_DOC) return bad(res, 413, `Catatan ${coll} ${id} terlalu besar.`);
      rows.push([b, coll, String(id), json, req.user.id]);
    }
  }
  if (isObj(body.settings)) {
    for (const [k, v] of Object.entries(body.settings)) {
      if (ID_RE.test(k) && isObj(v)) rows.push([b, "settings", k, JSON.stringify(v), req.user.id]);
    }
  }
  if (rows.length > 20000) return bad(res, 413, "File backup terlalu besar (maks. 20.000 catatan).");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (mode === "replace") await conn.query("DELETE FROM documents WHERE book=?", [b]);
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await conn.query(
        `INSERT INTO documents (book, coll, doc_id, data, updated_at, updated_by) VALUES ${chunk.map(() => "(?, ?, ?, ?, NOW(), ?)").join(",")}
         ON DUPLICATE KEY UPDATE data=VALUES(data), updated_at=VALUES(updated_at), updated_by=VALUES(updated_by)`,
        chunk.flat());
    }
    await bumpRev(conn, b);
    await audit(conn, b, req.user, "import", "", "", `${mode === "replace" ? "Ganti" : "Gabung"} ${rows.length} catatan dari backup`);
    await conn.commit();
    res.json({ ok: true, count: rows.length });
  } catch (e) { await conn.rollback().catch(() => {}); throw e; } finally { conn.release(); }
}));

api.get("/books/:book/audit", book, admin, h(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const [rows] = await pool.query(
    "SELECT at, username, action, coll, doc_id, summary FROM audit_log WHERE book=? ORDER BY id DESC LIMIT ?", [req.params.book, limit]);
  res.json({ items: rows });
}));

/* users (admin) */
api.get("/users", admin, h(async (req, res) => {
  const [rows] = await pool.query("SELECT id, username, name, role, books, active, last_login, created_at FROM users ORDER BY username");
  res.json({ users: rows.map(publicUser), books: BOOKS.map(({ id, name }) => ({ id, name })) });
}));

api.post("/users", admin, h(async (req, res) => {
  const { username, name, role, books, password } = req.body || {};
  const un = String(username || "").trim().toLowerCase();
  if (!USER_RE.test(un)) return bad(res, 400, "Username hanya huruf kecil, angka, titik, garis bawah, atau tanda hubung (3–60 karakter).");
  if (!ROLES.has(role)) return bad(res, 400, "Peran tidak dikenal.");
  const bk = parseBooks(books);
  if (!bk) return bad(res, 400, "Pilih minimal satu buku yang bisa diakses.");
  if (typeof password !== "string" || password.length < 8) return bad(res, 400, "Password minimal 8 karakter.");
  const [dup] = await pool.query("SELECT id FROM users WHERE username=?", [un]);
  if (dup.length) return bad(res, 409, `Username ${un} sudah dipakai.`);
  const hash = await bcrypt.hash(password, 12);
  const [ins] = await pool.query("INSERT INTO users (username, name, password_hash, role, books) VALUES (?, ?, ?, ?, ?)",
    [un, String(name || "").trim().slice(0, 120), hash, role, bk]);
  res.json({ id: ins.insertId });
}));

api.patch("/users/:id", admin, h(async (req, res) => {
  const id = Number(req.params.id);
  const [rows] = await pool.query("SELECT * FROM users WHERE id=?", [id]);
  const u = rows[0];
  if (!u) return bad(res, 404, "Pengguna tidak ditemukan.");
  const b = req.body || {};
  const sets = [], vals = [];
  let bump = false;
  if (b.name !== undefined) { sets.push("name=?"); vals.push(String(b.name).trim().slice(0, 120)); }
  if (b.role !== undefined) {
    if (!ROLES.has(b.role)) return bad(res, 400, "Peran tidak dikenal.");
    sets.push("role=?"); vals.push(b.role);
  }
  if (b.books !== undefined) {
    const bk = parseBooks(b.books);
    if (!bk) return bad(res, 400, "Pilih minimal satu buku yang bisa diakses.");
    sets.push("books=?"); vals.push(bk);
  }
  if (b.active !== undefined) {
    if (id === req.user.id && !b.active) return bad(res, 400, "Anda tidak bisa menonaktifkan akun sendiri.");
    sets.push("active=?"); vals.push(b.active ? 1 : 0); if (!b.active) bump = true;
  }
  if (b.password !== undefined && b.password !== "") {
    if (typeof b.password !== "string" || b.password.length < 8) return bad(res, 400, "Password minimal 8 karakter.");
    sets.push("password_hash=?"); vals.push(await bcrypt.hash(b.password, 12)); bump = true;
  }
  const losesAdmin = u.role === "admin" && u.active && ((b.role !== undefined && b.role !== "admin") || (b.active !== undefined && !b.active));
  if (losesAdmin && (await activeAdmins()) <= 1) return bad(res, 400, "Harus ada minimal satu admin aktif.");
  if (!sets.length) return res.json({ ok: true });
  if (bump) sets.push("token_version=token_version+1");
  await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id=?`, [...vals, id]);
  if (bump && id === req.user.id) {
    const [fresh] = await pool.query("SELECT * FROM users WHERE id=?", [id]);
    setSession(req, res, fresh[0]);
  }
  res.json({ ok: true });
}));

api.delete("/users/:id", admin, h(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return bad(res, 400, "Anda tidak bisa menghapus akun sendiri.");
  const [rows] = await pool.query("SELECT role, active FROM users WHERE id=?", [id]);
  if (!rows.length) return bad(res, 404, "Pengguna tidak ditemukan.");
  if (rows[0].role === "admin" && rows[0].active && (await activeAdmins()) <= 1) return bad(res, 400, "Harus ada minimal satu admin aktif.");
  await pool.query("DELETE FROM users WHERE id=?", [id]);
  res.json({ ok: true });
}));

api.use((req, res) => bad(res, 404, "Alamat API tidak ditemukan."));
r.use("/api", api);

/* pages */
function serveBook(b) {
  return (req, res, next) => {
    fs.readFile(path.join(ROOT, b.dir, "index.html"), "utf8", (err, html) => {
      if (err) return next(err);
      const cfg = JSON.stringify({ book: b.id, name: b.name, api: BASE + "/api/" }).replace(/</g, "\\u003c");
      res.set("Cache-Control", "no-cache").type("html")
        .send(html.replace("</head>", `<script>window.PEMBUKUAN_SERVER=${cfg};</script>\n</head>`));
    });
  };
}
for (const b of BOOKS) r.get(b.path + "/", serveBook(b)); // non-strict routing: also answers /bmi without slash
r.get("/", (req, res) => {
  const def = BOOKS.find((b) => b.id === DEFAULT_BOOK) || (BOOKS.length === 1 ? BOOKS[0] : null);
  if (def) return res.redirect(BASE + def.path + "/");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  res.type("html").send(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pilih Buku</title><style>
:root{--bg:#F6F7F4;--fg:#15211D;--muted:#56645F;--card:#fff;--line:#DDE2DC;--brand:#155E8C}
@media (prefers-color-scheme:dark){:root{--bg:#0F1614;--fg:#E8EEEB;--muted:#A3B1AB;--card:#161F1C;--line:#2A3833;--brand:#4BA3D6;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:48px 16px}
main{max-width:520px;margin:0 auto;display:flex;flex-direction:column;gap:14px}h1{font-size:24px;margin:0 0 6px}
a{display:block;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;color:var(--fg);text-decoration:none;font-weight:700}
a:hover{border-color:var(--brand)}a span{display:block;font-weight:400;color:var(--muted);font-size:13px}</style></head>
<body><main><h1>Pilih buku</h1>${BOOKS.map((b) => `<a href="${esc(BASE + b.path + "/")}">${esc(b.name)}<span>${esc(BASE + b.path + "/")}</span></a>`).join("")}</main></body></html>`);
});

app.use(BASE || "/", r);

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === "entity.too.large") return bad(res, 413, "Data yang dikirim terlalu besar.");
  if (err && err.type === "entity.parse.failed") return bad(res, 400, "Format data tidak valid.");
  console.error(new Date().toISOString(), req.method, req.originalUrl, err);
  if (res.headersSent) return;
  bad(res, 500, "Terjadi kesalahan di server. Coba lagi sebentar lagi.");
});

migrate()
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`Pembukuan berjalan di http://${HOST}:${PORT}${BASE || ""}/`);
      if (SETUP_TOKEN) console.log("SETUP_TOKEN aktif: kosongkan setelah akun admin pertama dibuat.");
    });
  })
  .catch((e) => {
    console.error("Tidak bisa terhubung ke database. Periksa DB_HOST, DB_NAME, DB_USER, DB_PASSWORD di server/.env.");
    console.error(e.message);
    process.exit(1);
  });
