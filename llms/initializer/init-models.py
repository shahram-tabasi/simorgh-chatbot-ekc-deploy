#!/usr/bin/env python3
"""
Model Initializer Service
Downloads and prepares models for the AI service
"""

import os
import sys
import time
import yaml
from pathlib import Path
from huggingface_hub import snapshot_download, hf_hub_download
from typing import Dict, List

# Colors for terminal output
class Colors:
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    BLUE = '\033[94m'
    RESET = '\033[0m'

def log(message: str, level: str = "INFO"):
    """Pretty logging"""
    colors = {
        "INFO": Colors.BLUE,
        "SUCCESS": Colors.GREEN,
        "WARNING": Colors.YELLOW,
        "ERROR": Colors.RED
    }
    color = colors.get(level, Colors.RESET)
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"{color}[{timestamp}] [{level}] {message}{Colors.RESET}")

def load_config() -> Dict:
    """Load configuration from YAML file"""
    config_path = Path("init-config.yaml")
    if not config_path.exists():
        log("Config file not found, using defaults", "WARNING")
        return {
            "models": [
                {
                    "name": "unsloth/gpt-oss-20b-unsloth-bnb-4bit",
                    "type": "huggingface",
                    "cache_dir": "/models/huggingface"
                }
            ]
        }
    
    with open(config_path, 'r') as f:
        return yaml.safe_load(f)

def check_model_exists(model_name: str, cache_dir: str, local_dir: str = None) -> bool:
    """Check if model is already downloaded"""
    # If local_dir is specified, check that directory instead
    if local_dir:
        model_path = Path(local_dir)
        if model_path.exists():
            # Check if directory has model files (config.json or pytorch_model.bin)
            has_config = (model_path / "config.json").exists()
            has_model = any(model_path.glob("*.bin")) or any(model_path.glob("*.safetensors"))

            if has_config and has_model:
                model_size = sum(f.stat().st_size for f in model_path.rglob('*') if f.is_file())
                size_gb = model_size / (1024**3)
                log(f"Model already exists: {model_name} in {local_dir} ({size_gb:.2f} GB)", "SUCCESS")
                return True
            else:
                log(f"Local dir exists but incomplete: {local_dir}", "WARNING")
                return False
        return False

    # Otherwise check cache directory
    # Convert model name to cache directory format
    cache_model_name = model_name.replace("/", "--")

    # Check multiple possible locations for the model
    possible_paths = [
        Path(cache_dir) / f"models--{cache_model_name}",  # Standard HF cache format
        Path(cache_dir) / cache_model_name,                # Alternative format (no "models--" prefix)
        Path(cache_dir) / "hub" / f"models--{cache_model_name}",  # Sometimes stored in hub subdirectory
    ]

    for model_path in possible_paths:
        if model_path.exists():
            # Check if it's a valid model directory
            has_config = (model_path / "config.json").exists() or \
                        any((model_path / "snapshots").glob("*/config.json")) if (model_path / "snapshots").exists() else False
            has_model = any(model_path.glob("*.bin")) or \
                       any(model_path.glob("*.safetensors")) or \
                       any((model_path / "snapshots").glob("*/*.safetensors")) if (model_path / "snapshots").exists() else False

            # For standard cache format, also check for incomplete files
            incomplete_files = list(model_path.rglob("*.incomplete"))

            if (has_config and has_model) and not incomplete_files:
                model_size = sum(f.stat().st_size for f in model_path.rglob('*') if f.is_file())
                size_gb = model_size / (1024**3)
                log(f"Model already exists: {model_name} at {model_path} ({size_gb:.2f} GB)", "SUCCESS")
                return True
            elif incomplete_files:
                log(f"Found incomplete download at {model_path}, will skip and check other locations", "WARNING")
                continue  # Check next possible location
            else:
                log(f"Found directory but incomplete model at {model_path}", "WARNING")
                continue

    return False

