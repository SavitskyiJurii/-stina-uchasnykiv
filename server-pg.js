/*
 * Стіна учасників — версія для Render (Postgres).
 * Той самий API, що й server.js, але дані живуть у базі, а не у data.json —
 * тому безкоштовний інстанс Render можна перезапускати й «сипати в сон» без втрат.
 *
 * Локальний запуск:  DATABASE_URL=postgres://... node server-pg.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 8080;
const CAPACITY = Number(process.env.CAPACITY || 100);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "samsung2026";
const MAX_BODY = 10 * 1024 * 1024;
const TOKEN_TTL = 12 * 60 * 60 * 1000;
const DATABASE_URL = process.env.DATABASE_URL || "";

if (!DATABASE_URL) {
  console.error("DATABASE_URL не задано — скопіюйте Internal Database URL з Render.");
  process.exit(1);
}

const sslOff = process.env.PGSSL === "off" || /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: sslOff ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const q = (text, params) => pool.query(text, params);
const touch = () => {};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

const tokens = new Map();
const attempts = new Map();

async function init() {
  await q(`create table if not exists posts (
    id text primary key,
    client_id text not null,
    name text not null,
    role text not null default '',
    caption text not null default '',
    photo text,
    likes jsonb not null default '[]'::jsonb,
    comments jsonb not null default '[]'::jsonb,
    status text not null default 'approved',
    created_at bigint not null,
    edited_at bigint
  )`);
  await q(`create index if not exists posts_client_idx on posts (client_id)`);
  await q(`create index if not exists posts_created_idx on posts (created_at desc)`);
  await q(`create table if not exists settings (
    id int primary key,
    require_approval boolean not null default false
  )`);
  await q(`insert into settings (id, require_approval) values (1, false) on conflict (id) do nothing`);
  console.log("Schema ready.");
}

async function getSettings() {
  const r = await q("select require_approval from settings where id = 1");
  return { requireApproval: !!(r.rows[0] && r.rows[0].require_approval) };
}

const rowToPost = (row) => ({
  id: row.id,
  clientId: row.client_id,
  name: row.name,
  role: row.role || "",
  caption: row.caption || "",
  likes: Array.isArray(row.likes) ? row.likes : [],
  comments: Array.isArray(row.comments) ? row.comments : [],
  status: row.status || "approved",
  createdAt: Number(row.created_at),
  editedAt: row.edited_at ? Number(row.edited_at) : null
});

async function listPosts() {
  const r = await q(`select id, client_id, name, role, caption, likes, comments, status, created_at, edited_at
                     from posts order by created_at desc`);
  return r.rows.map(rowToPost);
}

async function getPost(id) {
  const r = await q(`select id, client_id, name, role, caption, likes, comments, status, created_at, edited_at
                     from posts where id = $1`, [id]);
  return r.rows[0] ? rowToPost(r.rows[0]) : null;
}

/* ---------------- helpers ---------------- */
function isAdmin(req) {
  const t = String(req.headers["x-admin-token"] || "");
  if (!t) return false;
  const exp = tokens.get(t);
  if (!exp) return false;
  if (Date.now() > exp) { tokens.delete(t); return false; }
  return true;
}

function send(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("bad_json")); }
    });
    req.on("error", reject);
  });
}

function visibleComments(p, cid, admin) {
  return (p.comments || [])
    .filter((c) => admin || c.status !== "pending" || c.clientId === cid)
    .map((c) => ({ id: c.id, name: c.name, text: c.text, createdAt: c.createdAt, status: c.status, mine: c.clientId === cid }));
}

function publicPost(p, cid, admin) {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    caption: p.caption,
    photo: "/photo/" + p.id,
    likes: p.likes,
    comments: visibleComments(p, cid, admin),
    createdAt: p.createdAt,
    editedAt: p.editedAt || null,
    clientId: p.clientId === cid ? cid : "other",
    status: p.status
  };
}

