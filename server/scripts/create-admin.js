"use strict";
// Pemakaian: npm run create-admin -- <username> <password> [Nama Lengkap]
// Membuat akun admin, atau mereset password jika username sudah ada.
const bcrypt = require("bcryptjs");
const { pool, migrate } = require("../db");

(async () => {
  const [u, p, ...rest] = process.argv.slice(2);
  if (!u || !p) {
    console.log("Pemakaian: npm run create-admin -- <username> <password> [Nama Lengkap]");
    process.exit(1);
  }
  const username = u.trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,60}$/.test(username)) {
    console.error("Username hanya huruf kecil, angka, titik, garis bawah, atau tanda hubung (3-60 karakter).");
    process.exit(1);
  }
  if (p.length < 8) {
    console.error("Password minimal 8 karakter.");
    process.exit(1);
  }
  await migrate();
  const hash = await bcrypt.hash(p, 12);
  const [rows] = await pool.query("SELECT id FROM users WHERE username=?", [username]);
  if (rows.length) {
    await pool.query(
      "UPDATE users SET password_hash=?, role='admin', active=1, token_version=token_version+1 WHERE id=?",
      [hash, rows[0].id]
    );
    console.log(`Akun ${username} sekarang admin aktif dengan password baru.`);
  } else {
    await pool.query(
      "INSERT INTO users (username, name, password_hash, role, books) VALUES (?, ?, ?, 'admin', '*')",
      [username, rest.join(" ") || username, hash]
    );
    console.log(`Admin ${username} dibuat. Silakan masuk lewat browser.`);
  }
  await pool.end();
})().catch((e) => {
  console.error("Gagal:", e.message);
  process.exit(1);
});
