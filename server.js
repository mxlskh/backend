const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/api/file', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const mime = file.mimetype;
    let text = '';
    let correctedUrl = null;

    if (mime.startsWith('image/')) {
      // 1. Анализ изображения через GPT-4 Vision
      const imgData = fs.readFileSync(file.path);
      const base64 = imgData.toString('base64');
      const visionResp = await openai.chat.completions.create({
        model: 'gpt-4-vision-preview',
        messages: [
          { role: 'system', content: 'Опиши изображение и исправь ошибки, если есть текст.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Что на этом изображении? Исправь ошибки в тексте, если они есть.' },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
            ]
          }
        ],
        max_tokens: 500
      });
      text = visionResp.choices[0]?.message?.content || '';

      // 2. Генерация исправленного изображения через DALL-E 3
      if (text) {
        const dalleResp = await openai.images.generate({
          model: 'dall-e-3',
          prompt: `Сгенерируй изображение с текстом: "${text}". Используй стиль оригинального изображения.`,
          n: 1,
          size: '1024x1024'
        });
        const dalleUrl = dalleResp.data[0]?.url;
        if (dalleUrl) {
          const imgRes = await fetch(dalleUrl);
          const buffer = await imgRes.arrayBuffer();
          const correctedName = 'corrected-' + Date.now() + '.png';
          const correctedPath = path.join(UPLOADS_DIR, correctedName);
          fs.writeFileSync(correctedPath, Buffer.from(buffer));
          correctedUrl = `/uploads/${correctedName}`;
        }
      }
    } else if (mime === 'text/plain') {
      text = fs.readFileSync(file.path, 'utf8');
      const gptResp = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'Исправь ошибки и отредактируй текст.' },
          { role: 'user', content: text }
        ],
        max_tokens: 2000
      });
      const correctedText = gptResp.choices[0]?.message?.content || '';
      const ext = path.extname(file.originalname) || '.txt';
      const correctedName = 'corrected-' + Date.now() + ext;
      const correctedPath = path.join(UPLOADS_DIR, correctedName);
      fs.writeFileSync(correctedPath, correctedText, 'utf8');
      correctedUrl = `/uploads/${correctedName}`;
    }

    res.json({
      url: `/uploads/${file.filename}`,
      fileName: file.originalname,
      fileType: mime,
      text,
      correctedUrl: correctedUrl ? correctedUrl : undefined
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка при обработке файла' });
  }
});

app.use('/uploads', express.static(UPLOADS_DIR));
app.get('/', (req, res) => res.send('File AI backend is running!'));
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));