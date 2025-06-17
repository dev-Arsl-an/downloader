# Use Node.js 18 with slim Linux
FROM node:18-slim

# Update package lists and install system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    curl \
    wget \
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create a virtual environment and install yt-dlp
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Upgrade pip and install yt-dlp with proper error handling
RUN pip install --upgrade pip setuptools wheel && \
    pip install --no-cache-dir yt-dlp

# Set working directory
WORKDIR /app

# Copy package files first (for better Docker caching)
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --production

# Copy all application files
COPY . .

# Create downloads directory with proper permissions
RUN mkdir -p downloads && chmod 755 downloads
RUN mkdir -p /tmp/downloads && chmod 755 /tmp/downloads

# Expose the port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["npm", "start"]
