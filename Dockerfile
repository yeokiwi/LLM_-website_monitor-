# ── Stage 1: Build the React frontend ────────────────────────────────────────
FROM node:20-alpine AS frontend

WORKDIR /build

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build
# output → /build/dist/


# ── Stage 2: Production backend ───────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Install production dependencies only
COPY backend/package*.json ./
RUN npm ci --omit=dev

# Copy backend source
COPY backend/ ./

# Copy the built frontend so Express can serve it as static files
COPY --from=frontend /build/dist ./public

# Directory for the SQLite database.
# On Railway: create a Volume and mount it at /data via the dashboard.
# Locally with Docker: use  -v your_local_path:/data
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/data/monitor.db

EXPOSE 3001

CMD ["node", "src/server.js"]
