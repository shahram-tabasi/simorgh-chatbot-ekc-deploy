FROM python:3.11-slim

# Install only essential system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
RUN pip install --no-cache-dir \
    docker \
    requests

# Copy the monitoring script
COPY monitor.py /app/

# Run the monitor
CMD ["python", "-u", "monitor.py"]