def download_huggingface_model(model_name: str, cache_dir: str, local_dir: str = None) -> bool:
    """Download model from Hugging Face"""
    try:
        log(f"Starting download: {model_name}", "INFO")

        # If local_dir is specified, download directly to that directory
        if local_dir:
            log(f"Target directory: {local_dir}", "INFO")
            log(f"Cache directory: {cache_dir}", "INFO")

            # Ensure both directories exist
            Path(local_dir).mkdir(parents=True, exist_ok=True)
            Path(cache_dir).mkdir(parents=True, exist_ok=True)

            # Download to local_dir with cache fallback
            snapshot_download(
                repo_id=model_name,
                local_dir=local_dir,
                local_dir_use_symlinks=False,
                cache_dir=cache_dir,
                resume_download=True,
                local_files_only=False
            )

            log(f"Successfully downloaded to: {local_dir}", "SUCCESS")
        else:
            log(f"Cache directory: {cache_dir}", "INFO")

            # Ensure cache directory exists
            Path(cache_dir).mkdir(parents=True, exist_ok=True)

            # Download the model to cache only
            snapshot_download(
                repo_id=model_name,
                cache_dir=cache_dir,
                resume_download=True,
                local_files_only=False
            )

            log(f"Successfully downloaded: {model_name}", "SUCCESS")

        return True

    except Exception as e:
        log(f"Failed to download {model_name}: {str(e)}", "ERROR")
        return False

def create_ready_marker(cache_dir: str):
    """Create a marker file to indicate initialization is complete"""
    marker_path = Path(cache_dir) / ".init_complete"
    marker_path.touch()
    log(f"Created ready marker: {marker_path}", "SUCCESS")

def main():
    """Main initialization process"""
    log("=" * 60, "INFO")
    log("Model Initializer Service Started", "INFO")
    log("=" * 60, "INFO")
    
    # Load configuration
    config = load_config()
    models = config.get("models", [])
    
    if not models:
        log("No models configured for download", "WARNING")
        sys.exit(0)
    
    log(f"Found {len(models)} model(s) to initialize", "INFO")
    
    # Process each model
    success_count = 0
    skip_count = 0
    fail_count = 0
    
    for idx, model_config in enumerate(models, 1):
        model_name = model_config.get("name")
        model_type = model_config.get("type", "huggingface")
        cache_dir = model_config.get("cache_dir", "/models/huggingface")
        local_dir = model_config.get("local_dir")  # Optional: direct download path
        description = model_config.get("description", "")

        log(f"[{idx}/{len(models)}] Processing: {model_name}", "INFO")
        if description:
            log(f"  Description: {description}", "INFO")

        # Check if already exists
        if check_model_exists(model_name, cache_dir, local_dir):
            skip_count += 1
            continue

        # Download based on type
        if model_type == "huggingface":
            if download_huggingface_model(model_name, cache_dir, local_dir):
                success_count += 1
            else:
                fail_count += 1
        else:
            log(f"Unknown model type: {model_type}", "ERROR")
            fail_count += 1
    
    # Summary
    log("=" * 60, "INFO")
    log("Initialization Summary:", "INFO")
    log(f"  Total models: {len(models)}", "INFO")
    log(f"  Already cached: {skip_count}", "SUCCESS")
    log(f"  Downloaded: {success_count}", "SUCCESS")
    log(f"  Failed: {fail_count}", "ERROR" if fail_count > 0 else "INFO")
    log("=" * 60, "INFO")
    
    # Create ready marker if all successful
    if fail_count == 0:
        for model_config in models:
            cache_dir = model_config.get("cache_dir", "/models/huggingface")
            create_ready_marker(cache_dir)
        log("Initialization completed successfully!", "SUCCESS")
        sys.exit(0)
    else:
        log("Initialization completed with errors", "ERROR")
        sys.exit(1)

if __name__ == "__main__":
    main()