FROM node:22-alpine

WORKDIR /app

# Copy root package files
COPY package*.json tsconfig.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/
COPY services/log-daemon/ ./services/log-daemon/

# Expose port
EXPOSE 9000

ENV NODE_ENV=production
ENV PORT=9000

CMD ["npx", "tsx", "services/log-daemon/server.ts"]

