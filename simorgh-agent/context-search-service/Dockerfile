FROM python:3.12-slim

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

COPY context-search-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY shared/ /opt/shared/
RUN pip install --no-cache-dir -e /opt/shared/

COPY context-search-service/app.py .
COPY context-search-service/index_setup.py .

EXPOSE 8049
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8049"]
