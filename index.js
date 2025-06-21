const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execAsync = promisify(exec);
const app = express();

const config = {
  PORT: process.env.PORT || 8080,
  DOWNLOADS_DIR: process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp/downloads',
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  RATE_LIMIT: { WINDOW_MS: 60000, MAX: 10 },
  FILE_RETENTION_MS: 1800000,
  DOWNLOAD_TIMEOUT: 3600000
};

const activeDownloads = new Set();
const rateLimitMap = new Map();

const initializeSystem = () => {
  if (!fs.existsSync(config.DOWNLOADS_DIR)) {
    fs.mkdirSync(config.DOWNLOADS_DIR, { recursive: true, mode: 0o777 });
  }
  setInterval(() => rateLimitMap.clear(), config.RATE_LIMIT.WINDOW_MS);
  setInterval(cleanupOldFiles, config.FILE_RETENTION_MS);
  cleanupOldFiles();
};

const cleanupFile = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error('Cleanup error:', err);
  }
};

const cleanupOldFiles = () => {
  if (!fs.existsSync(config.DOWNLOADS_DIR)) return;

  fs.readdir(config.DOWNLOADS_DIR, (err, files) => {
    if (err) return;
    
    const now = Date.now();
    files.forEach(file => {
      const filePath = path.join(config.DOWNLOADS_DIR, file);
      if (activeDownloads.has(filePath)) return;

      fs.stat(filePath, (err, stats) => {
        if (!err && now - stats.mtimeMs > config.FILE_RETENTION_MS) {
          cleanupFile(filePath);
        }
      });
    });
  });
};

const downloadVideo = async (url, res) => {
  const fileId = Date.now();
  const outputPath = path.join(config.DOWNLOADS_DIR, `${fileId}.mp4`);
  const command = `yt-dlp --no-warnings -f bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best -o ${outputPath} ${url}`;

  try {
    const process = exec(command, { timeout: config.DOWNLOAD_TIMEOUT });

    process.on('exit', (code) => {
      if (code !== 0) {
        cleanupFile(outputPath);
        if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
        return;
      }

      activeDownloads.add(outputPath);
      const stats = fs.statSync(outputPath);
      res.setHeader('Content-Disposition', `attachment; filename="video_${fileId}.mp4"`);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', stats.size);

      const stream = fs.createReadStream(outputPath);
      stream.on('end', () => {
        activeDownloads.delete(outputPath);
        setTimeout(() => cleanupFile(outputPath), 60000);
      });
      stream.pipe(res);
    });

  } catch (error) {
    cleanupFile(outputPath);
    if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
  }
};

app.use(cors({ origin: config.ALLOWED_ORIGINS }));
app.use(express.json());

app.post('/download', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const count = (rateLimitMap.get(ip) || 0) + 1;
  rateLimitMap.set(ip, count);
  if (count > config.RATE_LIMIT.MAX) return res.status(429).json({ error: 'Too many requests' });

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    new URL(url);
    await downloadVideo(url, res);
  } catch {
    res.status(400).json({ error: 'Invalid URL' });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    downloadsDir: config.DOWNLOADS_DIR,
    freeSpace: fs.statSync(config.DOWNLOADS_DIR).size
  });
});

const startServer = async () => {
  try {
    await execAsync('yt-dlp --version');
    initializeSystem();
    app.listen(config.PORT, () => {
      console.log(`Server running on port ${config.PORT}`);
    });
  } catch (error) {
    console.error('yt-dlp not found. Please install it.');
    process.exit(1);
  }
};

startServer();
