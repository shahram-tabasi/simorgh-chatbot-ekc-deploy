# syntax=docker/dockerfile:1
FROM python:3.12-slim
WORKDIR /app

# smbclient is the SMB/CIFS client used to list + fetch single files from
# the legacy techserver. Self-contained service — no shared libs.
RUN apt-get update && \
    apt-get install -y --no-install-recommends smbclient && \
    rm -rf /var/lib/apt/lists/*

COPY techserver-mcp-service/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY techserver-mcp-service/app.py /app/app.py

ENV PYTHONUNBUFFERED=1
EXPOSE 8053
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8053"]
