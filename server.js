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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pdfExtract = new PDFExtract();

// Функция для разбиения текста на части по токенам
function splitTextIntoChunks(text, maxTokens = 4000) {
  // Примерная оценка: 1 токен ≈ 4 символа
  const charsPerChunk = maxTokens * 4;
  const chunks = [];
  let currentChunk = '';
  
  // Разбиваем текст на предложения
  const sentences = text.split(/(?<=[.!?])\s+/);
  
  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > charsPerChunk) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      // Если предложение слишком длинное, разбиваем его
      if (sentence.length > charsPerChunk) {
        const words = sentence.split(/\s+/);
        let tempChunk = '';
        for (const word of words) {
          if ((tempChunk + word).length > charsPerChunk) {
            chunks.push(tempChunk.trim());
            tempChunk = word;
          } else {
            tempChunk += (tempChunk ? ' ' : '') + word;
          }
        }
        if (tempChunk) {
          currentChunk = tempChunk;
        }
      } else {
        currentChunk = sentence;
      }
    } else {
      currentChunk += (currentChunk ? ' ' : '') + sentence;
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk.trim());
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
          max_tokens: 2000
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

    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: prompt,
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
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({
      fileId: file.filename,
      url: `/uploads/${file.filename}`,
      name: file.originalname,
      type: file.mimetype
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка при сохранении файла' });
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

app.use('/uploads', express.static(UPLOADS_DIR));
app.get('/', (req, res) => res.send('File AI backend is running!'));
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));