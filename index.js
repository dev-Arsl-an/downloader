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

// Create downloads directory
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir);
}


const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; 
const RATE_LIMIT_MAX_REQUESTS = 10;

const rateLimit = (req, res, next) => {
  const clientIP = req.ip || req.connection.remoteAddress;
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
    'twitter.com', 'x.com', 'facebook.com', 'vimeo.com'
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


const checkYtDlp = async () => {
  try {
    const { stdout } = await execAsync('yt-dlp --version');
    console.log('✅ yt-dlp version:', stdout.trim());
    return true;
  } catch (error) {
    console.error('❌ yt-dlp not found or not working:', error.message);
    return false;
  }
};

// Check cookies file
const checkCookiesFile = () => {
  const cookiesPath = path.join(__dirname, 'cookies.txt');
  if (!fs.existsSync(cookiesPath)) {
    console.warn('⚠️ cookies.txt not found. Some extractions may fail.');
    return false;
  }
  console.log('✅ cookies.txt found');
  return true;
};


const buildDownloadCommand = (url, outputPath) => {
  const baseCmd = [
    'yt-dlp',
    '--no-playlist',
    '--no-warnings',
    '-f', 'best',
    '-o', `"${outputPath}"`
  ];

  // Add cookies if available
  if (fs.existsSync('cookies.txt')) {
    baseCmd.push('--cookies', 'cookies.txt');
  }


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
    uptime: process.uptime()
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
      message: 'Unsupported domain. Supported: YouTube, TikTok, Instagram, Twitter, Facebook, Vimeo'
    });
  }

  console.log(`Processing download request: ${url}`);

  // Generate unique filename
  const timestamp = Date.now();
  const outputTemplate = path.join(downloadsDir, `video_${timestamp}_%(title)s.%(ext)s`);

  try {
    const command = buildDownloadCommand(url, outputTemplate);
    console.log(`🔧 Executing download command`);
    
    const { stdout, stderr } = await execAsync(command, {
      timeout: 120000, // 2 minute timeout for downloads
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
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
    const files = fs.readdirSync(downloadsDir).filter(file => 
      file.startsWith(`video_${timestamp}_`)
    );

    if (files.length === 0) {
      console.warn(`No downloaded file found`);
      return res.status(404).json({
        success: false,
        message: 'No video file was downloaded'
      });
    }

    const downloadedFile = files[0];
    const filePath = path.join(downloadsDir, downloadedFile);
    const fileStats = fs.statSync(filePath);

    console.log(`Successfully downloaded: ${downloadedFile}`);
    
 
    const sanitizedFilename = sanitizeFilename(downloadedFile);
    const encodedFilename = encodeRFC5987(downloadedFile);

    res.setHeader('Content-Disposition', 
      `attachment; filename="${sanitizedFilename}"; filename*=UTF-8''${encodedFilename}`
    );
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', fileStats.size);

   
    const fileStream = fs.createReadStream(filePath);
    
    fileStream.on('end', () => {
      // Delete the file after sending (optional)
      fs.unlink(filePath, (err) => {
        if (err) console.error('Error deleting file:', err);
        else console.log(`🗑️ Cleaned up: ${downloadedFile}`);
      });
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
      message: 'Unsupported domain. Supported: YouTube, TikTok, Instagram, Twitter, Facebook, Vimeo'
    });
  }

  console.log(`📥 Processing extraction request: ${url}`);

  try {
    const command = `yt-dlp --no-playlist --no-warnings -f best --get-url ${fs.existsSync('cookies.txt') ? '--cookies cookies.txt' : ''} "${sanitizeUrl(url)}"`;
    console.log(`🔧 Executing: ${command.replace(url, '[URL]')}`);
    
    const { stdout, stderr } = await execAsync(command, {
      timeout: 30000,
      maxBuffer: 1024 * 1024
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
    console.log(`Successfully extracted video URL`);
    
    res.json({
      success: true,
      url: directUrl,
      extractedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error(`❌ Extraction failed for ${url}:`, error.message);
    
    if (error.code === 'TIMEOUT') {
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

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found'
  });
});


process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  process.exit(0);
});

// Start server
const PORT = process.env.PORT || 3000;

const startServer = async () => {
  console.log('🚀 Starting Video Downloader API...');
  
  // Pre-flight checks
  const ytDlpAvailable = await checkYtDlp();
  if (!ytDlpAvailable) {
    console.error('❌ Cannot start server: yt-dlp is not available');
    process.exit(1);
  }
  
  checkCookiesFile();
  
  app.listen(PORT, () => {
    console.log(`Video Downloader API running on port ${PORT}`);
    console.log(`Health check available at: http://localhost:${PORT}/health`);
    console.log(`Extract URL endpoint: POST /extract`);
    console.log(`Download file endpoint: POST /download`);
  });
};

startServer().catch(error => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});