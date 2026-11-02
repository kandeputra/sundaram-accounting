"use strict";
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const mysql = require("mysql2/promise");

const cfg = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL) || 10,
  charset: "utf8mb4",
  dateStrings: true,
  supportBigNumbers: true,
};
if (process.env.DB_SOCKET) cfg.socketPath = process.env.DB_SOCKET;
else {
  cfg.host = process.env.DB_HOST || "127.0.0.1";
  cfg.port = Number(process.env.DB_PORT) || 3306;
}

const pool = mysql.createPool(cfg);

// Same statements as schema.sql; run on every start so a fresh database needs no manual import.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(60) CHARACTER SET ascii NOT NULL,
    name VARCHAR(120) NOT NULL DEFAULT '',
    password_hash VARCHAR(100) CHARACTER SET ascii NOT NULL,
    role VARCHAR(10) CHARACTER SET ascii NOT NULL DEFAULT 'viewer',
    books VARCHAR(500) CHARACTER SET ascii NOT NULL DEFAULT '*',
    active TINYINT(1) NOT NULL DEFAULT 1,
    token_version INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME NULL,
    UNIQUE KEY uq_username (username)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS books (
    id VARCHAR(40) CHARACTER SET ascii NOT NULL PRIMARY KEY,
    rev BIGINT UNSIGNED NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS documents (
    book VARCHAR(40) CHARACTER SET ascii NOT NULL,
    coll VARCHAR(40) CHARACTER SET ascii NOT NULL,
    doc_id VARCHAR(200) CHARACTER SET ascii NOT NULL,
    data LONGTEXT NOT NULL,
    updated_at DATETIME NOT NULL,
    updated_by INT UNSIGNED NULL,
    PRIMARY KEY (book, coll, doc_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    book VARCHAR(40) CHARACTER SET ascii NOT NULL,
    user_id INT UNSIGNED NULL,
    username VARCHAR(60) NOT NULL DEFAULT '',
    action VARCHAR(20) NOT NULL,
    coll VARCHAR(40) NOT NULL DEFAULT '',
    doc_id VARCHAR(200) NOT NULL DEFAULT '',
    summary VARCHAR(255) NOT NULL DEFAULT '',
    at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_book_at (book, at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

async function migrate() {
  for (const q of SCHEMA) await pool.query(q);
}

module.exports = { pool, migrate, SCHEMA };
