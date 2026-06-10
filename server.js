const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const { put, list, del } = require('@vercel/blob');

const app = express();
const PORT = process.env.PORT || 4000;

// ===== Async Route Handler Wrapper =====
// Catches errors in async route handlers, preventing unhandled rejections from
// hanging requests until timeout on Vercel Hobby (10s limit).
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ===== Environment Detection =====
const IS_VERCEL = !!process.env.VERCEL;
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

// ===== Blob Storage Helpers =====
async function blobReadJSON(filename, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { blobs } = await list({ prefix: filename, token: BLOB_TOKEN });
      if (blobs.length === 0) return null; // Truly empty, no retry needed
      // Exact match only - prevent prefix collision (e.g. data.json.bak)
      const exact = blobs.find(b => b.pathname === filename);
      if (!exact) return null;
      const res = await fetch(exact.url + '?t=' + Date.now(), {
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      const text = await res.text();
      if (!text || text.trim().length === 0) throw new Error('Empty response');
      return JSON.parse(text);
    } catch (err) {
      console.error(`Blob read error (${filename}), attempt ${attempt}/${retries}:`, err.message);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 500 * attempt)); // Progressive backoff
      }
    }
  }
  console.error(`Blob read FAILED after ${retries} attempts: ${filename}`);
  return null;
}

async function blobWriteJSON(filename, data) {
  try {
    const jsonStr = JSON.stringify(data, null, 2);
    // Sanity check: refuse to write empty or obviously corrupted data
    if (!jsonStr || jsonStr.length < 10) {
      throw new Error(`Refusing to write near-empty data to ${filename} (${jsonStr.length} bytes)`);
    }
    // For data.json: verify critical fields exist before overwriting
    if (filename === 'data.json') {
      if (!data.siteInfo || !data.works || !Array.isArray(data.works)) {
        throw new Error('Data integrity check failed: missing siteInfo or works array');
      }
    }
    await put(filename, jsonStr, {
      access: 'public',
      token: BLOB_TOKEN,
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true
    });
  } catch (err) {
    console.error(`Blob write error (${filename}):`, err.message);
    throw err;
  }
}

// ===== Data Read/Write (auto-switch between local & blob) =====
const DATA_FILE = path.join(__dirname, 'data.json');
const AUTH_FILE = path.join(__dirname, 'auth.json');

// ===== Write Lock (prevents concurrent read-modify-write races) =====
let writeLock = Promise.resolve();
function withWriteLock(fn) {
  // Queue operations sequentially to prevent data races
  const next = writeLock.then(fn, fn);
  writeLock = next.catch(() => {}); // prevent unhandled rejection chain
  return next;
}

// ===== Auto-snapshot: keep last N snapshots before each write =====
const SNAPSHOT_PREFIX = 'snapshots/';
const MAX_SNAPSHOTS = 20;
let snapshotCount = 0;

async function autoSnapshot(currentData) {
  if (!IS_VERCEL || !BLOB_TOKEN) return; // Only on Vercel
  try {
    const ts = Date.now();
    await put(SNAPSHOT_PREFIX + ts + '.json', JSON.stringify(currentData), {
      access: 'public', token: BLOB_TOKEN, contentType: 'application/json',
      addRandomSuffix: false, allowOverwrite: true
    });
    snapshotCount++;
    // Cleanup old snapshots periodically (every 10 writes)
    if (snapshotCount % 10 === 0) {
      const { blobs } = await list({ prefix: SNAPSHOT_PREFIX, token: BLOB_TOKEN, limit: 100 });
      if (blobs.length > MAX_SNAPSHOTS) {
        const toDelete = blobs
          .sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt))
          .slice(0, blobs.length - MAX_SNAPSHOTS);
        if (toDelete.length > 0) {
          await del(toDelete.map(b => b.url), { token: BLOB_TOKEN });
        }
      }
    }
  } catch (e) {
    console.error('Auto-snapshot failed (non-fatal):', e.message);
  }
}

