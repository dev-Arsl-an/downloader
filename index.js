const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execAsync = promisify(exec);
const app = express();

const MAX_DOWNLOAD_SIZE = '10G';
const DOWNLOAD_TIMEOUT = 3600000;
const STREAM_BUFFER_SIZE = 1024 * 1024 * 50;

const sanitizeFilename = (filename) => {
  return filename
    .replace(/[^\w\s\-_.()[\]]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 100);
};

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true
}));

app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => {
    try {
      JSON.parse(buf.toString());
    } catch (e) {
      throw new Error('Invalid JSON');
    }
  }
}));

const downloadsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'downloads') || '/tmp/downloads';
try {
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true, mode: 0o777 });
  }
  fs.chmodSync(downloadsDir, 0o777);
  console.log(`✅ Downloads directory ready: ${downloadsDir}`);
} catch (error) {
  console.error('❌ Failed to setup downloads directory:', error);
  process.exit(1);
}

const rateLimitMap = new Map();
const RATE_LIMIT = { WINDOW: 60000, MAX: 10 };
setInterval(() => rateLimitMap.clear(), RATE_LIMIT.WINDOW);

const rateLimitMiddleware = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const count = (rateLimitMap.get(ip) || 0) + 1;
  rateLimitMap.set(ip, count);
  if (count > RATE_LIMIT.MAX) {
    return res.status(429).json({ success: false, message: 'Too many requests' });
  }
  next();
};

const isValidUrl = (url) => {
  try { new URL(url); return true; } catch { return false; }
};

const isSupportedDomain = (url) => {
  const supported = ['youtube.com', 'youtu.be', 'tiktok.com', 'vm.tiktok.com', 'instagram.com', 'facebook.com'];
  try {
    const hostname = new URL(url).hostname;
    return supported.some(domain => hostname.includes(domain));
  } catch { return false; }
};

let ytDlpCommand = 'yt-dlp';
const detectYtDlp = async () => {
  const commands = ['yt-dlp --version', 'python3 -m yt_dlp --version', 'python -m yt_dlp --version'];
  for (const cmd of commands) {
    try {
      const { stdout } = await execAsync(cmd, { timeout: 5000 });
      ytDlpCommand = cmd.split(' ')[0];
      console.log(`✅ Using ${ytDlpCommand} (version: ${stdout.trim()})`);
      return;
    } catch {}
  }
  console.error('❌ No working yt-dlp installation found');
  process.exit(1);
};

const downloadVideo = async (url, res) => {
  const id = Date.now();
  const outputPath = path.join(downloadsDir, `dl_${id}.mp4`);

  const command = [
    ytDlpCommand,
    '--no-playlist',
    '--no-warnings',
    '--ignore-errors',
    '--buffer-size', STREAM_BUFFER_SIZE,
    '--socket-timeout', '60',
    '--retries', '10',
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '-o', outputPath,
    url
  ].join(' ');

  console.log(`🔧 Executing: ${command}`);

  try {
    const { stdout, stderr } = await execAsync(command, { timeout: DOWNLOAD_TIMEOUT, maxBuffer: Infinity });
    console.log('✅ Download completed:', stdout);
    
    // ✅ Instead of streaming file directly, return file path info so frontend can fetch/download it later
    res.json({
      success: true,
      downloadUrl: `/files/${path.basename(outputPath)}`,
      title: `Downloaded Video`,
      thumbnail: '' // (optional: implement thumbnail logic)
    });

  } catch (error) {
    console.error('Download error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download failed' });
    }
  }
};

// Serve downloaded files as static
app.use('/files', express.static(downloadsDir));

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.post('/download', rateLimitMiddleware, async (req, res) => {
  const { url } = req.body;
  if (!url || !isValidUrl(url)) return res.status(400).json({ error: 'Invalid URL' });
  if (!isSupportedDomain(url)) return res.status(400).json({ error: 'Unsupported domain' });

  console.log(`📥 Starting download: ${url}`);
  await downloadVideo(url, res);
});

const startServer = async () => {
  await detectYtDlp();
  const PORT = process.env.PORT || 8080;
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
  server.timeout = DOWNLOAD_TIMEOUT;
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
};

startServer().catch(error => {
  console.error('❌ Server failed to start:', error);
  process.exit(1);
});
