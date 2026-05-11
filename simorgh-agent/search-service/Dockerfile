FROM python:3.11-slim

WORKDIR /app
RUN printf '%s\n' 'Acquire::Retries "20";' 'Acquire::http::Timeout "300";' 'Acquire::https::Timeout "300";' 'Acquire::http::No-Cache "true";' > /etc/apt/apt.conf.d/99retries

RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir --timeout 180 --retries 10 -r requirements.txt
COPY app.py .

EXPOSE 8020
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8020"]
