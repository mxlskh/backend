import express from 'express';
import multer from 'multer';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { OpenAI } from 'openai';
import fetch from 'node-fetch';
import { PDFExtract } from 'pdf.js-extract';
import { PDFDocument } from 'pdf-lib';
import dotenv from 'dotenv';
import { encode, decode } from 'gpt-3-encoder';
import { Readable } from 'stream';
import config from './config.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Настройка CORS
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? [process.env.RAILWAY_URL, 'http://localhost:3001'] 
    : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pdfExtract = new PDFExtract();

// Функция для разбиения текста на части по токенам (точно)
function splitTextIntoChunks(text, maxTokens = 6000) {
  const tokens = encode(text);
  const chunks = [];
  for (let i = 0; i < tokens.length; i += maxTokens) {
    const chunk = tokens.slice(i, i + maxTokens);
    chunks.push(decode(chunk));
  }
  return chunks;
}

// Функция для ожидания с экспоненциальной задержкой
async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Функция для обработки текста через GPT с повторными попытками
async function processTextWithGPT(text, prompt, model = 'gpt-4', maxRetries = 3) {
  const chunks = splitTextIntoChunks(text);
  let results = [];
  let retryCount = 0;
  let baseDelay = 1000; // Начальная задержка 1 секунда
  
  for (const chunk of chunks) {
    let success = false;
    while (!success && retryCount < maxRetries) {
      try {
        const gptResp = await openai.chat.completions.create({
          model: model,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: chunk }
          ],
          max_tokens: 1000
        });
        
        results.push(gptResp.choices[0]?.message?.content || '');
        success = true;
        
        // Добавляем небольшую задержку между успешными запросами
        await wait(1000);
      } catch (error) {
        if (error.code === 'rate_limit_exceeded') {
          retryCount++;
          const delay = baseDelay * Math.pow(2, retryCount - 1); // Экспоненциальная задержка
          console.log(`Rate limit hit, retrying in ${delay}ms (attempt ${retryCount}/${maxRetries})`);
          await wait(delay);
        } else {
          throw error; // Если ошибка не связана с лимитом, пробрасываем её дальше
        }
      }
    }
    
    if (!success) {
      throw new Error(`Failed to process chunk after ${maxRetries} retries`);
    }
  }
  
  return results.join('\n\n');
}

// Генерация изображения через DALL-E
app.post('/api/generate-image', async (req, res) => {
  try {
    const { prompt } = req.body;
    console.log('DALL-E request:', { prompt });

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Перевод prompt на английский через OpenAI GPT-3.5
    let promptEn = prompt;
    try {
      // Проверяем, есть ли русские буквы
      if (/[а-яА-ЯёЁ]/.test(prompt)) {
        const translation = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            { role: 'system', content: 'Переведи на английский для генерации изображения в DALL-E, без лишних пояснений.' },
            { role: 'user', content: prompt }
          ],
          max_tokens: 100,
        });
        const translated = translation.choices[0]?.message?.content?.trim();
        if (translated) promptEn = translated;
        console.log('Prompt translated to EN:', promptEn);
      }
    } catch (e) {
      console.error('Prompt translation error:', e);
      // fallback: используем оригинальный prompt
    }

    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: promptEn,
      n: 1,
      size: "1024x1024",
      quality: "standard",
      style: "natural"
    });

    console.log('DALL-E response:', response);
    
    // Скачиваем и сохраняем изображение
    const dalleUrl = response.data[0]?.url;
    if (dalleUrl) {
      const imgRes = await fetch(dalleUrl);
      if (!imgRes.ok) {
        throw new Error('Failed to download generated image');
      }
      const buffer = await imgRes.arrayBuffer();
      const imgName = 'generated-' + Date.now() + '.png';
      const imgPath = path.join(UPLOADS_DIR, imgName);
      fs.writeFileSync(imgPath, Buffer.from(buffer));
      
      res.json({ 
        imageUrl: `/uploads/${imgName}`,
        dalleUrl
      });
    } else {
      throw new Error('No URL in DALL-E response');
    }
  } catch (error) {
    console.error('DALL-E Error:', error);
    res.status(500).json({ 
      error: 'Ошибка при генерации изображения',
      details: error.message
    });
  }
});

// Обработка файлов
app.post('/api/file', upload.single('file'), async (req, res) => {
  try {
    console.log('POST /api/file', req.file);
    if (!req.file) {
      console.error('No file uploaded!');
      return res.status(400).json({ error: 'No file uploaded' });
    }
    res.json({
      fileId: req.file.filename,
      url: `/uploads/${req.file.filename}`,
      name: req.file.originalname,
      type: req.file.mimetype
    });
  } catch (e) {
    console.error('Ошибка при сохранении файла:', e);
    res.status(500).json({ error: 'Ошибка при сохранении файла', details: e.message });
  }
});