async function readData() {
  if (IS_VERCEL && BLOB_TOKEN) {
    // On Vercel: ONLY read from Blob. NEVER fall back to local file.
    const data = await blobReadJSON('data.json');
    if (data) return data;
    // Check if Blob data.json truly doesn't exist vs read failure
    const { blobs } = await list({ prefix: 'data.json', token: BLOB_TOKEN });
    const exactMatch = blobs.find(b => b.pathname === 'data.json');
    if (!exactMatch) {
      // data.json missing from Blob! Try to recover from latest snapshot first
      console.warn('data.json missing from Blob! Attempting snapshot recovery...');
      const { blobs: snaps } = await list({ prefix: SNAPSHOT_PREFIX, token: BLOB_TOKEN, limit: 100 });
      if (snaps.length > 0) {
        // Use the most recent snapshot
        const latest = snaps.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
        try {
          const snapRes = await fetch(latest.url + '?t=' + Date.now());
          const snapData = await snapRes.json();
          if (snapData && snapData.siteInfo && snapData.works) {
            console.warn('Recovered from snapshot: ' + latest.pathname);
            await blobWriteJSON('data.json', snapData);
            return snapData;
          }
        } catch (e) {
          console.error('Snapshot recovery failed:', e.message);
        }
      }
      // No snapshots available - truly first deploy, use local file
      console.warn('First deploy detected: initializing Blob data.json from local file');
      const localData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      await blobWriteJSON('data.json', localData);
      return localData;
    }
    // Blob exists but read failed after retries - do NOT use local file
    throw new Error('Blob data.json read failed after retries. Refusing to use local fallback.');
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

// Safe read-modify-write: acquires lock, reads fresh data, applies modifier, writes back
// This prevents ALL race conditions from concurrent API calls
async function safeUpdateData(modifierFn) {
  return withWriteLock(async () => {
    const data = await readData();
    await autoSnapshot(data); // save snapshot before any modification
    const result = await modifierFn(data);
    await writeData(data);
    return result;
  });
}

async function readAuth() {
  if (IS_VERCEL && BLOB_TOKEN) {
    const auth = await blobReadJSON('auth.json');
    if (auth) return auth;
    // First time: initialize Blob auth from local file, then return it
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
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 210000;
  const digest = crypto.pbkdf2Sync(pw, salt, iterations, 32, 'sha256').toString('hex');
  return `pbkdf2$${iterations}$${salt}$${digest}`;
}

function verifyPassword(pw, storedHash) {
  if (!storedHash) return false;

  if (storedHash.startsWith('pbkdf2$')) {
    const parts = storedHash.split('$');
    if (parts.length !== 4) return false;
    const iterations = Number(parts[1]);
    const salt = parts[2];
    const expected = parts[3];
    if (!Number.isInteger(iterations) || !salt || !/^[a-f0-9]{64}$/i.test(expected)) return false;
    const actual = crypto.pbkdf2Sync(pw, salt, iterations, 32, 'sha256').toString('hex');
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  }

  // Legacy SHA-256 hashes are accepted so existing accounts can log in once.
  if (/^[a-f0-9]{64}$/i.test(storedHash)) {
    const actual = crypto.createHash('sha256').update(pw).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(storedHash, 'hex'));
  }

  return false;
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
  const token = req.headers['x-auth-token'];
  if (token && sessions.has(token)) {
    return next();
  }
  res.status(401).json({ error: '未登录，请先登录' });
}

initAuth();

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 8;

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || '')
    .toString()
    .split(',')[0]
    .trim();
}

