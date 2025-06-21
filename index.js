const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execAsync = promisify(exec);
const app = express();

// ======================
// Configuration
// ======================
const config = {
  PORT: process.env.PORT || 8080,
  MAX_DOWNLOAD_SIZE: '10G',
  DOWNLOAD_TIMEOUT: 3600000, // 1 hour
  STREAM_BUFFER_SIZE: '50M',
  DOWNLOADS_DIR: process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'downloads'),
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  RATE_LIMIT: {
    WINDOW: 60000, // 1 minute
    MAX_REQUESTS: 10
  },
  FILE_CLEANUP_INTERVAL: 3600000, // 1 hour
  FILE_RETENTION_TIME: 3600000 // 1 hour
};

// ======================
// System Initialization
// ======================
const initializeSystem = () => {
  // Ensure downloads directory exists
  if (!fs.existsSync(config.DOWNLOADS_DIR)) {
    fs.mkdirSync(config.DOWNLOADS_DIR, { recursive: true });
    console.log(`✅ Created downloads directory: ${config.DOWNLOADS_DIR}`);
  }

  // Set directory permissions
  try {
    fs.chmodSync(config.DOWNLOADS_DIR, 0o777);
    console.log(`✅ Set permissions for downloads directory`);
  } catch (error) {
    console.error('❌ Failed to set directory permissions:', error);
  }
};

// ======================
// Middleware
// ======================
app.use(cors({
  origin: config.ALLOWED_ORIGINS,
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

// Rate limiting
const rateLimitMap = new Map();
setInterval(() => rateLimitMap.clear(), config.RATE_LIMIT.WINDOW);

const rateLimiter = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const count = (rateLimitMap.get(ip) || 0) + 1;
  
  rateLimitMap.set(ip, count);
  
  if (count > config.RATE_LIMIT.MAX_REQUESTS) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  
  next();
};

// ======================
// Utility Functions
// ======================
const isValidUrl = (url) => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

const isSupportedPlatform = (url) => {
  const supportedDomains = [
    'youtube.com', 'youtu.be',
    'instagram.com', 'facebook.com',
    'tiktok.com', 'vm.tiktok.com'
  ];

  try {
    const { hostname } = new URL(url);
    return supportedDomains.some(domain => hostname.includes(domain));
  } catch {
    return false;
  }
};

const sanitizeFilename = (filename) => {
  return filename
    .replace(/[^\w\s\-_.()[\]]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 100);
};

// ======================
// Download Management
// ======================
const activeDownloads = new Set();

const cleanupFile = (filePath) => {
  if (fs.existsSync(filePath) {
    fs.unlink(filePath, (err) => {
      if (err) {
        console.error('❌ Failed to delete file:', filePath, err);
      } else {
        console.log(`🗑️ Deleted file: ${path.basename(filePath)}`);
      }
    });
  }
};

const cleanupOldFiles = () => {
  fs.readdir(config.DOWNLOADS_DIR, (err, files) => {
    if (err) return console.error('❌ Cleanup error:', err);

    const now = Date.now();
    files.forEach(file => {
      const filePath = path.join(config.DOWNLOADS_DIR, file);
      
      // Skip if file is being downloaded
      if (activeDownloads.has(filePath)) return;

      fs.stat(filePath, (err, stats) => {
        if (err) return console.error('❌ File stat error:', err);
        
        if (now - stats.mtimeMs > config.FILE_RETENTION_TIME) {
          cleanupFile(filePath);
        }
      });
    });
  });
};

// Schedule regular cleanups
setInterval(cleanupOldFiles, config.FILE_CLEANUP_INTERVAL);
cleanupOldFiles(); // Initial cleanup

// ======================
// Video Download Handler
// ======================
const downloadVideo = async (url, res) => {
  const fileId = Date.now();
  const outputPath = path.join(config.DOWNLOADS_DIR, `dl_${fileId}.mp4`);
  
  const ytDlpCommand = [
    'yt-dlp',
    '--no-playlist',
    '--no-warnings',
    '--ignore-errors',
    '--buffer-size', config.STREAM_BUFFER_SIZE,
    '--socket-timeout', '60',
    '--retries', '10',
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '-o', outputPath,
    url
  ].join(' ');

  console.log(`🔧 Starting download: ${url}`);
  console.log(`💾 Output path: ${outputPath}`);

  try {
    const process = exec(ytDlpCommand, { maxBuffer: Infinity });

    process.on('error', (error) => {
      console.error('❌ Process error:', error);
      cleanupFile(outputPath);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download process failed' });
      }
    });

    process.on('exit', (code) => {
      if (code !== 0) {
        console.error(`❌ Process exited with code ${code}`);
        cleanupFile(outputPath);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Download failed' });
        }
        return;
      }

      // Stream the downloaded file to client
      streamDownloadedFile(outputPath, res);
    });

  } catch (error) {
    console.error('❌ Download error:', error);
    cleanupFile(outputPath);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download failed' });
    }
  }
};

const streamDownloadedFile = (filePath, res) => {
  if (!fs.existsSync(filePath)) {
    console.error('❌ File not found:', filePath);
    return res.status(404).json({ error: 'File not found' });
  }

  activeDownloads.add(filePath); // Mark as active download

  const stats = fs.statSync(filePath);
  const filename = `video_${path.basename(filePath)}`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stats.size);

  const stream = fs.createReadStream(filePath);

  stream.on('error', (error) => {
    console.error('❌ Stream error:', error);
    activeDownloads.delete(filePath);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream error' });
    }
  });

  stream.on('end', () => {
    console.log(`✅ Download completed: ${path.basename(filePath)}`);
    activeDownloads.delete(filePath);
    // Schedule cleanup after 5 minutes
    setTimeout(() => cleanupFile(filePath), 300000);
  });

  stream.pipe(res);
};

// ======================
// API Endpoints
// ======================
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    downloadsDir: config.DOWNLOADS_DIR,
    freeSpace: fs.statSync(config.DOWNLOADS_DIR).size
  });
});

app.post('/download', rateLimiter, async (req, res) => {
  const { url } = req.body;

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!isSupportedPlatform(url)) {
    return res.status(400).json({ error: 'Unsupported platform' });
  }

  await downloadVideo(url, res);
});

// ======================
// Server Initialization
// ======================
const startServer = async () => {
  initializeSystem();

  // Verify yt-dlp is available
  try {
    await execAsync('yt-dlp --version');
    console.log('✅ yt-dlp is available');
  } catch (error) {
    console.error('❌ yt-dlp not found. Please ensure it is installed.');
    process.exit(1);
  }

  const server = app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${config.PORT}`);
  });

  server.timeout = config.DOWNLOAD_TIMEOUT;
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
};

startServer().catch(error => {
  console.error('❌ Server failed to start:', error);
  process.exit(1);
});
