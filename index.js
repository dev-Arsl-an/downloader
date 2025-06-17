const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execAsync = promisify(exec);
const app = express();

// Helper functions for filename sanitization
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

app.use(express.json({ limit: '1mb' }));

// Create downloads directory with proper error handling for Railway
const downloadsDir = path.join(__dirname, 'downloads');
try {
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }
} catch (error) {
  console.warn('⚠️ Warning: Could not create downloads directory:', error.message);
  // Use /tmp directory as fallback on Railway
  const tmpDir = '/tmp/downloads';
  try {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    console.log('✅ Using /tmp/downloads as fallback directory');
  } catch (tmpError) {
    console.error('❌ Cannot create any downloads directory');
  }
}

// Rate limiting with memory cleanup
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; 
const RATE_LIMIT_MAX_REQUESTS = 10;

// Clean up old rate limit entries periodically
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
    'youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com',
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

// Check yt-dlp with Railway compatibility
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

// Check cookies file with error handling
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
    '-f', 'best',
    '-o', `"${outputPath}"`
  ];

  // Add cookies if available
  try {
    if (fs.existsSync(path.join(__dirname, 'cookies.txt'))) {
      baseCmd.push('--cookies', 'cookies.txt');
    }
  } catch (error) {
    console.warn('⚠️ Could not check cookies file');
  }

  // Platform-specific optimizations
  if (url.includes('tiktok.com')) {
    baseCmd.push(
      '--add-header', '"User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"',
      '--add-header', '"Referer: https://www.tiktok.com/"',
      '--extractor-retries', '5',
      '--fragment-retries', '5',
      '--retry-sleep', '1'
    );
  } else if (url.includes('instagram.com')) {
    baseCmd.push(
      '--add-header', '"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"',
      '--add-header', '"Referer: https://www.instagram.com/"'
    );
  }

  baseCmd.push(`"${sanitizeUrl(url)}"`);
  return baseCmd.join(' ');
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    ytDlpMethod: ytDlpMethod
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Video Downloader API',
    status: 'running',
    endpoints: {
      health: 'GET /health',
      extract: 'POST /extract',
      download: 'POST /download'
    },
    supportedPlatforms: ['YouTube', 'Instagram', 'Facebook', 'TikTok']
  });
});

app.post('/download', rateLimit, async (req, res) => {
  const { url } = req.body;
  
  // Input validation
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

  // Generate unique filename
  const timestamp = Date.now();
  const randomId = Math.random().toString(36).substring(7);
  const safeDownloadsDir = fs.existsSync(downloadsDir) ? downloadsDir : '/tmp/downloads';
  const outputTemplate = path.join(safeDownloadsDir, `video_${timestamp}_${randomId}_%(title)s.%(ext)s`);

  try {
    const command = buildDownloadCommand(url, outputTemplate);
    console.log(`🔧 Executing download command`);
    
    const { stdout, stderr } = await execAsync(command, {
      timeout: 180000, // 3 minute timeout for Railway
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      killSignal: 'SIGKILL'
    });

    if (stderr && stderr.includes('ERROR')) {
      console.error(`❌ Download error: ${stderr}`);
      return res.status(500).json({
        success: false,
        message: 'Video download failed',
        error: 'Unable to download video from this URL'
      });
    }

    // Find the downloaded file
    let files = [];
    try {
      files = fs.readdirSync(safeDownloadsDir).filter(file => 
        file.startsWith(`video_${timestamp}_${randomId}_`)
      );
    } catch (readError) {
      console.error('Error reading downloads directory:', readError);
      return res.status(500).json({
        success: false,
        message: 'Error accessing downloaded files'
      });
    }

    if (files.length === 0) {
      console.warn(`⚠️ No downloaded file found`);
      return res.status(404).json({
        success: false,
        message: 'No video file was downloaded'
      });
    }

    const downloadedFile = files[0];
    const filePath = path.join(safeDownloadsDir, downloadedFile);
    
    let fileStats;
    try {
      fileStats = fs.statSync(filePath);
    } catch (statError) {
      console.error('Error getting file stats:', statError);
      return res.status(500).json({
        success: false,
        message: 'Error accessing downloaded file'
      });
    }

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
      // Delete the file after sending with timeout
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
      message: 'Internal server error during video download'
    });
  }
});

app.post('/extract', rateLimit, async (req, res) => {
  const { url } = req.body;
  
  // Input validation
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

  console.log(`📥 Processing extraction request: ${url}`);

  try {
    const baseCommand = ytDlpMethod === 'python3' 
      ? 'python3 -m yt_dlp' 
      : ytDlpMethod === 'python' 
      ? 'python -m yt_dlp' 
      : 'yt-dlp';
    
    const cookiesFlag = fs.existsSync(path.join(__dirname, 'cookies.txt')) ? '--cookies cookies.txt' : '';
    const command = `${baseCommand} --no-playlist --no-warnings --ignore-errors -f best --get-url ${cookiesFlag} "${sanitizeUrl(url)}"`;
    
    console.log(`🔧 Executing extraction command`);
    
    const { stdout, stderr } = await execAsync(command, {
      timeout: 45000, // 45 second timeout
      maxBuffer: 1024 * 1024,
      killSignal: 'SIGKILL'
    });

    if (stderr && stderr.includes('ERROR')) {
      console.error(`❌ yt-dlp error: ${stderr}`);
      return res.status(500).json({
        success: false,
        message: 'Video extraction failed',
        error: 'Unable to extract video from this URL'
      });
    }

    const urls = stdout.trim()
      .split('\n')
      .filter(line => line.startsWith('http'))
      .map(line => line.trim());

    if (urls.length === 0) {
      console.warn(`⚠️ No video URLs found for: ${url}`);
      return res.status(404).json({
        success: false,
        message: 'No downloadable video found'
      });
    }

    const directUrl = urls[0];
    console.log(`✅ Successfully extracted video URL`);
    
    res.json({
      success: true,
      url: directUrl,
      extractedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error(`❌ Extraction failed for ${url}:`, error.message);
    
    if (error.code === 'TIMEOUT' || error.killed) {
      return res.status(408).json({
        success: false,
        message: 'Request timeout - video extraction took too long'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Internal server error during video extraction'
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found'
  });
});

// Graceful shutdown handlers
process.on('SIGTERM', () => {
  console.log('📴 Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('📴 Received SIGINT, shutting down gracefully');
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
const PORT = process.env.PORT || 3000;

const startServer = async () => {
  console.log('🚀 Starting Video Downloader API...');
  console.log('🔧 Environment:', process.env.NODE_ENV || 'development');
  
  // Pre-flight checks
  const ytDlpAvailable = await checkYtDlp();
  if (!ytDlpAvailable) {
    console.error('❌ Cannot start server: yt-dlp is not available');
    console.log('💡 Make sure yt-dlp is installed: pip install yt-dlp');
    process.exit(1);
  }
  
  ytDlpMethod = ytDlpAvailable;
  checkCookiesFile();
  
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Video Downloader API running on port ${PORT}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    console.log(`📥 Extract URL: POST /extract`);
    console.log(`📁 Download file: POST /download`);
    console.log(`🎯 Supported platforms: YouTube, Instagram, Facebook, TikTok`);
  });

  // Set server timeout for Railway
  server.timeout = 300000; // 5 minutes
  server.keepAliveTimeout = 65000; // 65 seconds
  server.headersTimeout = 66000; // 66 seconds
};

startServer().catch(error => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});
