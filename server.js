const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const { put, list, del } = require('@vercel/blob');

const app = express();
const PORT = 4000;

// ===== Environment Detection =====
const IS_VERCEL = !!process.env.VERCEL;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

// ===== Blob Storage Helpers =====
async function blobReadJSON(filename) {
  try {
    const { blobs } = await list({ prefix: filename, token: BLOB_TOKEN });
    if (blobs.length === 0) return null;
    // Find exact match first
    const exact = blobs.find(b => b.pathname === filename) || blobs[0];
    const res = await fetch(exact.url + '?t=' + Date.now());
    return await res.json();
  } catch (err) {
    console.error(`Blob read error (${filename}):`, err.message);
    return null;
  }
}

async function blobWriteJSON(filename, data) {
  try {
    // Delete ALL existing blobs with this prefix (clean up old random-suffix versions)
    const { blobs } = await list({ prefix: filename, token: BLOB_TOKEN });
    if (blobs.length > 0) {
      await del(blobs.map(b => b.url), { token: BLOB_TOKEN });
    }
    // Write new blob with fixed name (no random suffix)
    await put(filename, JSON.stringify(data, null, 2), {
      access: 'public',
      token: BLOB_TOKEN,
      contentType: 'application/json',
      addRandomSuffix: false
    });
  } catch (err) {
    console.error(`Blob write error (${filename}):`, err.message);
  }
}

// ===== Data Read/Write (auto-switch between local & blob) =====
const DATA_FILE = path.join(__dirname, 'data.json');
const AUTH_FILE = path.join(__dirname, 'auth.json');

async function readData() {
  if (IS_VERCEL && BLOB_TOKEN) {
    const data = await blobReadJSON('data.json');
    if (data) return data;
    // Fallback: read from bundled file and init blob
    const localData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    await blobWriteJSON('data.json', localData);
    return localData;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

async function writeData(data) {
  if (IS_VERCEL && BLOB_TOKEN) {
    await blobWriteJSON('data.json', data);
  } else {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  }
}

async function readAuth() {
  if (IS_VERCEL && BLOB_TOKEN) {
    const auth = await blobReadJSON('auth.json');
    if (auth) return auth;
    // Init from local
    const localAuth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    await blobWriteJSON('auth.json', localAuth);
    return localAuth;
  }
  return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
}

async function writeAuth(data) {
  if (IS_VERCEL && BLOB_TOKEN) {
    await blobWriteJSON('auth.json', data);
  } else {
    fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
  }
}

// ===== Auth Configuration =====
function initAuth() {
  if (!IS_VERCEL && !fs.existsSync(AUTH_FILE)) {
    const defaultAuth = {
      username: 'admin',
      password: hashPassword('admin123')
    };
    fs.writeFileSync(AUTH_FILE, JSON.stringify(defaultAuth, null, 2));
  }
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

// Simple token-based session (persistent on Vercel via Blob)
const sessions = new Map();
let sessionsLoaded = false;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function loadSessions() {
  if (!IS_VERCEL || !BLOB_TOKEN || sessionsLoaded) return;
  try {
    const data = await blobReadJSON('sessions.json');
    if (data && Array.isArray(data)) {
      const now = Date.now();
      // Filter sessions older than 7 days
      data.filter(s => now - s.loginTime < 7 * 24 * 60 * 60 * 1000)
        .forEach(s => sessions.set(s.token, { username: s.username, loginTime: s.loginTime }));
    }
  } catch (e) {}
  sessionsLoaded = true;
}

async function saveSessions() {
  if (!IS_VERCEL || !BLOB_TOKEN) return;
  const arr = [];
  sessions.forEach((val, key) => arr.push({ token: key, ...val }));
  await blobWriteJSON('sessions.json', arr);
}

async function authMiddleware(req, res, next) {
  await loadSessions();
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token && sessions.has(token)) {
    return next();
  }
  res.status(401).json({ error: '未登录，请先登录' });
}

initAuth();

// ===== File Upload Configuration =====
// Local uploads (for dev)
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!IS_VERCEL && !fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = Date.now() + '-' + Math.round(Math.random() * 1e6) + ext;
    cb(null, name);
  }
});

// For Vercel: use memory storage
const memoryStorage = multer.memoryStorage();

const upload = multer({
  storage: IS_VERCEL ? memoryStorage : storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|mov|avi)$/i;
    if (allowed.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error('只允许上传图片或视频文件'));
    }
  }
});

