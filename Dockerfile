FROM node:18-alpine

WORKDIR /app

# Install system dependencies
RUN apk add --no-cache \
    python3 \
    py3-pip \
    ffmpeg \
    && pip3 install --no-cache-dir yt-dlp

COPY package*.json ./
RUN npm install --production

COPY . .

# Ensure required files exist
RUN touch cookies.txt proxies.txt

# Create downloads directory
RUN mkdir -p /tmp/downloads

EXPOSE 8080
CMD ["node", "index.js"]
