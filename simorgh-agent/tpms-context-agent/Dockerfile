FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

COPY tpms-context-agent/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY shared/ /opt/shared/
RUN pip install --no-cache-dir -e /opt/shared/

COPY tpms-context-agent/app.py .

EXPOSE 8050
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8050"]