function isLoginLimited(req) {
  const key = getClientIp(req) || 'unknown';
  const now = Date.now();
  const attempt = loginAttempts.get(key);
  if (!attempt || now > attempt.resetAt) {
    loginAttempts.set(key, { count: 0, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  return attempt.count >= MAX_LOGIN_ATTEMPTS;
}

function recordLoginFailure(req) {
  const key = getClientIp(req) || 'unknown';
  const now = Date.now();
  const attempt = loginAttempts.get(key) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (now > attempt.resetAt) {
    attempt.count = 0;
    attempt.resetAt = now + LOGIN_WINDOW_MS;
  }
  attempt.count += 1;
  loginAttempts.set(key, attempt);
}

function clearLoginFailures(req) {
  loginAttempts.delete(getClientIp(req) || 'unknown');
}

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

const ALLOWED_MEDIA_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.mov', '.avi']);
const ALLOWED_RESUME_EXTS = new Set(['.pdf', '.doc', '.docx']);

function hasAllowedExt(file, allowedExts) {
  return allowedExts.has(path.extname(file.originalname).toLowerCase());
}

function hasAllowedMediaMime(file) {
  return /^image\/(jpeg|png|gif|webp)$/.test(file.mimetype) ||
    /^video\/(mp4|webm|quicktime|x-msvideo)$/.test(file.mimetype);
}

function readUploadPrefix(file, bytes = 16) {
  if (file.buffer) return file.buffer.subarray(0, bytes);
  return fs.readFileSync(file.path).subarray(0, bytes);
}

function isAllowedMediaSignature(buf) {
  if (buf.length < 4) return false;
  const hex = buf.toString('hex');
  const ascii = buf.toString('ascii');
  return hex.startsWith('ffd8ff') ||
    hex.startsWith('89504e47') ||
    ascii.startsWith('GIF8') ||
    (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') ||
    (ascii.startsWith('RIFF') && ascii.slice(8, 11) === 'AVI') ||
    (ascii.slice(4, 8) === 'ftyp') ||
    hex.startsWith('1a45dfa3');
}

function isAllowedResumeSignature(buf) {
  if (buf.length < 4) return false;
  const hex = buf.toString('hex');
  const ascii = buf.toString('ascii');
  return ascii.startsWith('%PDF') ||
    hex.startsWith('d0cf11e0') ||
    ascii.startsWith('PK\u0003\u0004');
}

function cleanupRejectedUpload(file) {
  if (!file.buffer && file.path && fs.existsSync(file.path)) {
    fs.unlinkSync(file.path);
  }
}

function validateUploadContent(file, kind) {
  const buf = readUploadPrefix(file);
  const valid = kind === 'resume' ? isAllowedResumeSignature(buf) : isAllowedMediaSignature(buf);
  if (!valid) {
    cleanupRejectedUpload(file);
    return false;
  }
  return true;
}

const upload = multer({
  storage: IS_VERCEL ? memoryStorage : storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (hasAllowedExt(file, ALLOWED_MEDIA_EXTS) && hasAllowedMediaMime(file)) {
      cb(null, true);
    } else {
      cb(new Error('只允许上传图片或视频文件'));
    }
  }
});

// ===== Initialize Data =====
// Only creates default data.json for LOCAL development when file doesn't exist.
// On Vercel, data ALWAYS comes from Blob storage - local file is NEVER used.
function initData() {
  if (IS_VERCEL) return; // NEVER touch local files on Vercel
  if (!fs.existsSync(DATA_FILE)) {
    const defaultData = {
      siteInfo: { siteName: '', brand: '', email: '', location: '', expertise: [], social: {}, copyright: '', footer: '' },
      hero: { image: '', topLeftTitle: '', topRightTitle: '', bottomLeftSubtitle: '', bottomLeftDesc: '', bottomRightDesc: '' },
      about: { description: '', image1: '', image2: '', works: 0, years: 0, title: '', number: '' },
      experienceSection: { title: '', number: '' },
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

app.get('/api/data', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  const data = await readData();
  // Filter out hidden works for public API
  if (data.works) {
    data.works = data.works.filter(w => !w.hidden).map(w => {
      // Exclude detail field from listing to reduce payload size
      const { detail, ...rest } = w;
      return rest;
    });
  }
  res.json(data);
}));

// ===== Upload API =====
app.post('/api/upload', authMiddleware, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请选择要上传的图片' });
  }
  if (!validateUploadContent(req.file, 'media')) {
    return res.status(400).json({ error: '文件内容与允许的图片/视频格式不匹配' });
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
    if (hasAllowedExt(file, ALLOWED_RESUME_EXTS)) {
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
  if (!validateUploadContent(req.file, 'resume')) {
    return res.status(400).json({ error: '文件内容与允许的简历格式不匹配' });
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
        addRandomSuffix: false,
        allowOverwrite: true
      });
      url = blob.url;
    } else {
      url = '/uploads/' + req.file.filename;
    }
    // Save to data using safe update
    await safeUpdateData(data => {
      data.resume = data.resume || {};
      data.resume.fileUrl = url;
      data.resume.fileName = req.file.originalname;
    });
    res.json({ success: true, url, fileName: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: '上传失败: ' + err.message });
  }
});

// Update resume config
app.put('/api/admin/resume', authMiddleware, asyncHandler(async (req, res) => {
  const result = await safeUpdateData(data => {
    data.resume = { ...data.resume, ...req.body };
    return data.resume;
  });
  res.json({ success: true, data: result });
}));

// ===== Auth API =====
app.post('/api/login', asyncHandler(async (req, res) => {
  if (isLoginLimited(req)) {
    return res.status(429).json({ error: '登录尝试过多，请稍后再试' });
  }

  const { username, password } = req.body;
  const auth = await readAuth();
  if (username === auth.username && verifyPassword(password, auth.password)) {
    if (!String(auth.password || '').startsWith('pbkdf2$')) {
      await writeAuth({ ...auth, password: hashPassword(password) });
    }
    clearLoginFailures(req);
    const token = generateToken();
    sessions.set(token, { username, loginTime: Date.now() });
    await saveSessions();
    res.json({ success: true, token, username });
  } else {
    recordLoginFailure(req);
    res.status(401).json({ error: '用户名或密码错误' });
  }
}));

app.post('/api/logout', asyncHandler(async (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) {
    sessions.delete(token);
    await saveSessions();
  }
  res.json({ success: true });
}));

