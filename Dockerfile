# Use Node.js 20 LTS (works on ARM for Raspberry Pi)
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install build dependencies for better-sqlite3 and audio tools for A2DP
RUN apk add --no-cache python3 make g++ ffmpeg pulseaudio-utils

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY server.js .
COPY migrate.js .
COPY templates.json .
COPY coaching-engine.js .
COPY tts-service.js .
COPY public ./public

# Create directory for database with proper permissions
RUN mkdir -p /app/data && \
    mkdir -p /app/tts-cache && \
    chown -R node:node /app && \
    chmod 700 /app/data

# Switch to non-root user (node user is built into node:alpine, uid 1000)
USER node

# Expose ports (HTTP for view.html, HTTPS for Web Bluetooth)
EXPOSE 3000 3001

# Health check (use HTTP port which is always available)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get({hostname:'localhost',port:3000},(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

# Start application
CMD ["node", "server.js"]
