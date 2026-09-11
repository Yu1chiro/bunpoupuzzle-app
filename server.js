"use strict";
require("dotenv").config();
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const PATH = Object.freeze({
  root: __dirname,
  public: path.join(__dirname, "public"),
  index: path.join(__dirname, "public", "index.html"),
  signin: path.join(__dirname, "public", "signin.html"),
  admin: path.join(__dirname, "public", "admin.html"),
  game: path.join(__dirname, "public", "game-mode.html"),
  profile: path.join(__dirname, "public", "profile.html"),
  schema: path.join(__dirname, "schema.sql"),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (status, message) => Object.assign(new Error(message), { status });
function string(value, name, min, max) {
  if (typeof value !== "string") throw fail(400, `${name} wajib berupa teks.`);
  const text = value.trim();
  if (text.length < min || text.length > max)
    throw fail(400, `${name}: ${min}–${max} karakter.`);
  return text;
}
function id(value) {
  if (!UUID.test(value)) throw fail(400, "ID tidak valid.");
  return value;
}
function parseQuestion(input) {
  if (!input || typeof input !== "object") throw fail(400, "Soal tidak valid.");
  const question = string(input.question, "Question", 3, 1000).normalize("NFC");
  const tokens = question.split("・").map((s) => s.trim());
  if (
    tokens.length < 2 ||
    tokens.length > 30 ||
    tokens.some((s) => !s || s.length > 100) ||
    new Set(tokens).size < 2
  )
    throw fail(
      400,
      "Gunakan 2–30 potongan berbeda, pisahkan dengan ・. Potongan tidak boleh kosong (maks. 100 karakter).",
    );
  return {
    question: tokens.join("・"),
    clue: string(input.clue ?? "", "Clue", 0, 500),
    tokens,
  };
}
function parseDeck(input) {
  const title = string(input.title, "Nama deck", 1, 100);
  const description = string(input.description ?? "", "Deskripsi", 0, 300);
  const seconds = Number(input.secondsPerQuestion ?? 60);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 600)
    throw fail(400, "Waktu harus 5–600 detik.");
  return { title, description, seconds };
}
// Fisher–Yates dengan randomInt kriptografis yang menghindari modulo bias.
function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
function puzzleTokens(question) {
  const correct = parseQuestion({ question }).tokens.map((text) => ({
    id: crypto.randomUUID(),
    text,
  }));
  let mixed;
  do {
    mixed = shuffle(correct);
  } while (mixed.every((t, i) => t.text === correct[i].text));
  return { correct, mixed };
}
function grade(question, tokenIds, seconds, startedAt, now) {
  if (
    !Array.isArray(tokenIds) ||
    tokenIds.length > question.correct.length ||
    tokenIds.some((t) => typeof t !== "string") ||
    new Set(tokenIds).size !== tokenIds.length
  )
    throw fail(400, "Susunan potongan tidak valid.");
  const byId = new Map(question.correct.map((t) => [t.id, t.text]));
  if (tokenIds.some((t) => !byId.has(t)))
    throw fail(400, "Potongan tidak dikenal.");
  const actual = tokenIds.map((t) => byId.get(t));
  const expected = question.correct.map((t) => t.text);
  const elapsedMs = Math.max(0, now - startedAt);
  // Waktu ditentukan server; tidak mempercayai waktu/EXP dari browser.
  const timedOut = elapsedMs >= seconds * 1000;
  const positions = expected.map((text, i) => ({
    position: i + 1,
    expected: text,
    actual: actual[i] ?? null,
    match: text === actual[i],
  }));
  const correct = !timedOut && positions.every((p) => p.match);
  const timeSeconds = Math.min(seconds, Math.round(elapsedMs / 100) / 10);
  return {
    questionId: question.id,
    clue: question.clue,
    expected,
    actual,
    positions,
    mismatches: positions.filter((p) => !p.match).length,
    correct,
    timedOut,
    timeSeconds,
    xp: correct
      ? 20 + Math.floor(10 * Math.max(0, 1 - elapsedMs / (seconds * 1000)))
      : 0,
  };
}
function summary(state) {
  const results = state.results;
  const correct = results.filter((r) => r.correct).length;
  let streak = 0,
    bestStreak = 0;
  for (const r of results) {
    streak = r.correct ? streak + 1 : 0;
    bestStreak = Math.max(streak, bestStreak);
  }
  return {
    id: state.id,
    deckId: state.deck.id,
    deckTitle: state.deck.title,
    revision: state.deck.revision,
    completedAt: state.completedAt,
    total: results.length,
    correct,
    incorrect: results.length - correct,
    timedOut: results.filter((r) => r.timedOut).length,
    accuracy: results.length ? Math.round((correct / results.length) * 100) : 0,
    totalXp: results.reduce((n, r) => n + r.xp, 0),
    bestStreak,
    totalSeconds:
      Math.round(results.reduce((n, r) => n + r.timeSeconds, 0) * 10) / 10,
    mismatches: results.reduce((n, r) => n + r.mismatches, 0),
    results,
  };
}
function publicState(state, now) {
  const base = {
    deck: state.deck,
    total: state.questions.length,
    index: state.index,
    phase: state.phase,
    serverNow: now,
    xp: state.results.reduce((n, r) => n + r.xp, 0),
    correct: state.results.filter((r) => r.correct).length,
  };
  if (state.phase === "done") return { ...base, summary: summary(state) };
  if (state.phase === "feedback")
    return { ...base, result: state.results[state.index] };
  const q = state.questions[state.index];
  return {
    ...base,
    question: { id: q.id, clue: q.clue, tokens: q.mixed },
    deadline: state.startedAt + state.deck.secondsPerQuestion * 1000,
  };
}

function createApp({
  pool,
  secret,
  origin = "http://localhost:3000",
  production = false,
  now = Date.now,
}) {
  if (!secret || secret.length < 32 || secret.includes("GANTI_DENGAN"))
    throw new Error("Isi JWT_SECRET dengan random secret minimal 32 karakter.");
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "250kb" }));
  app.use((req, res, next) => {
    req.body ??= {};
    next();
  });
  app.use(cookieParser());
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    // Cookie same-site + Origin check untuk request mutasi dari browser.
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("origin") &&
      req.get("origin") !== origin
    )
      return res
        .status(403)
        .json({ message: "Origin tidak diizinkan. Periksa APP_ORIGIN." });
    next();
  });
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict",
    secure: production,
    path: "/",
  };
  function issueCookie(res, admin) {
    const token = jwt.sign({ role: "admin" }, secret, {
      algorithm: "HS256",
      subject: admin.id,
      expiresIn: "7d",
      issuer: "bunpou-puzzle",
      audience: "admin",
    });
    res.cookie("bp_session", token, {
      ...cookieOptions,
      maxAge: 7 * 86400 * 1000,
    });
  }
  async function auth(req, res, next) {
    try {
      const payload = jwt.verify(req.cookies.bp_session || "", secret, {
        algorithms: ["HS256"],
        issuer: "bunpou-puzzle",
        audience: "admin",
      });
      if (payload.role !== "admin" || !UUID.test(payload.sub))
        throw new Error();
      const { rows } = await pool.query(
        "SELECT id, username, email FROM admins WHERE id = $1",
        [payload.sub],
      );
      if (!rows[0]) throw new Error();
      req.admin = rows[0];
    } catch (err) {
      if (err.code) return next(err);
      return res.status(401).json({ message: "Silakan masuk sebagai admin." });
    }
    next();
  }
  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  async function ownDeck(client, deckId, adminId, lock = false) {
    const { rows } = await client.query(
      "SELECT * FROM decks WHERE id = $1 AND admin_id = $2" +
        (lock ? " FOR UPDATE" : ""),
      [id(deckId), adminId],
    );
    if (!rows[0]) throw fail(404, "Deck tidak ditemukan atau bukan milikmu.");
    return rows[0];
  }
  async function bump(client, deckId) {
    await client.query(
      "UPDATE decks SET revision = revision + 1, updated_at = NOW() WHERE id = $1",
      [deckId],
    );
  }

  app.post("/api/auth/register", async (req, res) => {
    const username = string(req.body.username, "Username", 3, 40);
    const email = string(req.body.email, "Email", 3, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw fail(400, "Format email tidak valid.");
    const password = req.body.password;
    if (
      typeof password !== "string" ||
      password.length < 8 ||
      Buffer.byteLength(password, "utf8") > 72
    )
      throw fail(400, "Password minimal 8 karakter, maksimal 72 byte.");
    const admin = { id: crypto.randomUUID(), username, email };
    await pool.query(
      "INSERT INTO admins(id, username, email, password_hash) VALUES($1,$2,$3,$4)",
      [admin.id, username, email, await bcrypt.hash(password, 12)],
    );
    issueCookie(res, admin);
    res.status(201).json({ admin });
  });
  app.post("/api/auth/login", async (req, res) => {
    const email = string(req.body.email, "Email", 3, 254).toLowerCase();
    const password = req.body.password;
    if (
      typeof password !== "string" ||
      Buffer.byteLength(password, "utf8") > 72
    )
      throw fail(400, "Password tidak valid.");
    const { rows } = await pool.query("SELECT * FROM admins WHERE email = $1", [
      email,
    ]);
    const admin = rows[0];
    if (!admin || !(await bcrypt.compare(password, admin.password_hash)))
      throw fail(401, "Email atau password salah.");
    issueCookie(res, admin);
    res.json({
      admin: { id: admin.id, username: admin.username, email: admin.email },
    });
  });
  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie("bp_session", cookieOptions);
    res.json({ ok: true });
  });
  app.get("/api/auth/me", auth, (req, res) => res.json({ admin: req.admin }));
  app.get("/api/decks", async (req, res) => {
    const { rows } =
      await pool.query(`SELECT d.id, d.title, d.description, d.seconds_per_question, d.revision,
      a.username AS author, COUNT(q.id)::int AS question_count
      FROM decks d JOIN admins a ON a.id = d.admin_id LEFT JOIN questions q ON q.deck_id = d.id
      GROUP BY d.id, a.username ORDER BY d.created_at DESC`);
    res.json({ decks: rows });
  });
  app.get("/api/admin/decks", auth, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT d.*, COUNT(q.id)::int AS question_count FROM decks d
      LEFT JOIN questions q ON q.deck_id = d.id WHERE d.admin_id = $1 GROUP BY d.id ORDER BY d.created_at DESC`,
      [req.admin.id],
    );
    res.json({ decks: rows });
  });
  app.post("/api/admin/decks", auth, async (req, res) => {
    const d = parseDeck(req.body),
      deckId = crypto.randomUUID();
    const { rows } = await pool.query(
      "INSERT INTO decks(id,admin_id,title,description,seconds_per_question) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [deckId, req.admin.id, d.title, d.description, d.seconds],
    );
    res.status(201).json({ deck: rows[0] });
  });
  app.put("/api/admin/decks/:id", auth, async (req, res) => {
    const d = parseDeck(req.body);
    const deck = await transaction(async (client) => {
      await ownDeck(client, req.params.id, req.admin.id, true);
      const { rows } = await client.query(
        "UPDATE decks SET title=$1, description=$2, seconds_per_question=$3, revision=revision+1, updated_at=NOW() WHERE id=$4 RETURNING *",
        [d.title, d.description, d.seconds, req.params.id],
      );
      return rows[0];
    });
    res.json({ deck });
  });
  app.delete("/api/admin/decks/:id", auth, async (req, res) => {
    await transaction(async (client) => {
      await ownDeck(client, req.params.id, req.admin.id, true);
      await client.query("DELETE FROM decks WHERE id=$1", [req.params.id]);
    });
    res.json({ ok: true });
  });
  app.get("/api/admin/decks/:id/questions", auth, async (req, res) => {
    const deck = await ownDeck(pool, req.params.id, req.admin.id);
    const { rows } = await pool.query(
      "SELECT * FROM questions WHERE deck_id=$1 ORDER BY position, id",
      [deck.id],
    );
    res.json({ deck, questions: rows });
  });
  app.post("/api/admin/decks/:id/questions", auth, async (req, res) => {
    if (
      !Array.isArray(req.body.questions) ||
      !req.body.questions.length ||
      req.body.questions.length > 50
    )
      throw fail(400, "Tambahkan 1–50 soal per simpan.");
    const parsed = req.body.questions.map(parseQuestion);
    const questions = await transaction(async (client) => {
      await ownDeck(client, req.params.id, req.admin.id, true);
      const count = await client.query(
        "SELECT COUNT(*)::int AS n, COALESCE(MAX(position),0)::int AS last FROM questions WHERE deck_id=$1",
        [req.params.id],
      );
      if (count.rows[0].n + parsed.length > 200)
        throw fail(400, "Maksimal 200 soal per deck.");
      const result = [];
      for (let i = 0; i < parsed.length; i++) {
        const q = parsed[i];
        const { rows } = await client.query(
          "INSERT INTO questions(id,deck_id,question,clue,position) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [
            crypto.randomUUID(),
            req.params.id,
            q.question,
            q.clue,
            count.rows[0].last + i + 1,
          ],
        );
        result.push(rows[0]);
      }
      await bump(client, req.params.id);
      return result;
    });
    res.status(201).json({ questions });
  });
  app.put("/api/admin/decks/:deckId/questions/:id", auth, async (req, res) => {
    const q = parseQuestion(req.body);
    const question = await transaction(async (client) => {
      await ownDeck(client, req.params.deckId, req.admin.id, true);
      const { rows } = await client.query(
        "UPDATE questions SET question=$1,clue=$2 WHERE id=$3 AND deck_id=$4 RETURNING *",
        [q.question, q.clue, id(req.params.id), req.params.deckId],
      );
      if (!rows[0]) throw fail(404, "Soal tidak ditemukan.");
      await bump(client, req.params.deckId);
      return rows[0];
    });
    res.json({ question });
  });
  app.delete(
    "/api/admin/decks/:deckId/questions/:id",
    auth,
    async (req, res) => {
      await transaction(async (client) => {
        await ownDeck(client, req.params.deckId, req.admin.id, true);
        const result = await client.query(
          "DELETE FROM questions WHERE id=$1 AND deck_id=$2 RETURNING id",
          [id(req.params.id), req.params.deckId],
        );
        if (!result.rows[0]) throw fail(404, "Soal tidak ditemukan.");
        await bump(client, req.params.deckId);
      });
      res.json({ ok: true });
    },
  );

  app.post("/api/games", async (req, res) => {
    const deckId = id(req.body.deckId);
    const token = crypto.randomBytes(32).toString("hex");
    const state = await transaction(async (client) => {
      const { rows } = await client.query(
        "SELECT * FROM decks WHERE id=$1 FOR SHARE",
        [deckId],
      );
      const d = rows[0];
      if (!d) throw fail(404, "Deck tidak ditemukan.");
      const qs = await client.query(
        "SELECT id,question,clue FROM questions WHERE deck_id=$1 ORDER BY position,id",
        [deckId],
      );
      if (!qs.rows.length) throw fail(400, "Deck ini belum mempunyai soal.");
      const state = {
        id: crypto.randomUUID(),
        deck: {
          id: d.id,
          title: d.title,
          revision: d.revision,
          secondsPerQuestion: d.seconds_per_question,
        },
        questions: qs.rows.map((q) => ({
          id: q.id,
          clue: q.clue,
          ...puzzleTokens(q.question),
        })),
        results: [],
        phase: "question",
        index: 0,
        startedAt: now(),
        completedAt: null,
      };
      await client.query(
        "INSERT INTO game_sessions(token_hash,state,expires_at) VALUES($1,$2,$3)",
        [
          crypto.createHash("sha256").update(token).digest("hex"),
          JSON.stringify(state),
          new Date(now() + 86400000),
        ],
      );
      return state;
    });
    res.status(201).json({ token, ...publicState(state, now()) });
  });
  async function withGame(req, fn) {
    const token = req.get("x-game-token") || "";
    if (!/^[a-f0-9]{64}$/.test(token))
      throw fail(401, "Token permainan tidak valid.");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    return transaction(async (client) => {
      const { rows } = await client.query(
        "SELECT state,expires_at FROM game_sessions WHERE token_hash=$1 FOR UPDATE",
        [hash],
      );
      if (!rows[0] || new Date(rows[0].expires_at).getTime() <= now())
        throw fail(410, "Sesi berakhir. Mulai deck lagi dari beranda.");
      const state = rows[0].state;
      const output = await fn(state);
      await client.query(
        "UPDATE game_sessions SET state=$1 WHERE token_hash=$2",
        [JSON.stringify(state), hash],
      );
      return output;
    });
  }
  app.get("/api/games/current", async (req, res) =>
    res.json(await withGame(req, (state) => publicState(state, now()))),
  );
  app.post("/api/games/answer", async (req, res) => {
    const response = await withGame(req, (state) => {
      const index = req.body.index;
      if (!Number.isInteger(index) || index < 0)
        throw fail(400, "Nomor soal tidak valid.");
      // Retry request yang sama tidak menghasilkan EXP atau jawaban ganda.
      if (index < state.results.length)
        return {
          result: state.results[index],
          state: publicState(state, now()),
        };
      if (state.phase !== "question" || index !== state.index)
        throw fail(409, "Soal sudah berubah. Muat ulang sesi.");
      const result = grade(
        state.questions[index],
        req.body.tokenIds,
        state.deck.secondsPerQuestion,
        state.startedAt,
        now(),
      );
      state.results.push(result);
      state.phase = "feedback";
      return { result, state: publicState(state, now()) };
    });
    res.json(response);
  });
  app.post("/api/games/next", async (req, res) => {
    res.json(
      await withGame(req, (state) => {
        const index = req.body.index;
        if (!Number.isInteger(index) || index < 0 || index > state.index)
          throw fail(400, "Nomor soal tidak valid.");
        if (index < state.index || state.phase === "done")
          return publicState(state, now());
        if (state.phase !== "feedback") throw fail(409, "Jawab soal dahulu.");
        if (state.index === state.questions.length - 1) {
          state.phase = "done";
          state.completedAt = new Date(now()).toISOString();
        } else {
          state.index++;
          state.phase = "question";
          state.startedAt = now();
        }
        return publicState(state, now());
      }),
    );
  });

  app.use("/api", (req, res) =>
    res.status(404).json({ message: "Endpoint tidak ditemukan." }),
  );
  app.get(["/", "/index.html"], (req, res) => res.sendFile(PATH.index));
  app.get(["/signin", "/signin.html"], (req, res) => res.sendFile(PATH.signin));
  app.get(["/admin", "/admin.html"], (req, res) => res.sendFile(PATH.admin));
  app.get(["/game-mode", "/game-mode.html"], (req, res) =>
    res.sendFile(PATH.game),
  );
  app.get(["/profile", "/profile.html"], (req, res) =>
    res.sendFile(PATH.profile),
  );
  // Tidak pernah expose project-root, .env, SQL, atau server.js sebagai static.
  app.use(express.static(PATH.public, { index: false, dotfiles: "deny" }));
  app.use((req, res) => res.status(404).send("Halaman tidak ditemukan."));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.code === "23505")
      return res.status(409).json({ message: "Email sudah terdaftar." });
    if (err.type === "entity.parse.failed")
      return res.status(400).json({ message: "Format JSON tidak valid." });
    if (!err.status) console.error("Request failed:", err.code || err.name);
    res
      .status(err.status || 500)
      .json({
        message: err.status
          ? err.message
          : "Server gagal memproses permintaan. Periksa koneksi database.",
      });
  });
  return app;
}

async function main() {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("@HOST/"))
    throw new Error("Isi DATABASE_URL dari Neon pada file .env.");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  });
  pool.on("error", (err) =>
    console.error("Database connection:", err.code || err.name),
  );
  if (process.argv.includes("--init-db")) {
    await pool.query(await fs.readFile(PATH.schema, "utf8"));
    console.log("Schema database siap.");
    await pool.end();
    return;
  }
  const port = Number(process.env.PORT || 3000);
  const app = createApp({
    pool,
    secret: process.env.JWT_SECRET,
    origin: process.env.APP_ORIGIN || `http://localhost:${port}`,
    production: process.env.NODE_ENV === "production",
  });
  await pool.query("SELECT 1 FROM admins LIMIT 1");
  const server = app.listen(port, () =>
    console.log(`Bunpou Puzzle berjalan di http://localhost:${port}`),
  );
  const cleanup = () =>
    pool
      .query("DELETE FROM game_sessions WHERE expires_at < NOW()")
      .catch((err) => console.error("Session cleanup:", err.code || err.name));
  cleanup();
  const timer = setInterval(cleanup, 3600000);
  timer.unref();
  function close() {
    clearInterval(timer);
    server.close(() => pool.end().then(() => process.exit(0)));
  }
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}
if (require.main === module)
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
module.exports = { createApp, shuffle, parseQuestion, grade, summary, PATH };
