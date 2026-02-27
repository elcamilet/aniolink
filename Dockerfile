# Stage 1: Build frontend
FROM node:22-alpine AS frontend-build
WORKDIR /app
COPY frontend/package*.json ./
RUN npm install --omit=dev=false
COPY frontend/ .
RUN npm run build

# Stage 2: Backend + frontend static files
FROM python:3.9-slim
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/aniolink.py .
COPY backend/templates ./templates
COPY --from=frontend-build /app/dist ./static

EXPOSE 3000
ENV PORT=3000
ENV HOST="0.0.0.0"

CMD ["sh", "-c", "uvicorn aniolink:app --host $HOST --port $PORT --timeout-keep-alive 3600"]
