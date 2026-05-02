#!/usr/bin/env python3
"""
Model Initialization Script

Pre-downloads models to avoid runtime delays.
Run this before starting the service for faster startup.
"""

import os
import sys
import argparse
import logging
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def download_model(
    model_name: str,
    model_path: str,
    hf_token: str = None
):
    """
    Download model from Hugging Face.

    Args:
        model_name: Hugging Face model name
        model_path: Local path to save model
        hf_token: Hugging Face API token (optional)
    """
    try:
        from huggingface_hub import snapshot_download, HfApi
    except ImportError:
        logger.error("huggingface_hub not installed. Install with: pip install huggingface_hub")
        sys.exit(1)

    logger.info(f"Downloading model: {model_name}")
    logger.info(f"Destination: {model_path}")

    # Check if model requires acceptance
    try:
        api = HfApi(token=hf_token)
        model_info = api.model_info(model_name)

        if hasattr(model_info, 'gated') and model_info.gated:
            logger.warning(
                f"\n{'=' * 60}\n"
                f"⚠️  MODEL REQUIRES LICENSE ACCEPTANCE ⚠️\n"
                f"{'=' * 60}\n"
                f"The model '{model_name}' requires accepting terms.\n\n"
                f"Steps:\n"
                f"1. Visit: https://huggingface.co/{model_name}\n"
                f"2. Read and accept the model card/license\n"
                f"3. Run: huggingface-cli login\n"
                f"4. Re-run this script\n"
                f"{'=' * 60}\n"
            )
            sys.exit(1)
    except Exception as e:
        logger.warning(f"Could not verify model gated status: {e}")

    # Create directory
    os.makedirs(model_path, exist_ok=True)

    # Download model
    try:
        logger.info("Starting download...")
        downloaded_path = snapshot_download(
            repo_id=model_name,
            local_dir=model_path,
            local_dir_use_symlinks=False,
            token=hf_token,
        )

        logger.info(f"✅ Model downloaded successfully to {downloaded_path}")
        logger.info(f"Total size: {get_dir_size(model_path):.2f} GB")

    except Exception as e:
        logger.error(f"❌ Model download failed: {e}")
        sys.exit(1)


def get_dir_size(path: str) -> float:
    """Get directory size in GB"""
    total_size = 0
    for dirpath, dirnames, filenames in os.walk(path):
        for filename in filenames:
            filepath = os.path.join(dirpath, filename)
            if os.path.exists(filepath):
                total_size += os.path.getsize(filepath)
    return total_size / (1024 ** 3)


def main():
    parser = argparse.ArgumentParser(
        description="Pre-download AI models for Simorgh service"
    )
    parser.add_argument(
        "--model-name",
        default="unsloth/gpt-oss-20b",
        help="Hugging Face model name"
    )
    parser.add_argument(
        "--model-path",
        default="/models/unsloth-gpt-oss-20b-16bit",
        help="Local path to save model"
    )
    parser.add_argument(
        "--hf-token",
        default=os.getenv("HF_TOKEN"),
        help="Hugging Face API token (or set HF_TOKEN env var)"
    )
    parser.add_argument(
        "--skip-if-exists",
        action="store_true",
        help="Skip download if model already exists"
    )

    args = parser.parse_args()

    # Check if model already exists
    if args.skip_if_exists and os.path.exists(args.model_path):
        logger.info(f"Model already exists at {args.model_path}")
        logger.info("Use --skip-if-exists=false to re-download")
        sys.exit(0)

    # Download model
    download_model(
        model_name=args.model_name,
        model_path=args.model_path,
        hf_token=args.hf_token
    )


if __name__ == "__main__":
    main()