// ===== Initialize Data =====
function initData() {
  if (!IS_VERCEL && !fs.existsSync(DATA_FILE)) {
    const defaultData = {
      siteInfo: {
        siteName: 'JILLBOO - 个人作品集',
        brand: 'GORDIAN',
        email: 'Hello@gordian.com',
        location: 'Italy, Roma',
        available: ['09 September', '12 October'],
        expertise: ['Design', 'Web Development'],
        social: { instagram: 'https://www.instagram.com/', linkedin: 'https://www.linkedin.com/' },
        copyright: '©2024 GORDIAN',
        footer: 'Made by Satto'
      },
      hero: {
        image: '',
        topLeftTitle: '',
        topRightTitle: '',
        bottomLeftSubtitle: '',
        bottomLeftDesc: '',
        bottomRightDesc: ''
      },
      about: { description: '', image1: '', image2: '', works: 8, years: 3, title: 'ABOUT', number: 'S01', statLabel1: 'Works', statLabel2: 'Years' },
      experienceSection: { title: '工作经历', number: 'S02' },
      experiences: [],
      works: [],
      services: { description: '', specializations: [], headings: [] },
      process: { images: [], steps: [] },
      contact: { heading: '', email: '' }
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2));
  }
}

initData();

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ===== Public API =====
app.get('/api/time', (req, res) => {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
  res.json({ time: timeStr });
});

app.get('/api/data', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    const data = await readData();
    // Filter out hidden works for public API
    if (data.works) {
      data.works = data.works.filter(w => !w.hidden);
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: '读取数据失败' });
  }
});

// ===== Upload API =====
app.post('/api/upload', authMiddleware, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请选择要上传的图片' });
  }

  try {
    if (IS_VERCEL && BLOB_TOKEN) {
      // Upload to Vercel Blob
      const ext = path.extname(req.file.originalname);
      const filename = 'uploads/' + Date.now() + '-' + Math.round(Math.random() * 1e6) + ext;
      const blob = await put(filename, req.file.buffer, {
        access: 'public',
        token: BLOB_TOKEN,
        contentType: req.file.mimetype
      });
      res.json({ success: true, url: blob.url });
    } else {
      // Local file path
      const url = '/uploads/' + req.file.filename;
      res.json({ success: true, url });
    }
  } catch (err) {
    res.status(500).json({ error: '上传失败: ' + err.message });
  }
});


// ===== Resume File Upload =====
const resumeUpload = multer({
  storage: IS_VERCEL ? memoryStorage : storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(pdf|doc|docx)$/i;
    if (allowed.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new Error('只允许上传 PDF/DOC/DOCX 文件'));
    }
  }
});

app.post('/api/upload/resume', authMiddleware, resumeUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请选择要上传的简历文件' });
  }
  try {
    let url;
    if (IS_VERCEL && BLOB_TOKEN) {
      const ext = path.extname(req.file.originalname);
      const filename = 'uploads/resume-' + Date.now() + ext;
      const blob = await put(filename, req.file.buffer, {
        access: 'public',
        token: BLOB_TOKEN,
        contentType: req.file.mimetype,
        addRandomSuffix: false
      });
      url = blob.url;
    } else {
      url = '/uploads/' + req.file.filename;
    }
    // Save to data
    const data = await readData();
    data.resume = data.resume || {};
    data.resume.fileUrl = url;
    data.resume.fileName = req.file.originalname;
    await writeData(data);
    res.json({ success: true, url, fileName: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: '上传失败: ' + err.message });
  }
});

// Update resume config
app.put('/api/admin/resume', authMiddleware, async (req, res) => {
  const data = await readData();
  data.resume = { ...data.resume, ...req.body };
  await writeData(data);
  res.json({ success: true, data: data.resume });
});

// ===== Auth API =====
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const auth = await readAuth();
  if (username === auth.username && hashPassword(password) === auth.password) {
    const token = generateToken();
    sessions.set(token, { username, loginTime: Date.now() });
    await saveSessions();
    res.json({ success: true, token, username });
  } else {
    res.status(401).json({ error: '用户名或密码错误' });
  }
});

app.post('/api/logout', async (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) {
    sessions.delete(token);
    await saveSessions();
  }
  res.json({ success: true });
});

app.put('/api/admin/auth', authMiddleware, async (req, res) => {
  const { username, oldPassword, newPassword } = req.body;
  const auth = await readAuth();

  if (hashPassword(oldPassword) !== auth.password) {
    return res.status(400).json({ error: '原密码错误' });
  }

  const updatedAuth = {
    username: username || auth.username,
    password: newPassword ? hashPassword(newPassword) : auth.password
  };
  await writeAuth(updatedAuth);
  res.json({ success: true, message: '账号信息已更新' });
});

app.get('/api/admin/auth-info', authMiddleware, async (req, res) => {
  const auth = await readAuth();
  res.json({ username: auth.username });
});

// ===== Admin API (protected) =====

// Get all data
app.get('/api/admin/data', authMiddleware, async (req, res) => {
  const data = await readData();
  res.json(data);
});

// Update site info
app.put('/api/admin/site-info', authMiddleware, async (req, res) => {
  const data = await readData();
  data.siteInfo = { ...data.siteInfo, ...req.body };
  await writeData(data);
  res.json({ success: true, data: data.siteInfo });
});

