# syntax=docker/dockerfile:1
FROM python:3.12-slim
WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

COPY chat-history-mcp-service/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY chat-history-mcp-service/app.py /app/app.py

ENV PYTHONUNBUFFERED=1
EXPOSE 8054
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8054"]
