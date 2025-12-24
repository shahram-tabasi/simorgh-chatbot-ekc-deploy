#!/bin/bash
# Cleanup script for stuck Vagrant processes and locks

echo "=== Checking for running Vagrant/Ruby processes ==="
ps aux | grep -E "(vagrant|ruby)" | grep -v grep

echo ""
echo "=== Killing all Vagrant/Ruby processes ==="
pkill -9 -f vagrant || echo "No vagrant processes found"
pkill -9 ruby || echo "No ruby processes found"

echo ""
echo "=== Removing Vagrant lock files ==="
cd ~/eplan-vms-deployment || exit 1

# Remove machine lock files
find .vagrant/machines -name "index_lock" -delete 2>/dev/null || true
find .vagrant -name "*.lock" -delete 2>/dev/null || true

# List remaining lock files (should be none)
echo ""
echo "=== Checking for remaining locks ==="
find .vagrant -name "*.lock" 2>/dev/null || echo "No lock files found"
find .vagrant/machines -name "index_lock" 2>/dev/null || echo "No index_lock files found"

echo ""
echo "=== Vagrant Status ==="
vagrant global-status --prune

echo ""
echo "✓ Cleanup complete! You can now run 'vagrant up' again."
