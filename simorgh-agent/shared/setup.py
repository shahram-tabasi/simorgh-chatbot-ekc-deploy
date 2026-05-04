from setuptools import setup, find_packages

setup(
    name="simorgh-shared",
    version="0.1.0",
    description="Shared logging + clients for simorgh services",
    packages=find_packages(),
    install_requires=[
        "structlog>=24.1.0",
        "httpx>=0.27.0",
    ],
    python_requires=">=3.10",
)