app.put('/api/admin/auth', authMiddleware, asyncHandler(async (req, res) => {
  const { username, oldPassword, newPassword } = req.body;
  const auth = await readAuth();

  if (!verifyPassword(oldPassword, auth.password)) {
    return res.status(400).json({ error: '原密码错误' });
  }

  const updatedAuth = {
    username: username || auth.username,
    password: newPassword ? hashPassword(newPassword) : auth.password
  };
  await writeAuth(updatedAuth);
  res.json({ success: true, message: '账号信息已更新' });
}));

app.get('/api/admin/auth-info', authMiddleware, asyncHandler(async (req, res) => {
  const auth = await readAuth();
  res.json({ username: auth.username });
}));

// ===== Admin API (protected) =====

// Get all data
app.get('/api/admin/data', authMiddleware, asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const data = await readData();
  res.json(data);
}));

// Update site info
app.put('/api/admin/site-info', authMiddleware, asyncHandler(async (req, res) => {
  const result = await safeUpdateData(data => {
    data.siteInfo = { ...data.siteInfo, ...req.body };
    return data.siteInfo;
  });
  res.json({ success: true, data: result });
}));

// Toggle disguise mode
app.put('/api/admin/disguise', authMiddleware, asyncHandler(async (req, res) => {
  const result = await safeUpdateData(data => {
    data.siteInfo = data.siteInfo || {};
    data.siteInfo.disguiseMode = !!req.body.enabled;
    return data.siteInfo.disguiseMode;
  });
  res.json({ success: true, disguiseMode: result });
}));

// Update hero
app.put('/api/admin/hero', authMiddleware, asyncHandler(async (req, res) => {
  const result = await safeUpdateData(data => {
    data.hero = { ...data.hero, ...req.body };
    return data.hero;
  });
  res.json({ success: true, data: result });
}));

// Update about
app.put('/api/admin/about', authMiddleware, asyncHandler(async (req, res) => {
  const result = await safeUpdateData(data => {
    data.about = { ...data.about, ...req.body };
    return data.about;
  });
  res.json({ success: true, data: result });
}));

// Update contact
app.put('/api/admin/contact', authMiddleware, asyncHandler(async (req, res) => {
  const result = await safeUpdateData(data => {
    data.contact = { ...data.contact, ...req.body };
    return data.contact;
  });
  res.json({ success: true, data: result });
}));

// Update process
app.put('/api/admin/process', authMiddleware, asyncHandler(async (req, res) => {
  const result = await safeUpdateData(data => {
    data.process = { ...data.process, ...req.body };
    return data.process;
  });
  res.json({ success: true, data: result });
}));

// Update experience section title/number
app.put('/api/admin/experience-section', authMiddleware, asyncHandler(async (req, res) => {
  const result = await safeUpdateData(data => {
    data.experienceSection = { ...data.experienceSection, ...req.body };
    return data.experienceSection;
  });
  res.json({ success: true, data: result });
}));

// ===== Experiences CRUD =====
app.get('/api/admin/experiences', authMiddleware, asyncHandler(async (req, res) => {
  const data = await readData();
  res.json(data.experiences);
}));