// Обработка действий с файлами
app.post('/api/file/action', async (req, res) => {
  try {
    const { fileId, action, prompt } = req.body;
    if (!fileId && !(action === 'custom' && prompt)) {
      return res.status(400).json({ error: 'fileId and action are required' });
    }

    const filePath = path.join(UPLOADS_DIR, fileId);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const ext = path.extname(filePath).toLowerCase();
    let result = {};

    if (ext === '.pdf') {
      try {
        const dataBuffer = fs.readFileSync(filePath);
        const pdfData = await pdfExtract.extractBuffer(dataBuffer);
        const originalText = pdfData.pages.map(page => page.content.map(item => item.str).join(' ')).join('\n');

        if (!originalText.trim()) {
          return res.status(400).json({ error: 'Не удалось извлечь текст из PDF' });
        }

        let gptPrompt = '';
        if (action === 'fix') gptPrompt = 'Исправь ошибки в тексте.';
        else if (action === 'translate') gptPrompt = prompt || 'Переведи текст на английский.';
        else if (action === 'analyze') gptPrompt = prompt || 'Проанализируй текст и дай краткое резюме.';
        else if (action === 'custom') gptPrompt = prompt || '';
        else return res.status(400).json({ error: 'Unknown action' });

        const gptText = await processTextWithGPT(originalText, gptPrompt);

        if (action === 'analyze') {
          result = { analysis: gptText };
        } else {
          const pdfDoc = await PDFDocument.create();
          const page = pdfDoc.addPage();
          const fontSize = 12;
          const { width, height } = page.getSize();
          const lines = gptText.split('\n');
          let y = height - 40;
          
          for (const line of lines) {
            page.drawText(line, { x: 40, y, size: fontSize });
            y -= fontSize + 4;
            if (y < 40) {
              y = height - 40;
              pdfDoc.addPage();
            }
          }

          const pdfBytes = await pdfDoc.save();
          const newPdfName = fileId.replace(ext, '') + `_${action}` + ext;
          const newPdfPath = path.join(UPLOADS_DIR, newPdfName);
          fs.writeFileSync(newPdfPath, pdfBytes);
          
          result = {
            [`${action}Url`]: `/uploads/${newPdfName}`,
            text: gptText
          };
        }
      } catch (error) {
        console.error('PDF processing error:', error);
        return res.status(500).json({ 
          error: 'Ошибка при обработке PDF',
          details: error.message
        });
      }
    } else {
      // Обработка текстовых файлов
      const content = fs.readFileSync(filePath, 'utf8');
      let gptPrompt = '';
      
      if (action === 'fix') gptPrompt = 'Исправь ошибки в тексте.';
      else if (action === 'translate') gptPrompt = prompt || 'Переведи текст на английский.';
      else if (action === 'analyze') gptPrompt = prompt || 'Проанализируй текст и дай краткое резюме.';
      else if (action === 'custom') gptPrompt = prompt || '';
      else return res.status(400).json({ error: 'Unknown action' });

      const gptText = await processTextWithGPT(content, gptPrompt);

      if (action === 'analyze') {
        result = { analysis: gptText };
      } else {
        const newFileName = fileId.replace(ext, '') + `_${action}` + ext;
        const newFilePath = path.join(UPLOADS_DIR, newFileName);
        fs.writeFileSync(newFilePath, gptText, 'utf8');
        
        result = {
          [`${action}Url`]: `/uploads/${newFileName}`,
          text: gptText
        };
      }
    }

    res.json(result);
  } catch (error) {
    console.error('File action error:', error);
    res.status(500).json({ 
      error: 'Ошибка при обработке файла',
      details: error.message
    });
  }
});

// === TTS endpoint (OpenAI) ===
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice = 'alloy' } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Text is required' });
    }
    if (text.length > 4096) {
      return res.status(400).json({ error: 'Text too long (max 4096 chars)' });
    }
    const allowedVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
    const selectedVoice = allowedVoices.includes(voice.toLowerCase()) ? voice.toLowerCase() : 'alloy';
    const response = await openai.audio.speech.create({
      model: 'tts-1',
      input: text,
      voice: selectedVoice,
      response_format: 'mp3'
    });
    const fileName = `tts-${Date.now()}.mp3`;
    const filePath = path.join(UPLOADS_DIR, fileName);
    const stream = response.body;
    const fileStream = fs.createWriteStream(filePath);
    await new Promise((resolve, reject) => {
      stream.pipe(fileStream);
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    res.json({ url: `/uploads/${fileName}` });
  } catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({ error: 'Ошибка при генерации озвучки', details: error.message });
  }
});

// Поиск изображений через DuckDuckGo (прокси)
app.get('/api/search-images', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'Query is required' });
    }
    console.log('[DuckDuckGo] Поиск изображений:', query);
    // Получаем vqd
    const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`;
    const resp = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/html',
      },
    });
    if (!resp.ok) return res.status(500).json({ error: 'Failed to get vqd' });
    const html = await resp.text();
    const match = html.match(/vqd=['"]([^'"]+)['"]/);
    const vqd = match ? match[1] : null;
    if (!vqd) return res.status(500).json({ error: 'Failed to extract vqd' });
    // Получаем картинки
    const apiUrl = `https://duckduckgo.com/i.js?l=ru-ru&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}`;
    const imgResp = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
    });
    if (!imgResp.ok) return res.status(500).json({ error: 'DuckDuckGo returned error' });
    const json = await imgResp.json();
    const results = json.results || [];
    const urls = results
      .map(r => r.image)
      .filter(u => typeof u === 'string' && u.startsWith('https://'))
      .slice(0, 3);
    console.log('[DuckDuckGo] Найдено url:', urls);
    res.json({ urls });
  } catch (error) {
    console.error('[DuckDuckGo] Ошибка поиска:', error);
    res.status(500).json({ error: 'Ошибка при поиске изображений', details: error.message });
  }
});

app.use('/uploads', express.static(UPLOADS_DIR));
app.get('/', (req, res) => res.send('File AI backend is running!'));
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));