import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
const db = (TURSO_URL && TURSO_TOKEN) ? createClient({ url: TURSO_URL, authToken: TURSO_TOKEN }) : null;

async function initDB() {
  if (!db) return;
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS passport_data (
        email TEXT PRIMARY KEY, 
        photo_base64 TEXT, 
        status TEXT DEFAULT 'none',
        age INTEGER DEFAULT 0,
        gender TEXT DEFAULT '',
        last_photo_update TEXT
      )
    `);
    try { await db.execute('ALTER TABLE passport_data ADD COLUMN age INTEGER DEFAULT 0'); } catch(e) {}
    try { await db.execute('ALTER TABLE passport_data ADD COLUMN gender TEXT DEFAULT ""'); } catch(e) {}
    try { await db.execute('ALTER TABLE passport_data ADD COLUMN last_photo_update TEXT'); } catch(e) {}
    
    await db.execute(`
      CREATE TABLE IF NOT EXISTS permits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_email TEXT,
        to_email TEXT,
        status TEXT DEFAULT 'pending',
        expires_at TEXT,
        created_at TEXT
      )
    `);
    console.log('✅ База готова');
  } catch(e) { console.error(e); }
}
initDB();

app.post('/api/login', async (req, res) => {
  const { email, password, secret } = req.body;
  if (!db) return res.status(500).json({ error: 'Нет базы' });
  
  try {
    const u = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
    if (u.rows.length === 0) return res.status(401).json({ error: 'Аккаунт не найден' });
    if (u.rows[0].pwd !== password) return res.status(401).json({ error: 'Неверный пароль' });
    if (u.rows[0].secret_word && u.rows[0].secret_word !== secret) return res.status(401).json({ error: 'Неверное секретное слово' });
    
    const user = u.rows[0];
    let passCode = user.pass_code;
    if (!passCode) {
      const digits = Math.floor(10000 + Math.random() * 89999);
      const letter = (user.display_name || user.name)[0].toLowerCase();
      passCode = `${digits}${letter}`;
      await db.execute({ sql: 'UPDATE users SET pass_code = ? WHERE email = ?', args: [passCode, user.email] });
    }

    const p = await db.execute({ sql: 'SELECT * FROM passport_data WHERE email = ?', args: [user.email] });
    
    let photo = '', status = 'none', age = 0, gender = '', lastUpdate = null;
    if (p.rows.length > 0) {
      photo = p.rows[0].photo_base64;
      status = p.rows[0].status;
      age = p.rows[0].age;
      gender = p.rows[0].gender;
      lastUpdate = p.rows[0].last_photo_update;
    }

    res.json({ 
      success: true, 
      user: { 
        name: user.display_name || user.name, 
        email: user.email, 
        role: user.role,
        passCode: passCode,
        photo: photo,
        status: status,
        age: age,
        gender: gender,
        lastPhotoUpdate: lastUpdate,
        pwd: user.pwd,
        secret: user.secret_word
      } 
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Анкета (сохранение данных и фото)
app.post('/api/save_profile', async (req, res) => {
  const { email, photo_base64, age, gender } = req.body;
  if (!db) return res.status(500).json({ error: 'Нет базы' });
  
  try {
    const now = new Date().toISOString();
    await db.execute({ 
      sql: `INSERT INTO passport_data (email, photo_base64, status, age, gender, last_photo_update) 
            VALUES (?, ?, 'pending', ?, ?, ?) 
            ON CONFLICT(email) DO UPDATE SET 
            photo_base64 = ?, status = 'pending', age = ?, gender = ?, last_photo_update = ?`, 
      args: [email, photo_base64, age, gender, now, photo_base64, age, gender, now] 
    });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pending_list', async (req, res) => {
  if (!db) return res.json([]);
  try {
    const r = await db.execute(`
      SELECT u.email, u.display_name, u.name, p.photo_base64, p.age, p.gender 
      FROM passport_data p JOIN users u ON p.email = u.email WHERE p.status = 'pending'
    `);
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

app.post('/api/approve_passport', async (req, res) => {
  const { targetEmail, adminPass } = req.body;
  if (!db || adminPass !== '1495') return res.status(401).json({ error: 'Нет доступа' });
  try {
    await db.execute({ sql: "UPDATE passport_data SET status = 'approved' WHERE email = ?", args: [targetEmail] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- ПРОПУСКА (без изменений) ---
app.get('/api/users', async (req, res) => {
  if (!db) return res.json([]);
  const r = await db.execute('SELECT email, display_name, name, role FROM users');
  res.json(r.rows);
});

app.post('/api/permits/request', async (req, res) => {
  const { from_email, to_email } = req.body;
  if (!db) return res.status(500).json({ error: 'Нет базы' });
  try {
    await db.execute({ sql: `INSERT INTO permits (from_email, to_email, status, created_at) VALUES (?, ?, 'pending', ?)`, args: [from_email, to_email, new Date().toISOString()] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/permits/incoming/:email', async (req, res) => {
  if (!db) return res.json([]);
  try {
    const r = await db.execute({ sql: `SELECT p.*, u.display_name, u.name FROM permits p JOIN users u ON p.from_email = u.email WHERE p.to_email = ? AND p.status = 'pending'`, args: [req.params.email] });
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

app.post('/api/permits/approve', async (req, res) => {
  const { permit_id, hours } = req.body;
  if (!db) return res.status(500).json({ error: 'Нет базы' });
  try {
    const d = new Date(); d.setHours(d.getHours() + Number(hours));
    await db.execute({ sql: `UPDATE permits SET status = 'approved', expires_at = ? WHERE id = ?`, args: [d.toISOString(), permit_id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/permits/revoke', async (req, res) => {
  const { permit_id } = req.body;
  if (!db) return res.status(500).json({ error: 'Нет базы' });
  try {
    await db.execute({ sql: `UPDATE permits SET status = 'revoked' WHERE id = ?`, args: [permit_id] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/permits/active/:email', async (req, res) => {
  if (!db) return res.json([]);
  try {
    const r = await db.execute({ sql: `SELECT p.*, u.display_name, u.name FROM permits p JOIN users u ON p.to_email = u.email WHERE p.from_email = ? AND p.status = 'approved' ORDER BY p.id DESC`, args: [req.params.email] });
    const now = new Date();
    res.json(r.rows.filter(p => p.expires_at && new Date(p.expires_at) > now));
  } catch(e) { res.json([]); }
});

app.get('/api/permits/all_active', async (req, res) => {
  if (!db) return res.json([]);
  try {
    const r = await db.execute(`SELECT p.*, u1.display_name as from_name, u2.display_name as to_name FROM permits p JOIN users u1 ON p.from_email = u1.email JOIN users u2 ON p.to_email = u2.email WHERE p.status = 'approved'`);
    const now = new Date();
    res.json(r.rows.filter(p => p.expires_at && new Date(p.expires_at) > now));
  } catch(e) { res.json([]); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🪪 BOBOR-ID на :${PORT}`));
