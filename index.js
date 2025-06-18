const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execAsync = promisify(exec);
const app = express();

// Helper functions
const sanitizeFilename = (filename) => {
  return filename
    .replace(/[^\w\s\-_.()[\]]/g, '_') 
    .replace(/\s+/g, '_') 
    .replace(/_+/g, '_')
    .substring(0, 100); 
};

const encodeRFC5987 = (str) => {
  return encodeURIComponent(str)
    .replace(/['()]/g, escape) 
    .replace(/\*/g, '%2A'); 
};

// Security middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  credentials: true
}));

app.use(express.json({ 
  limit: '1mb',
  verify: (req, res, buf) => {
    try {
      JSON.parse(buf.toString());
    } catch (e) {
      throw new Error('Invalid JSON');
    }
  }
}));

// Storage configuration for Railway
const downloadsDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || 
                   path.join(__dirname, 'downloads') || 
                   '/tmp/downloads';

// Ensure downloads directory exists
try {
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
    console.log(`✅ Created downloads directory: ${downloadsDir}`);
  }
} catch (error) {
  console.error('❌ Failed to create downloads directory:', error.message);
  process.exit(1);
}

// Rate limiting
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; 
const RATE_LIMIT_MAX_REQUESTS = 10;

setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitMap.entries()) {
    if (now > data.resetTime) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW);