app.post('/api/admin/experiences', authMiddleware, asyncHandler(async (req, res) => {
  const result = await safeUpdateData(data => {
    const newExp = { id: Date.now(), ...req.body };
    data.experiences.push(newExp);
    return newExp;
  });
  res.json({ success: true, data: result });
}));

app.put('/api/admin/experiences/:id', authMiddleware, asyncHandler(async (req, res) => {
  const result = await safeUpdateData(data => {
    const idx = data.experiences.findIndex(e => e.id === parseInt(req.params.id));
    if (idx === -1) throw { status: 404, error: 'Not found' };
    data.experiences[idx] = { ...data.experiences[idx], ...req.body };
    return data.experiences[idx];
  });
  res.json({ success: true, data: result });
}));

app.delete('/api/admin/experiences/:id', authMiddleware, asyncHandler(async (req, res) => {
  await safeUpdateData(data => {
    data.experiences = data.experiences.filter(e => e.id !== parseInt(req.params.id));
  });
  res.json({ success: true });
}));

// ===== Works CRUD =====
app.get('/api/admin/works', authMiddleware, asyncHandler(async (req, res) => {
  const data = await readData();
  res.json(data.works);
}));

app.post('/api/admin/works', authMiddleware, asyncHandler(async (req, res) => {
  const result = await safeUpdateData(data => {
    const newWork = { id: Date.now(), ...req.body };
    data.works.push(newWork);
    return newWork;
  });
  res.json({ success: true, data: result });
}));

app.put('/api/admin/works/:id', authMiddleware, asyncHandler(async (req, res) => {
  const result = await safeUpdateData(data => {
    const idx = data.works.findIndex(w => w.id === parseInt(req.params.id));
    if (idx === -1) throw { status: 404, error: 'Not found' };
    data.works[idx] = { ...data.works[idx], ...req.body };
    return data.works[idx];
  });
  res.json({ success: true, data: result });
}));

app.put('/api/admin/works/:id/toggle-hidden', authMiddleware, asyncHandler(async (req, res) => {
  const result = await safeUpdateData(data => {
    const idx = data.works.findIndex(w => w.id === parseInt(req.params.id));
    if (idx === -1) throw { status: 404, error: 'Not found' };
    data.works[idx].hidden = !data.works[idx].hidden;
    return data.works[idx].hidden;
  });
  res.json({ success: true, hidden: result });
}));

app.delete('/api/admin/works/:id', authMiddleware, asyncHandler(async (req, res) => {
  await safeUpdateData(data => {
    data.works = data.works.filter(w => w.id !== parseInt(req.params.id));
  });
  res.json({ success: true });
}));

// Get work detail
app.get('/api/works/:id', asyncHandler(async (req, res) => {
  const data = await readData();
  const work = data.works.find(w => w.id === parseInt(req.params.id));
  if (!work) return res.status(404).json({ error: 'Not found' });
  res.json(work);
}));

// Update work detail content
app.put('/api/admin/works/:id/detail', authMiddleware, asyncHandler(async (req, res) => {
  await safeUpdateData(data => {
    const idx = data.works.findIndex(w => w.id === parseInt(req.params.id));
    if (idx === -1) throw { status: 404, error: 'Not found' };
    data.works[idx].detail = req.body.detail || '';
  });
  res.json({ success: true });
}));

// ===== Services =====
app.put('/api/admin/services', authMiddleware, asyncHandler(async (req, res) => {
  const result = await safeUpdateData(data => {
    data.services = { ...data.services, ...req.body };
    return data.services;
  });
  res.json({ success: true, data: result });
}));

