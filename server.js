import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '10mb' })); // Увеличили лимит для фото
app.use(express.static(path.join(__dirname, 'public')));

const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
const db = (TURSO_URL && TURSO_TOKEN) ? createClient({ url: TURSO_URL, authToken: TURSO_TOKEN }) : null;

// Создаем таблицу для паспортов при запуске
async function initDB() {
  if (!db) return;
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS passport_data (
        email TEXT PRIMARY KEY, 
        photo_base64 TEXT, 
        status TEXT DEFAULT 'none'
      )
    `);
    console.log('✅ База паспортов готова');
  } catch(e) { console.error(e); }
}
initDB();

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!db) return res.status(500).json({ error: 'Нет базы' });
  
  try {
    const u = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
    if (u.rows.length === 0) return res.status(401).json({ error: 'Не найден' });
    if (u.rows[0].pwd !== password) return res.status(401).json({ error: 'Неверный пароль' });
    
    const user = u.rows[0];
    let passCode = user.pass_code;
    if (!passCode) {
      const digits = Math.floor(10000 + Math.random() * 89999);
      const letter = (user.display_name || user.name)[0].toLowerCase();
      passCode = `${digits}${letter}`;
      await db.execute({ sql: 'UPDATE users SET pass_code = ? WHERE email = ?', args: [passCode, user.email] });
    }

    // Получаем данные паспорта (фото и статус)
    const p = await db.execute({ sql: 'SELECT * FROM passport_data WHERE email = ?', args: [user.email] });
    const photo = p.rows.length > 0 ? p.rows[0].photo_base64 : '';
    const status = p.rows.length > 0 ? p.rows[0].status : 'none';

    res.json({ 
      success: true, 
      user: { 
        name: user.display_name || user.name, 
        email: user.email, 
        role: user.role,
        passCode: passCode,
        photo: photo,
        status: status
      } 
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Пользователь загружает фото (статус становится "pending")
app.post('/api/upload_photo', async (req, res) => {
  const { email, photo_base64 } = req.body;
  if (!db) return res.status(500).json({ error: 'Нет базы' });
  
  try {
    await db.execute({ 
      sql: `INSERT INTO passport_data (email, photo_base64, status) VALUES (?, ?, 'pending') 
            ON CONFLICT(email) DO UPDATE SET photo_base64 = ?, status = 'pending'`, 
      args: [email, photo_base64, photo_base64] 
    });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Админ получает список всех, кто ждет проверки
app.get('/api/pending_list', async (req, res) => {
  if (!db) return res.json([]);
  try {
    const r = await db.execute(`
      SELECT u.email, u.display_name, u.name, p.photo_base64 
      FROM passport_data p 
      JOIN users u ON p.email = u.email 
      WHERE p.status = 'pending'
    `);
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

// Админ подтверждает
app.post('/api/approve', async (req, res) => {
  const { targetEmail, adminPass } = req.body;
  if (!db) return res.status(500).json({ error: 'Нет базы' });
  if (adminPass !== '1495') return res.status(401).json({ error: 'Нет доступа' });

  try {
    await db.execute({ sql: "UPDATE passport_data SET status = 'approved' WHERE email = ?", args: [targetEmail] });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🪪 BOBOR PASSPORT на :${PORT}`));