// Toggle disguise mode
app.put('/api/admin/disguise', authMiddleware, async (req, res) => {
  const data = await readData();
  data.siteInfo = data.siteInfo || {};
  data.siteInfo.disguiseMode = !!req.body.enabled;
  await writeData(data);
  res.json({ success: true, disguiseMode: data.siteInfo.disguiseMode });
});

// Update hero
app.put('/api/admin/hero', authMiddleware, async (req, res) => {
  const data = await readData();
  data.hero = { ...data.hero, ...req.body };
  await writeData(data);
  res.json({ success: true, data: data.hero });
});

// Update about
app.put('/api/admin/about', authMiddleware, async (req, res) => {
  const data = await readData();
  data.about = { ...data.about, ...req.body };
  await writeData(data);
  res.json({ success: true, data: data.about });
});

// Update contact
app.put('/api/admin/contact', authMiddleware, async (req, res) => {
  const data = await readData();
  data.contact = { ...data.contact, ...req.body };
  await writeData(data);
  res.json({ success: true, data: data.contact });
});

// Update process
app.put('/api/admin/process', authMiddleware, async (req, res) => {
  const data = await readData();
  data.process = { ...data.process, ...req.body };
  await writeData(data);
  res.json({ success: true, data: data.process });
});

// Update experience section title/number
app.put('/api/admin/experience-section', authMiddleware, async (req, res) => {
  const data = await readData();
  data.experienceSection = { ...data.experienceSection, ...req.body };
  await writeData(data);
  res.json({ success: true, data: data.experienceSection });
});

// ===== Experiences CRUD =====
app.get('/api/admin/experiences', authMiddleware, async (req, res) => {
  const data = await readData();
  res.json(data.experiences);
});

app.post('/api/admin/experiences', authMiddleware, async (req, res) => {
  const data = await readData();
  const newExp = { id: Date.now(), ...req.body };
  data.experiences.push(newExp);
  await writeData(data);
  res.json({ success: true, data: newExp });
});

app.put('/api/admin/experiences/:id', authMiddleware, async (req, res) => {
  const data = await readData();
  const idx = data.experiences.findIndex(e => e.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.experiences[idx] = { ...data.experiences[idx], ...req.body };
  await writeData(data);
  res.json({ success: true, data: data.experiences[idx] });
});

app.delete('/api/admin/experiences/:id', authMiddleware, async (req, res) => {
  const data = await readData();
  data.experiences = data.experiences.filter(e => e.id !== parseInt(req.params.id));
  await writeData(data);
  res.json({ success: true });
});

// ===== Works CRUD =====
app.get('/api/admin/works', authMiddleware, async (req, res) => {
  const data = await readData();
  res.json(data.works);
});

app.post('/api/admin/works', authMiddleware, async (req, res) => {
  const data = await readData();
  const newWork = { id: Date.now(), ...req.body };
  data.works.push(newWork);
  await writeData(data);
  res.json({ success: true, data: newWork });
});

app.put('/api/admin/works/:id', authMiddleware, async (req, res) => {
  const data = await readData();
  const idx = data.works.findIndex(w => w.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.works[idx] = { ...data.works[idx], ...req.body };
  await writeData(data);
  res.json({ success: true, data: data.works[idx] });
});

app.put('/api/admin/works/:id/toggle-hidden', authMiddleware, async (req, res) => {
  const data = await readData();
  const idx = data.works.findIndex(w => w.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.works[idx].hidden = !data.works[idx].hidden;
  await writeData(data);
  res.json({ success: true, hidden: data.works[idx].hidden });
});

app.delete('/api/admin/works/:id', authMiddleware, async (req, res) => {
  const data = await readData();
  data.works = data.works.filter(w => w.id !== parseInt(req.params.id));
  await writeData(data);
  res.json({ success: true });
});

// Get work detail
app.get('/api/works/:id', async (req, res) => {
  const data = await readData();
  const work = data.works.find(w => w.id === parseInt(req.params.id));
  if (!work) return res.status(404).json({ error: 'Not found' });
  res.json(work);
});

// Update work detail content
app.put('/api/admin/works/:id/detail', authMiddleware, async (req, res) => {
  const data = await readData();
  const idx = data.works.findIndex(w => w.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.works[idx].detail = req.body.detail || '';
  await writeData(data);
  res.json({ success: true, data: data.works[idx] });
});

// ===== Services =====
app.put('/api/admin/services', authMiddleware, async (req, res) => {
  const data = await readData();
  data.services = { ...data.services, ...req.body };
  await writeData(data);
  res.json({ success: true, data: data.services });
});

// Serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve work detail editor
app.get('/admin/work-detail/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-work-detail.html'));
});

// Serve work detail page
app.get('/work/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'work-detail.html'));
});

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Handle all other routes (SPA-style)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Export for Vercel serverless
module.exports = app;

// Start server only when running directly (not in Vercel)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Gordian website running at http://localhost:${PORT}`);
    console.log(`Admin panel at http://localhost:${PORT}/admin`);
  });
}
