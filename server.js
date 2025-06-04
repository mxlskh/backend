const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const pdfParse = require('pdf-parse');
const { PDFDocument } = require('pdf-lib');
require('dotenv').config();

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

// Новый endpoint для обработки файла по действию пользователя
app.post('/api/file/action', async (req, res) => {
  try {
    const { fileId, action, prompt } = req.body;
    if (!fileId && !(action === 'custom' && prompt)) {
      return res.status(400).json({ error: 'fileId and action are required' });
    }
    // --- Генерация изображения по prompt ---
    const promptText = (prompt || '').toLowerCase();
    const isImageGen = /сгенерируй фото|создай картинк|generate image|create image|создай изображен|generate picture/.test(promptText);
    
    console.log('Image request:', { promptText, isImageGen, prompt });
    
    if (isImageGen) {
      try {
        // Проверяем, что prompt не пустой
        if (!prompt || prompt.trim().length < 3) {
          console.error('Empty or too short prompt:', prompt);
          return res.status(400).json({ 
            error: 'Неверный запрос',
            details: 'Описание изображения слишком короткое или пустое'
          });
        }

        // Генерация изображения через DALL-E
        console.log('Calling DALL-E with prompt:', prompt);
        const dalleResp = await openai.images.generate({
          model: 'dall-e-3',
          prompt: prompt,
          n: 1,
          size: '1024x1024'
        });
        
        // Логируем полный ответ от DALL-E для отладки
        console.log('DALL-E Response:', JSON.stringify(dalleResp, null, 2));
        
        const dalleUrl = dalleResp.data[0]?.url;
        if (dalleUrl) {
          console.log('DALL-E URL received:', dalleUrl);
          // Скачиваем и сохраняем изображение
          const imgRes = await fetch(dalleUrl);
          if (!imgRes.ok) {
            console.error('Failed to download image:', imgRes.status, imgRes.statusText);
            return res.status(500).json({ 
              error: 'Ошибка при сохранении изображения',
              details: 'Не удалось скачать сгенерированное изображение'
            });
          }
          const buffer = await imgRes.arrayBuffer();
          const imgName = 'generated-' + Date.now() + '.png';
          const imgPath = path.join(__dirname, 'uploads', imgName);
          fs.writeFileSync(imgPath, Buffer.from(buffer));
          console.log('Image saved:', imgPath);
          return res.json({ 
            imageUrl: `/uploads/${imgName}`, 
            dalleUrl,
            dalleResponse: dalleResp // Временно включаем полный ответ для отладки
          });
        } else {
          console.error('DALL-E Error: No URL in response', dalleResp);
          return res.status(500).json({ 
            error: 'Не удалось сгенерировать изображение',
            details: 'DALL-E не вернул URL изображения'
          });
        }
      } catch (error) {
        console.error('DALL-E Error:', error);
        console.error('Error details:', {
          message: error.message,
          status: error.response?.status,
          data: error.response?.data
        });
        
        // Определяем тип ошибки и возвращаем понятное сообщение
        let errorMessage = 'Ошибка при генерации изображения';
        let errorDetails = error.message || 'Неизвестная ошибка';
        
        if (error.response?.status === 429) {
          errorMessage = 'Превышен лимит запросов к DALL-E';
          errorDetails = 'Пожалуйста, подождите немного и попробуйте снова';
        } else if (error.response?.status === 400) {
          errorMessage = 'Запрос отклонён';
          errorDetails = 'Пожалуйста, измените описание изображения';
        } else if (error.message?.includes('content_policy')) {
          errorMessage = 'Запрос отклонён модерацией';
          errorDetails = 'Описание изображения нарушает правила использования';
        }
        
        return res.status(500).json({ 
          error: errorMessage,
          details: errorDetails,
          fullError: error // Временно включаем полную ошибку для отладки
        });
      }
    }
    const uploadsDir = path.join(__dirname, 'uploads');
    const filePath = path.join(uploadsDir, fileId);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = (ext === '.pdf') ? 'application/pdf' : '';
    let result = {};
    if (ext === '.pdf') {
      // --- PDF обработка ---
      const dataBuffer = fs.readFileSync(filePath);
      const pdfData = await pdfParse(dataBuffer);
      const originalText = pdfData.text;
      if (!originalText.trim()) {
        return res.status(400).json({ error: 'Не удалось извлечь текст из PDF' });
      }
      let gptPrompt = '';
      if (action === 'fix') gptPrompt = 'Исправь ошибки в тексте.';
      else if (action === 'translate') gptPrompt = prompt || 'Переведи текст на английский.';
      else if (action === 'analyze') gptPrompt = prompt || 'Проанализируй текст и дай краткое резюме.';
      else if (action === 'custom') gptPrompt = prompt || '';
      else return res.status(400).json({ error: 'Unknown action' });
      const gptResp = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: gptPrompt },
          { role: 'user', content: originalText }
        ],
        max_tokens: 2000
      });
      const gptText = gptResp.choices[0]?.message?.content || '';
      if (action === 'analyze') {
        result = { analysis: gptText };
      } else {
        // Генерируем новый PDF с gptText
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
        const newPdfPath = path.join(uploadsDir, newPdfName);
        fs.writeFileSync(newPdfPath, pdfBytes);
        result = {
          [`${action}Url`]: `/uploads/${newPdfName}`,
          text: gptText
        };
      }
    } else {
      // --- Старый код для текстовых файлов ---
      if (action === 'fix') {
        const content = fs.readFileSync(filePath, 'utf8');
        const fixed = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'Исправь ошибки в тексте.' },
            { role: 'user', content: content }
          ]
        });
        const fixedText = fixed.choices[0].message.content;
        const fixedFileName = fileId.replace(ext, '') + '_fixed' + ext;
        const fixedFilePath = path.join(uploadsDir, fixedFileName);
        fs.writeFileSync(fixedFilePath, fixedText, 'utf8');
        result = {
          correctedUrl: `/uploads/${fixedFileName}`,
          text: fixedText
        };
      } else if (action === 'translate') {
        const content = fs.readFileSync(filePath, 'utf8');
        const translation = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: prompt || 'Переведи текст на английский.' },
            { role: 'user', content: content }
          ]
        });
        const translatedText = translation.choices[0].message.content;
        const translatedFileName = fileId.replace(ext, '') + '_translated' + ext;
        const translatedFilePath = path.join(uploadsDir, translatedFileName);
        fs.writeFileSync(translatedFilePath, translatedText, 'utf8');
        result = {
          translatedUrl: `/uploads/${translatedFileName}`,
          text: translatedText
        };
      } else if (action === 'analyze') {
        const content = fs.readFileSync(filePath, 'utf8');
        const analysis = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: prompt || 'Проанализируй текст и дай краткое резюме.' },
            { role: 'user', content: content }
          ]
        });
        const analysisText = analysis.choices[0].message.content;
        result = {
          analysis: analysisText
        };
      } else {
        return res.status(400).json({ error: 'Unknown action' });
      }
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process file action' });
  }
});

app.use('/uploads', express.static(UPLOADS_DIR));
app.get('/', (req, res) => res.send('File AI backend is running!'));
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));