// ===== Asset Manager =====
// List all uploaded assets from Vercel Blob
app.get('/api/admin/assets', authMiddleware, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!IS_VERCEL || !BLOB_TOKEN) {
      // Local mode: read uploads directory
      const uploadsDir = path.join(__dirname, 'public', 'uploads');
      if (!fs.existsSync(uploadsDir)) return res.json({ assets: [] });
      const files = fs.readdirSync(uploadsDir);
      const assets = files.map(f => {
        const stat = fs.statSync(path.join(uploadsDir, f));
        const ext = path.extname(f).toLowerCase();
        const isVideo = ['.mp4', '.webm', '.mov', '.avi'].includes(ext);
        return {
          url: '/uploads/' + f,
          pathname: 'uploads/' + f,
          size: stat.size,
          uploadedAt: stat.mtime.toISOString(),
          type: isVideo ? 'video' : 'image'
        };
      });
      assets.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      return res.json({ assets });
    }
    // Vercel Blob: list all files with uploads/ prefix
    let allBlobs = [];
    let cursor;
    do {
      const result = await list({ prefix: 'uploads/', token: BLOB_TOKEN, limit: 1000, cursor });
      allBlobs = allBlobs.concat(result.blobs);
      cursor = result.cursor;
    } while (cursor);
    const assets = allBlobs.map(b => {
      const ext = path.extname(b.pathname).toLowerCase();
      const isVideo = ['.mp4', '.webm', '.mov', '.avi'].includes(ext);
      return {
        url: b.url,
        pathname: b.pathname,
        size: b.size,
        uploadedAt: b.uploadedAt,
        type: isVideo ? 'video' : 'image'
      };
    });
    assets.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    res.json({ assets });
  } catch (err) {
    console.error('List assets error:', err);
    res.status(500).json({ error: '获取资源列表失败' });
  }
});

// Delete an asset
app.delete('/api/admin/assets', authMiddleware, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: '缺少 url 参数' });
    if (IS_VERCEL && BLOB_TOKEN) {
      await del(url, { token: BLOB_TOKEN });
    } else {
      // Local mode
      const filename = url.replace('/uploads/', '');
      const filepath = path.join(__dirname, 'public', 'uploads', filename);
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete asset error:', err);
    res.status(500).json({ error: '删除失败' });
  }
});

// ===== Backup & Restore =====
const BACKUP_PREFIX = 'backups/';

// Create a backup (includes data.json + asset URL list, never auth.json)
app.post('/api/admin/backups', authMiddleware, asyncHandler(async (req, res) => {
  const data = await readData();
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const label = req.body.label || '';

  // Collect all uploaded asset URLs from Vercel Blob
  let assets = [];
  if (IS_VERCEL && BLOB_TOKEN) {
    let cursor;
    do {
      const result = await list({ prefix: 'uploads/', token: BLOB_TOKEN, limit: 1000, cursor });
      assets = assets.concat(result.blobs.map(b => ({
        url: b.url,
        pathname: b.pathname,
        size: b.size,
        contentType: b.contentType || '',
        uploadedAt: b.uploadedAt
      })));
      cursor = result.cursor;
    } while (cursor);
  }

  const backupMeta = {
    id: timestamp,
    label: label,
    createdAt: now.toISOString(),
    worksCount: (data.works || []).length,
    assetsCount: assets.length,
    size: 0 // will be calculated below
  };

  const backupContent = { meta: backupMeta, data, assets };
  const backupJSON = JSON.stringify(backupContent, null, 2);
  backupMeta.size = backupJSON.length;
  // Re-serialize with final size
  const finalJSON = JSON.stringify({ ...backupContent, meta: backupMeta }, null, 2);

  if (IS_VERCEL && BLOB_TOKEN) {
    await put(BACKUP_PREFIX + timestamp + '.json', finalJSON, {
      access: 'public',
      token: BLOB_TOKEN,
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true
    });
  } else {
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, timestamp + '.json'), finalJSON);
  }
  res.json({ success: true, backup: backupMeta });
}));

// List all backups
app.get('/api/admin/backups', authMiddleware, asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let backups = [];
  if (IS_VERCEL && BLOB_TOKEN) {
    let allBlobs = [];
    let cursor;
    do {
      const result = await list({ prefix: BACKUP_PREFIX, token: BLOB_TOKEN, limit: 1000, cursor });
      allBlobs = allBlobs.concat(result.blobs);
      cursor = result.cursor;
    } while (cursor);
    // Read meta from each backup
    for (const blob of allBlobs) {
      try {
        const r = await fetch(blob.url + '?t=' + Date.now());
        const content = await r.json();
        backups.push(content.meta);
      } catch (e) {
        // Skip corrupted backups
        backups.push({ id: blob.pathname.replace(BACKUP_PREFIX, '').replace('.json', ''), label: '(损坏)', createdAt: blob.uploadedAt, worksCount: 0, assetsCount: 0, size: blob.size });
      }
    }
  } else {
    const backupDir = path.join(__dirname, 'backups');
    if (fs.existsSync(backupDir)) {
      const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(backupDir, f), 'utf8'));
          backups.push(content.meta);
        } catch (e) {
          backups.push({ id: f.replace('.json', ''), label: '(损坏)', createdAt: '', worksCount: 0, assetsCount: 0, size: 0 });
        }
      }
    }
  }
  backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ backups });
}));