const rateLimit = (req, res, next) => {
  const clientIP = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  
  if (!rateLimitMap.has(clientIP)) {
    rateLimitMap.set(clientIP, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  const clientData = rateLimitMap.get(clientIP);
  
  if (now > clientData.resetTime) {
    rateLimitMap.set(clientIP, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  if (clientData.count >= RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({
      success: false,
      message: 'Too many requests. Please try again later.'
    });
  }
  
  clientData.count++;
  next();
};

// URL validation
const isValidUrl = (string) => {
  try {
    const url = new URL(string);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
};

const isSupportedDomain = (url) => {
  const supportedDomains = [
    'youtube.com', 'youtu.be', 'tiktok.com', 'vm.tiktok.com', 'instagram.com',
    'facebook.com'
  ];
  
  try {
    const urlObj = new URL(url);
    return supportedDomains.some(domain => 
      urlObj.hostname.includes(domain) || urlObj.hostname.endsWith(domain)
    );
  } catch {
    return false;
  }
};

const sanitizeUrl = (url) => {
  return url.replace(/[;&|`$(){}[\]\\]/g, '').substring(0, 500);
};

// Check yt-dlp
const checkYtDlp = async () => {
  try {
    const { stdout } = await execAsync('yt-dlp --version', { timeout: 15000 });
    console.log('✅ yt-dlp version:', stdout.trim());
    return 'yt-dlp';
  } catch (error) {
    console.warn('⚠️ yt-dlp command not found, trying python3 -m yt_dlp');
    try {
      const { stdout } = await execAsync('python3 -m yt_dlp --version', { timeout: 15000 });
      console.log('✅ yt-dlp (python3) version:', stdout.trim());
      return 'python3';
    } catch (pythonError) {
      console.warn('⚠️ python3 -m yt_dlp not found, trying python -m yt_dlp');
      try {
        const { stdout } = await execAsync('python -m yt_dlp --version', { timeout: 15000 });
        console.log('✅ yt-dlp (python) version:', stdout.trim());
        return 'python';
      } catch (finalError) {
        console.error('❌ yt-dlp not available via any method');
        return false;
      }
    }
  }
};

// Check cookies file
const checkCookiesFile = () => {
  try {
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    if (!fs.existsSync(cookiesPath)) {
      console.warn('⚠️ cookies.txt not found. Some extractions may fail.');
      return false;
    }
    console.log('✅ cookies.txt found');
    return true;
  } catch (error) {
    console.warn('⚠️ Error checking cookies file:', error.message);
    return false;
  }
};

// Global variable to store yt-dlp method
let ytDlpMethod = 'yt-dlp';

const buildDownloadCommand = (url, outputPath) => {
  const baseCommand = ytDlpMethod === 'python3' 
    ? 'python3 -m yt_dlp' 
    : ytDlpMethod === 'python' 
    ? 'python -m yt_dlp' 
    : 'yt-dlp';
  
  const baseCmd = [
    baseCommand,
    '--no-playlist',
    '--no-warnings',
    '--ignore-errors',
    '--force-ipv4',
    '--socket-timeout', '30',
    '--source-address', '0.0.0.0',
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
  ];

  // Fix: Properly escape output path with single quotes
  baseCmd.push('-o', `'${outputPath}'`);

  // Add cookies if available
  const cookiesPath = path.join(__dirname, 'cookies.txt');
  if (fs.existsSync(cookiesPath)) {
    baseCmd.push('--cookies', `'${cookiesPath}'`);
  }

  // Platform-specific configurations
  if (url.includes('tiktok.com') || url.includes('vm.tiktok.com')) {
    // TikTok specific settings
    baseCmd.push(
      '--referer', '"https://www.tiktok.com/"',
      '--add-header', '"User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"',
      '--add-header', '"Referer:https://www.tiktok.com/"',
      '--extractor-args', '"tiktok:skip_hybrid_manifest=true"',
      '--extractor-retries', '5',
      '--fragment-retries', '5',
      '--retry-sleep', '1'
    );
  } else if (url.includes('instagram.com')) {
    baseCmd.push(
      '--add-header', '"User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"',
      '--add-header', '"Referer:https://www.instagram.com/"'
    );
  } else {
    // Default headers for all requests
    baseCmd.push(
      '--add-header', '"User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"',
      '--add-header', '"Accept-Language:en-US,en;q=0.9"',
      '--add-header', '"Referer:https://www.google.com/"'
    );
  }

  // Fix: Properly escape URL with single quotes
  baseCmd.push(`'${sanitizeUrl(url)}'`);
  return baseCmd.join(' ');
};

// Endpoints
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    ytDlpMethod: ytDlpMethod
  });
});

app.post('/download', rateLimit, async (req, res) => {
  const { url } = req.body;
  
  if (!url || typeof url !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Valid URL is required'
    });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid URL format'
    });
  }

  if (!isSupportedDomain(url)) {
    return res.status(400).json({
      success: false,
      message: 'Unsupported domain. Supported: YouTube, TikTok, Instagram, Facebook'
    });
  }

  console.log(`📥 Processing download request: ${url}`);

  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(7);
  // Fix: Use static filename for initial testing
  const outputTemplate = path.join(downloadsDir, `video_${timestamp}_${randomId}.mp4`);

  try {
    const command = buildDownloadCommand(url, outputTemplate);
    console.log(`🔧 Executing download command: ${command}`);
    
    const { stdout, stderr } = await execAsync(command, {
      timeout: 180000,
      maxBuffer: 50 * 1024 * 1024,
      killSignal: 'SIGKILL'
    });

    if (stderr && stderr.includes('ERROR')) {
      console.error(`❌ Download error: ${stderr}`);
      return res.status(500).json({
        success: false,
        message: 'Video download failed',
        error: stderr
      });
    }

    // Find the downloaded file
    const files = fs.readdirSync(downloadsDir).filter(file => 
      file.startsWith(`video_${timestamp}_${randomId}`)
    );

    if (files.length === 0) {
      console.warn(`⚠️ No downloaded file found`);
      return res.status(404).json({
        success: false,
        message: 'No video file was downloaded'
      });
    }

    const downloadedFile = files[0];
    const filePath = path.join(downloadsDir, downloadedFile);
    const fileStats = fs.statSync(filePath);

    console.log(`✅ Successfully downloaded: ${downloadedFile} (${fileStats.size} bytes)`);
    
    const sanitizedFilename = sanitizeFilename(downloadedFile);
    const encodedFilename = encodeRFC5987(downloadedFile);

    res.setHeader('Content-Disposition', 
      `attachment; filename="${sanitizedFilename}"; filename*=UTF-8''${encodedFilename}`
    );
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', fileStats.size);

    const fileStream = fs.createReadStream(filePath);
    
    fileStream.on('error', (streamError) => {
      console.error('File stream error:', streamError);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: 'Error streaming file'
        });
      }
    });
    
    fileStream.on('end', () => {
      setTimeout(() => {
        fs.unlink(filePath, (err) => {
          if (err) console.error('Error deleting file:', err);
          else console.log(`🗑️ Cleaned up: ${downloadedFile}`);
        });
      }, 1000);
    });

    fileStream.pipe(res);

  } catch (error) {
    console.error(`❌ Download failed for ${url}:`, error.message);
    
    if (error.code === 'TIMEOUT') {
      return res.status(408).json({
        success: false,
        message: 'Request timeout - video download took too long'
      });
    }

    if (error.killed) {
      return res.status(408).json({
        success: false,
        message: 'Download process was terminated due to timeout'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Internal server error during video download',
      error: error.message
    });
  }
});

// Start server
const PORT = process.env.PORT || 8080;

const startServer = async () => {
  console.log('🚀 Starting Video Downloader API...');
  console.log('🔧 Environment:', process.env.NODE_ENV || 'development');
  
  // Pre-flight checks
  ytDlpMethod = await checkYtDlp();
  if (!ytDlpMethod) {
    console.error('❌ Cannot start server: yt-dlp is not available');
    process.exit(1);
  }
  
  checkCookiesFile();
  
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Video Downloader API running on port ${PORT}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log(`📥 Download file: POST /download`);
    console.log(`🎯 Supported platforms: YouTube, Instagram, Facebook, TikTok`);
  });

  server.timeout = 300000;
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
};

startServer().catch(error => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});
