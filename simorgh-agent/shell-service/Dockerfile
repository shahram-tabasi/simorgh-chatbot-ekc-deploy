FROM python:3.11-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    jq \
    tree \
    vim-tiny \
    && rm -rf /var/lib/apt/lists/*

# Configure git
RUN git config --global user.name "Simorgh Agent" && \
    git config --global user.email "agent@simorgh.ai" && \
    git config --global init.defaultBranch main

# Install Python dependencies
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Create workspace directory
RUN mkdir -p /workspace

# Copy application
COPY app.py /app/app.py

WORKDIR /app

EXPOSE 8010

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8010"]
