FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./
COPY db.js ./
COPY public ./public
RUN mkdir -p uploads
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
