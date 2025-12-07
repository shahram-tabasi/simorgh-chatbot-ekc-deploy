FROM python:3.11-slim

# Install system dependencies for document processing
RUN apt-get update && apt-get install -y \
    # For PDF processing
    poppler-utils \
    ghostscript \
    # For image processing (updated package names for Debian Trixie)
    libgl1 \
    libglib2.0-0 \
    # For table extraction (camelot)
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    # Build tools
    gcc \
    g++ \
    # For health check
    wget \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY main.py .

# Create directories for temp files and output
RUN mkdir -p temp processed_docs

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8000/health || exit 1

# Run the application
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
