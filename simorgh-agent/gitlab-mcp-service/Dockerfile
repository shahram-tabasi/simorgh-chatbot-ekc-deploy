# Built with context = ../ (the simorgh-agent root) so we can include the
# sibling `shared/` package.
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

COPY gitlab-mcp-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY shared/ /opt/shared/
RUN pip install --no-cache-dir -e /opt/shared/

COPY gitlab-mcp-service/app.py .

EXPOSE 8047
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8047"]
