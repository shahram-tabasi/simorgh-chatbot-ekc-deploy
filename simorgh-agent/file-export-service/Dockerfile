FROM python:3.11-slim

WORKDIR /app
RUN mkdir -p /app/exports
COPY requirements.txt .
RUN pip install --no-cache-dir --timeout 180 --retries 10 -r requirements.txt
COPY app.py .

EXPOSE 8025
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8025"]
