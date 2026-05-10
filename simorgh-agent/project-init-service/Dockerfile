# Built with context = ../ for sibling `shared/`.
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

COPY project-init-service/requirements.txt .
RUN pip install --no-cache-dir --timeout 180 --retries 10 -r requirements.txt

COPY shared/ /opt/shared/
RUN pip install --no-cache-dir --timeout 180 --retries 10 -e /opt/shared/

COPY project-init-service/app.py .

EXPOSE 8022
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8022"]
