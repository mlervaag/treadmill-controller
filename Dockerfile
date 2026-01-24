# Use Node.js 20 LTS (works on ARM for Raspberry Pi)
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY server.js .
COPY migrate.js .
COPY public ./public

# Create directory for database with proper permissions
RUN mkdir -p /app/data && \
    chmod 777 /app/data

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application
CMD ["node", "server.js"]
