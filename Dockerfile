FROM node:18-alpine

WORKDIR /app

# Install system dependencies
RUN apk update && \
    apk add --no-cache \
    python3 \
    py3-pip \
    ffmpeg && \
    rm -rf /var/cache/apk/*

# Create and use a virtual environment for Python packages
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip && \
    /opt/venv/bin/pip install --no-cache-dir yt-dlp

# Ensure the virtual environment is in PATH
ENV PATH="/opt/venv/bin:$PATH"

COPY package*.json ./
RUN npm install --production

COPY . .

# Ensure required files exist
RUN touch cookies.txt proxies.txt && \
    chmod 644 cookies.txt proxies.txt

# Create downloads directory
RUN mkdir -p /tmp/downloads && \
    chmod 777 /tmp/downloads

EXPOSE 8080
CMD ["node", "index.js"]
