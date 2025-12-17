#!/bin/bash
# cleanup-incomplete-models.sh
# Removes incomplete model downloads to free up disk space

MODEL_CACHE_PATH="${MODEL_CACHE_PATH:-/home/ubuntu/models}"

echo "=== Cleanup Incomplete Model Downloads ==="
echo ""
echo "Target directory: $MODEL_CACHE_PATH"
echo ""

# Check if base directory exists
if [ ! -d "$MODEL_CACHE_PATH" ]; then
    echo "❌ Model directory doesn't exist: $MODEL_CACHE_PATH"
    exit 1
fi

# Find directories with incomplete files
echo "Searching for incomplete downloads..."
INCOMPLETE_DIRS=$(find "$MODEL_CACHE_PATH" -name "*.incomplete" -exec dirname {} \; | sort -u)

if [ -z "$INCOMPLETE_DIRS" ]; then
    echo "✅ No incomplete downloads found!"
    exit 0
fi

echo "Found incomplete downloads in the following locations:"
echo "$INCOMPLETE_DIRS" | while read -r dir; do
    SIZE=$(du -sh "$dir" 2>/dev/null | cut -f1)
    echo "  📁 $dir ($SIZE)"
done

echo ""
echo "⚠️  WARNING: This will DELETE incomplete downloads!"
echo "Before proceeding, ensure you have complete models in other locations."
echo ""
read -p "Do you want to continue? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo "Cancelled."
    exit 0
fi

# Remove incomplete downloads
echo ""
echo "Removing incomplete downloads..."
TOTAL_FREED=0

echo "$INCOMPLETE_DIRS" | while read -r dir; do
    if [ -d "$dir" ]; then
        SIZE=$(du -sb "$dir" 2>/dev/null | cut -f1)
        SIZE_GB=$(echo "scale=2; $SIZE / 1024 / 1024 / 1024" | bc)

        echo "  Removing: $dir (${SIZE_GB} GB)"
        rm -rf "$dir"

        if [ $? -eq 0 ]; then
            echo "    ✅ Removed successfully"
        else
            echo "    ❌ Failed to remove"
        fi
    fi
done

echo ""
echo "=== Cleanup Complete ==="
echo ""
echo "Disk usage after cleanup:"
df -h "$MODEL_CACHE_PATH" | tail -1
echo ""
echo "To verify remaining models, run:"
echo "  ./check-models.sh"
