# Built with context = ../ (the simorgh-agent root) for sibling `shared/`.
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates wget docker.io \
    && rm -rf /var/lib/apt/lists/*

COPY runtime-broker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY shared/ /opt/shared/
RUN pip install --no-cache-dir -e /opt/shared/

COPY runtime-broker/app.py .

EXPOSE 8048
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8048"]