async function stateFor(req) {
  const cid = String(req.headers["x-client-id"] || "").slice(0, 60);
  const admin = isAdmin(req);
  const [posts, settings] = await Promise.all([listPosts(), getSettings()]);
  const visible = posts.filter((p) => admin || p.status !== "pending" || p.clientId === cid);
  return {
    capacity: CAPACITY,
    admin,
    settings,
    counts: {
      approved: posts.filter((p) => p.status === "approved").length,
      pending: posts.filter((p) => p.status === "pending").length,
      total: posts.length
    },
    posts: visible.map((p) => publicPost(p, cid, admin))
  };
}

/* ---------------- request handling ---------------- */
async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const cid = String(req.headers["x-client-id"] || "").slice(0, 60);

  if (req.method === "GET" && (p === "/" || p === "/index.html")) {
    const html = fs.readFileSync(path.join(__dirname, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(html);
  }

  if (req.method === "GET" && p === "/api/state") return send(res, 200, await stateFor(req));

  if (req.method === "GET" && p.startsWith("/photo/")) {
    const r = await q("select photo from posts where id = $1", [p.slice(7)]);
    const photo = r.rows[0] && r.rows[0].photo;
    const m = photo && /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(photo);
    if (!m) { res.writeHead(404); return res.end("not found"); }
    const buf = Buffer.from(m[2], "base64");
    res.writeHead(200, {
      "Content-Type": "image/" + m[1],
      "Content-Length": buf.length,
      "Cache-Control": "public, max-age=31536000, immutable"
    });
    return res.end(buf);
  }

  /* ---------- public: publish ---------- */
  if (req.method === "POST" && p === "/api/posts") {
    const settings = await getSettings();
    const total = Number((await q("select count(*)::int as n from posts")).rows[0].n);
    if (total >= CAPACITY) return send(res, 409, { error: "На стіні вже " + CAPACITY + " учасників" });
    const body = await readBody(req);
    const name = clean(body.name, 40);
    const role = clean(body.role, 48);
    const caption = String(body.caption || "").replace(/\s+/g, " ").trim().slice(0, 1500);
    const photo = String(body.photo || "");
    if (!name) return send(res, 400, { error: "Вкажіть ім’я" });
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) return send(res, 400, { error: "Додайте фото у форматі JPG або PNG" });
    if (photo.length > 4 * 1024 * 1024) return send(res, 413, { error: "Фото завелике — спробуйте інше" });
    if (!cid) return send(res, 400, { error: "Оновіть сторінку та спробуйте ще раз" });

    const id = uid();
    const createdAt = Date.now();
    const status = settings.requireApproval ? "pending" : "approved";
    try {
      await q(`insert into posts (id, client_id, name, role, caption, photo, likes, comments, status, created_at)
               values ($1,$2,$3,$4,$5,$6,'[]'::jsonb,'[]'::jsonb,$7,$8)`,
              [id, cid, name, role, caption, photo, status, createdAt]);
    } catch (e) {
      if (e.code === "23505") return send(res, 409, { error: "Ви вже додали свою картку — одну на учасника" });
      throw e;
    }
    const post = { id, clientId: cid, name, role, caption, likes: [], comments: [], status, createdAt, editedAt: null };
    return send(res, 201, { post: publicPost(post, cid, false), pending: status === "pending" });
  }

  /* ---------- public: like ---------- */
  const likeMatch = /^\/api\/posts\/([\w-]+)\/like$/.exec(p);
  if (req.method === "POST" && likeMatch) {
    await readBody(req).catch(() => ({}));
    const client = await pool.connect();
    try {
      await client.query("begin");
      const r = await client.query("select likes, status from posts where id = $1 for update", [likeMatch[1]]);
      if (!r.rowCount || r.rows[0].status === "pending") {
        await client.query("rollback");
        return send(res, 404, { error: "Картку не знайдено" });
      }
      const likes = Array.isArray(r.rows[0].likes) ? r.rows[0].likes : [];
      const i = likes.indexOf(cid);
      if (i === -1) likes.push(cid); else likes.splice(i, 1);
      await client.query("update posts set likes = $2::jsonb where id = $1", [likeMatch[1], JSON.stringify(likes)]);
      await client.query("commit");
      return send(res, 200, { likes });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally { client.release(); }
  }

  /* ---------- public: comment ---------- */
  const cmtMatch = /^\/api\/posts\/([\w-]+)\/comments$/.exec(p);
  if (req.method === "POST" && cmtMatch) {
    const body = await readBody(req);
    const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 240);
    const name = clean(body.name, 40) || "Учасник";
    if (!text) return send(res, 400, { error: "Порожній коментар" });
    const settings = await getSettings();
    const client = await pool.connect();
    try {
      await client.query("begin");
      const r = await client.query("select comments, status from posts where id = $1 for update", [cmtMatch[1]]);
      if (!r.rowCount || r.rows[0].status === "pending") {
        await client.query("rollback");
        return send(res, 404, { error: "Картку не знайдено" });
      }
      const comments = Array.isArray(r.rows[0].comments) ? r.rows[0].comments : [];
      comments.push({
        id: uid(), name, text, createdAt: Date.now(), clientId: cid,
        status: settings.requireApproval ? "pending" : "approved"
      });
      await client.query("update posts set comments = $2::jsonb where id = $1", [cmtMatch[1], JSON.stringify(comments)]);
      await client.query("commit");
      const admin = isAdmin(req);
      return send(res, 201, { comments: visibleComments({ comments }, cid, admin), pending: settings.requireApproval });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally { client.release(); }
  }

  /* ---------- author: delete / edit ---------- */
  const delMatch = /^\/api\/posts\/([\w-]+)$/.exec(p);
  if (req.method === "DELETE" && delMatch) {
    const post = await getPost(delMatch[1]);
    if (!post) return send(res, 404, { error: "Картку не знайдено" });
    if (post.clientId !== cid) return send(res, 403, { error: "Можна видалити лише свою картку" });
    await q("delete from posts where id = $1", [post.id]);
    return send(res, 200, { ok: true });
  }

  const editMatch = /^\/api\/posts\/([\w-]+)\/edit$/.exec(p);
  if (req.method === "POST" && editMatch) {
    const post = await getPost(editMatch[1]);
    if (!post) return send(res, 404, { error: "Картку не знайдено" });
    const admin = isAdmin(req);
    if (post.clientId !== cid && !admin) return send(res, 403, { error: "Можна редагувати лише свою картку" });
    const body = await readBody(req);
    const name = clean(body.name, 40) || post.name;
    const role = clean(body.role, 48);
    const caption = String(body.caption || "").replace(/\s+/g, " ").trim().slice(0, 1500);
    const settings = await getSettings();
    const status = settings.requireApproval && !admin ? "pending" : post.status;
    const editedAt = Date.now();
    await q("update posts set name=$2, role=$3, caption=$4, edited_at=$5, status=$6 where id=$1",
            [post.id, name, role, caption, editedAt, status]);
    const updated = { ...post, name, role, caption, editedAt, status };
    return send(res, 200, { post: publicPost(updated, cid, admin), pending: status === "pending" });
  }

  /* ---------- admin ---------- */
  if (req.method === "POST" && p === "/api/admin/login") {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
    const rec = attempts.get(ip) || { n: 0, until: 0 };
    if (Date.now() < rec.until && rec.n >= 8) return send(res, 429, { error: "Забагато спроб. Спробуйте за 10 хвилин." });
    const body = await readBody(req);
    const pass = String(body.password || "");
    const a = Buffer.from(pass), b = Buffer.from(ADMIN_PASSWORD);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      rec.n += 1; rec.until = Date.now() + 10 * 60 * 1000; attempts.set(ip, rec);
      return send(res, 401, { error: "Невірний пароль" });
    }
    attempts.delete(ip);
    const token = crypto.randomBytes(24).toString("hex");
    tokens.set(token, Date.now() + TOKEN_TTL);
    return send(res, 200, { token, ttl: TOKEN_TTL });
  }

  if (req.method === "POST" && p === "/api/admin/logout") {
    tokens.delete(String(req.headers["x-admin-token"] || ""));
    return send(res, 200, { ok: true });
  }

  const adminStatus = /^\/api\/admin\/posts\/([\w-]+)\/status$/.exec(p);
  const adminDelete = /^\/api\/admin\/posts\/([\w-]+)$/.exec(p);
  const adminCmtStatus = /^\/api\/admin\/posts\/([\w-]+)\/comments\/([\w-]+)\/status$/.exec(p);
  const adminCmtDelete = /^\/api\/admin\/posts\/([\w-]+)\/comments\/([\w-]+)$/.exec(p);

  if (p.startsWith("/api/admin/") && req.method !== "POST" && req.method !== "DELETE") {
    return send(res, 405, { error: "Метод не підтримується" });
  }

  if ((adminStatus || adminDelete || adminCmtStatus || adminCmtDelete || p === "/api/admin/settings") && !isAdmin(req)) {
    return send(res, 401, { error: "Потрібен вхід адміністратора" });
  }

  if (req.method === "POST" && adminStatus) {
    const body = await readBody(req);
    const status = String(body.status || "");
    if (!["approved", "pending", "hidden"].includes(status)) return send(res, 400, { error: "Невідомий статус" });
    const r = await q("update posts set status = $2 where id = $1", [adminStatus[1], status]);
    if (!r.rowCount) return send(res, 404, { error: "Картку не знайдено" });
    return send(res, 200, { ok: true, status });
  }

  if (req.method === "DELETE" && adminDelete) {
    const r = await q("delete from posts where id = $1", [adminDelete[1]]);
    if (!r.rowCount) return send(res, 404, { error: "Картку не знайдено" });
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && adminCmtStatus) {
    const body = await readBody(req);
    const status = String(body.status || "");
    if (!["approved", "pending", "hidden"].includes(status)) return send(res, 400, { error: "Невідомий статус" });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const r = await client.query("select comments from posts where id = $1 for update", [adminCmtStatus[1]]);
      if (!r.rowCount) { await client.query("rollback"); return send(res, 404, { error: "Картку не знайдено" }); }
      const comments = Array.isArray(r.rows[0].comments) ? r.rows[0].comments : [];
      const cmt = comments.find((c) => c.id === adminCmtStatus[2]);
      if (!cmt) { await client.query("rollback"); return send(res, 404, { error: "Коментар не знайдено" }); }
      cmt.status = status;
      await client.query("update posts set comments = $2::jsonb where id = $1", [adminCmtStatus[1], JSON.stringify(comments)]);
      await client.query("commit");
      return send(res, 200, { ok: true, status });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally { client.release(); }
  }

  if (req.method === "DELETE" && adminCmtDelete) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const r = await client.query("select comments from posts where id = $1 for update", [adminCmtDelete[1]]);
      if (!r.rowCount) { await client.query("rollback"); return send(res, 404, { error: "Картку не знайдено" }); }
      const comments = Array.isArray(r.rows[0].comments) ? r.rows[0].comments : [];
      const next = comments.filter((c) => c.id !== adminCmtDelete[2]);
      if (next.length === comments.length) { await client.query("rollback"); return send(res, 404, { error: "Коментар не знайдено" }); }
      await client.query("update posts set comments = $2::jsonb where id = $1", [adminCmtDelete[1], JSON.stringify(next)]);
      await client.query("commit");
      return send(res, 200, { ok: true });
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally { client.release(); }
  }

  if (req.method === "POST" && p === "/api/admin/settings") {
    const body = await readBody(req);
    const requireApproval = !!body.requireApproval;
    await q("update settings set require_approval = $1 where id = 1", [requireApproval]);
    return send(res, 200, { ok: true, settings: { requireApproval } });
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err && err.message === "too_large") return send(res, 413, { error: "Файл завеликий" });
    if (err && err.message === "bad_json") return send(res, 400, { error: "Некоректні дані" });
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: "Помилка сервера" });
    else res.end();
  });
});

init()
  .then(() => server.listen(PORT, "0.0.0.0", () => console.log("Wall (Postgres) running on http://0.0.0.0:" + PORT)))
  .catch((e) => { console.error("Не вдалося підготувати базу:", e.message); process.exit(1); });
