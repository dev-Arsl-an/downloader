FROM node:18-alpine

WORKDIR /app

# Install system dependencies with explicit update and cleanup
RUN apk update && \
    apk add --no-cache \
    python3 \
    py3-pip \
    ffmpeg && \
    pip3 install --no-cache-dir --upgrade pip && \
    pip3 install --no-cache-dir yt-dlp && \
    rm -rf /var/cache/apk/*

COPY package*.json ./
RUN npm install --production

COPY . .

# Ensure required files exist with proper permissions
RUN touch cookies.txt proxies.txt && \
    chmod 644 cookies.txt proxies.txt

# Create downloads directory with proper permissions
RUN mkdir -p /tmp/downloads && \
    chmod 777 /tmp/downloads

EXPOSE 8080
CMD ["node", "index.js"]
