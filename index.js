const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const crypto = require('crypto');
const execAsync = promisify(exec);
const app = express();
const DOWNLOAD_TIMEOUT = 1800000;
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true, mode: 0o755 });
}
app.use(cors());
app.use(express.json());
const sanitizeFilename = (filename) => {
  return filename.replace(/[^\w\s\-_.()[\]]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').substring(0, 150);
};
const isValidUrl = (url) => {
  try {
    const urlObj = new URL(url);
    return ['http:', 'https:'].includes(urlObj.protocol);
  } catch {
    return false;
  }
};
const isSupportedDomain = (url) => {
  const supported = [
    'youtube.com', 'youtu.be', 'tiktok.com', 'vm.tiktok.com', 'instagram.com', 'facebook.com'
  ];
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return supported.some(domain => hostname.includes(domain));
  } catch {
    return false;
  }
};
let ytDlpCommand = 'yt-dlp';
const detectYtDlp = async () => {
  const commands = ['yt-dlp --version', 'python3 -m yt_dlp --version'];
  for (const cmd of commands) {
    try {
      const { stdout } = await execAsync(cmd, { timeout: 5000 });
      ytDlpCommand = cmd.split(' ')[0];
      console.log(`Using ${ytDlpCommand} version: ${stdout.trim()}`);
      return true;
    } catch {}
  }
  console.error('yt-dlp not found');
  return false;
};
app.post('/download', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !isValidUrl(url) || !isSupportedDomain(url)) {
      return res.status(400).json({ error: 'Invalid or unsupported URL' });
    }
    const id = crypto.randomBytes(16).toString('hex');
    const outputPath = path.join(downloadsDir, `${id}.mp4`);
    const args = [
      '--no-playlist', '--no-warnings', '--ignore-errors', '--merge-output-format', 'mp4',
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best', '-o', outputPath, url
    ];
    const proc = spawn(ytDlpCommand, args);
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        return res.json({ downloadUrl: `/file/${id}.mp4` });
      } else {
        return res.status(500).json({ error: 'Download failed' });
      }
    });
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill('SIGKILL');
        return res.status(408).json({ error: 'Timeout' });
      }
    }, DOWNLOAD_TIMEOUT);
  } catch (err) {
    return res.status(500).json({ error: 'Server error' });
  }
});
app.get('/file/:filename', (req, res) => {
  const filePath = path.join(downloadsDir, sanitizeFilename(req.params.filename));
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.download(filePath);
});
const startServer = async () => {
  const ok = await detectYtDlp();
  if (!ok) process.exit(1);
  app.listen(8080, () => console.log('Server started on port 8080'));
};
startServer();
