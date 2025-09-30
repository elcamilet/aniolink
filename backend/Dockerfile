FROM python:3.9-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY aniolink.py .
EXPOSE 3000
ENV PORT=3000
ENV HOST="0.0.0.0"
CMD ["sh", "-c", "uvicorn aniolink:app --host $HOST --port $PORT"]