// Restore a backup (restores data.json only; old backups may still contain auth but it is ignored)
app.post('/api/admin/backups/:id/restore', authMiddleware, asyncHandler(async (req, res) => {
  const backupId = req.params.id;
  let backupContent;

  if (IS_VERCEL && BLOB_TOKEN) {
    const { blobs } = await list({ prefix: BACKUP_PREFIX + backupId, token: BLOB_TOKEN });
    if (blobs.length === 0) return res.status(404).json({ error: '备份不存在' });
    const r = await fetch(blobs[0].url + '?t=' + Date.now());
    backupContent = await r.json();
  } else {
    const filepath = path.join(__dirname, 'backups', backupId + '.json');
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: '备份不存在' });
    backupContent = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  }

  if (!backupContent || !backupContent.data) {
    return res.status(400).json({ error: '备份数据损坏' });
  }

  // Auto-backup current state before restoring (full backup including auth & assets)
  const currentData = await readData();
  const autoBackupTimestamp = new Date().toISOString().replace(/[:.]/g, '-');

  let currentAssets = [];
  if (IS_VERCEL && BLOB_TOKEN) {
    let cursor;
    do {
      const result = await list({ prefix: 'uploads/', token: BLOB_TOKEN, limit: 1000, cursor });
      currentAssets = currentAssets.concat(result.blobs.map(b => ({
        url: b.url, pathname: b.pathname, size: b.size,
        contentType: b.contentType || '', uploadedAt: b.uploadedAt
      })));
      cursor = result.cursor;
    } while (cursor);
  }

  const autoBackupContent = {
    meta: {
      id: autoBackupTimestamp, label: '恢复前自动备份',
      createdAt: new Date().toISOString(),
      worksCount: (currentData.works || []).length,
      assetsCount: currentAssets.length,
      size: 0
    },
    data: currentData, assets: currentAssets
  };
  const autoJSON = JSON.stringify(autoBackupContent, null, 2);
  autoBackupContent.meta.size = autoJSON.length;
  const autoFinalJSON = JSON.stringify(autoBackupContent, null, 2);

  if (IS_VERCEL && BLOB_TOKEN) {
    await put(BACKUP_PREFIX + autoBackupTimestamp + '.json', autoFinalJSON, {
      access: 'public', token: BLOB_TOKEN, contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true
    });
  } else {
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, autoBackupTimestamp + '.json'), autoFinalJSON);
  }

  // Restore data.json
  await writeData(backupContent.data);

  // Report on asset status
  let assetWarning = '';
  if (backupContent.assets && backupContent.assets.length > 0) {
    assetWarning = `（备份中包含 ${backupContent.assets.length} 个资源文件记录，数据已恢复）`;
  }

  res.json({ success: true, message: '恢复成功，已自动备份恢复前的数据' + assetWarning });
}));

// Delete a backup
app.delete('/api/admin/backups/:id', authMiddleware, async (req, res) => {
  try {
    const backupId = req.params.id;
    if (IS_VERCEL && BLOB_TOKEN) {
      const { blobs } = await list({ prefix: BACKUP_PREFIX + backupId, token: BLOB_TOKEN });
      if (blobs.length > 0) {
        await del(blobs.map(b => b.url), { token: BLOB_TOKEN });
      }
    } else {
      const filepath = path.join(__dirname, 'backups', backupId + '.json');
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete backup error:', err);
    res.status(500).json({ error: '删除失败' });
  }
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

// Global error handler - catches unhandled async errors and returns appropriate status
app.use((err, req, res, next) => {
  if (!res.headersSent) {
    // Handle custom status errors thrown from safeUpdateData
    if (err.status && err.error) {
      return res.status(err.status).json({ error: err.error });
    }
    console.error('Unhandled error:', err.message || err);
    res.status(500).json({ success: false, error: err.message || '服务器内部错误' });
  }
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
