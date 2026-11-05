const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const IG_USER_ID = process.env.IG_USER_ID || '';
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN || '';
const PUBLIC_URL = process.env.PUBLIC_URL || '';

const DATA_FILE = path.join(__dirname, 'posts.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function readPosts() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}
function writePosts(posts) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(posts, null, 2));
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(8).toString('hex') + '.jpg')
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/jpeg') return cb(null, true);
    cb(new Error('सिर्फ़ JPEG (.jpg) इमेज चलेगी'));
  }
});

app.use(express.json());

// Instagram को इमेज का पब्लिक URL चाहिए, इसलिए /uploads खुला रहता है
app.use('/uploads', express.static(UPLOADS_DIR));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// पासवर्ड सुरक्षा: बिना पासवर्ड कोई पोस्ट या API इस्तेमाल नहीं कर सकता
app.use('/api', (req, res, next) => {
  if (!APP_PASSWORD) return res.status(500).json({ error: 'APP_PASSWORD सेट नहीं है' });
  if (req.get('x-app-password') !== APP_PASSWORD) {
    return res.status(401).json({ error: 'गलत पासवर्ड' });
  }
  next();
});

app.post('/api/caption', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY सेट नहीं है');
    const { topic, style } = req.body;
    if (!topic) throw new Error('टॉपिक लिखें');
    const prompt =
      `Instagram पोस्ट के लिए कैप्शन लिखो।\nटॉपिक: ${topic}\nस्टाइल: ${style || 'दिल को छूने वाला, हिंदी/हिंग्लिश'}\n` +
      `नियम: 2-3 छोटी लाइनें, फिर 3-5 हैशटैग। सिर्फ़ कैप्शन लिखो, और कुछ नहीं।`;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5-5',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || 'Claude API error');
    const caption = (data.content || []).map(b => b.text || '').join('').trim();
    res.json({ caption });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/posts', (req, res) => {
  res.json(readPosts().reverse());
});

app.post('/api/posts', (req, res, next) => {
  upload.single('image')(req, res, err => (err ? res.status(400).json({ error: err.message }) : next()));
}, async (req, res) => {
  try {
    if (!req.file) throw new Error('इमेज चुनें');
    const base = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    const post = {
      id: crypto.randomBytes(6).toString('hex'),
      caption: req.body.caption || '',
      imageUrl: `${base}/uploads/${req.file.filename}`,
      scheduledAt: req.body.scheduledAt || null,
      status: 'scheduled',
      createdAt: new Date().toISOString()
    };
    const posts = readPosts();
    posts.push(post);
    writePosts(posts);
    if (!post.scheduledAt) await publishPost(post.id);
    res.json(readPosts().find(p => p.id === post.id));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/posts/:id', (req, res) => {
  writePosts(readPosts().filter(p => p.id !== req.params.id));
  res.json({ ok: true });
});

async function publishPost(id) {
  const posts = readPosts();
  const post = posts.find(p => p.id === id);
  if (!post || post.status === 'posted') return;
  try {
    if (!IG_USER_ID || !IG_ACCESS_TOKEN) throw new Error('IG_USER_ID / IG_ACCESS_TOKEN सेट नहीं हैं');
    const g = 'https://graph.facebook.com/v21.0';
    const create = await fetch(`${g}/${IG_USER_ID}/media`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image_url: post.imageUrl, caption: post.caption, access_token: IG_ACCESS_TOKEN })
    });
    const c = await create.json();
    if (!create.ok) throw new Error(c.error?.message || 'media बनाने में दिक्कत');
    const pub = await fetch(`${g}/${IG_USER_ID}/media_publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ creation_id: c.id, access_token: IG_ACCESS_TOKEN })
    });
    const p = await pub.json();
    if (!pub.ok) throw new Error(p.error?.message || 'पब्लिश में दिक्कत');
    post.status = 'posted';
    post.postedAt = new Date().toISOString();
    delete post.error;
  } catch (e) {
    post.status = 'failed';
    post.error = e.message;
  }
  writePosts(posts);
}

// हर 30 सेकंड में देखो कि किसी शेड्यूल्ड पोस्ट का समय आ गया या नहीं
setInterval(async () => {
  const due = readPosts().filter(
    p => p.status === 'scheduled' && p.scheduledAt && new Date(p.scheduledAt) <= new Date()
  );
  for (const p of due) await publishPost(p.id);
}, 30000);

app.listen(PORT, () => console.log(`Server चालू है, पोर्ट ${PORT}`));
