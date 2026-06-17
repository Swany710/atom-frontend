FROM node:18-alpine
WORKDIR /app

# 1) install runtime dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# 2) copy static files + server
COPY public ./public
COPY server.js .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
