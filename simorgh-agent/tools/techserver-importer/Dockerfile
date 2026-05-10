FROM python:3.12-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates git smbclient \
    && rm -rf /var/lib/apt/lists/*

COPY tools/techserver-importer/requirements.txt .
RUN pip install --no-cache-dir --timeout 180 --retries 10 -r requirements.txt

COPY tools/techserver-importer/import_techserver.py .

ENTRYPOINT ["python", "/app/import_techserver.py"]
