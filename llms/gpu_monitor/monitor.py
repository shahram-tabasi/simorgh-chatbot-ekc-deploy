"""
GPU Memory Monitor with Task-Based Idle Detection

This monitor:
1. Tracks GPU memory usage and utilization
2. Checks backend service for active tasks via /status endpoint
3. Automatically restarts container when:
   - GPU memory > threshold (default 97% for 16-bit vLLM)
   - GPU utilization < threshold (default 5%)
   - Backend has no active tasks (is_idle = True)
   - Conditions persist for specified duration (default 60s)
"""

import subprocess
import time
import docker
import logging
import os
import requests
from datetime import datetime

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ============================================================================
# Configuration from Environment Variables
# ============================================================================
GPU_MEMORY_THRESHOLD = float(os.getenv('GPU_MEMORY_THRESHOLD', '97'))  # Increased for 16-bit vLLM model
GPU_IDLE_THRESHOLD = float(os.getenv('GPU_IDLE_THRESHOLD', '5'))
IDLE_DURATION = int(os.getenv('IDLE_DURATION', '60'))
CHECK_INTERVAL = int(os.getenv('CHECK_INTERVAL', '10'))
TARGET_CONTAINER = os.getenv('TARGET_CONTAINER', 'backend_flask_stage1')
BACKEND_URL = os.getenv('BACKEND_URL', 'http://backend_flask_stage1:8890')

# Docker client
client = docker.from_env()

# State tracking
idle_start_time = None
high_memory_detected = False
last_active_count = None

# ============================================================================
# GPU Monitoring Functions
# ============================================================================

def get_gpu_stats():
    """
    Get GPU memory and utilization statistics using nvidia-smi.
    
    Returns:
        dict: GPU statistics or None if failed
            {
                'memory_used': float (MB),
                'memory_total': float (MB),
                'memory_percent': float (0-100),
                'gpu_utilization': float (0-100)
            }
    """
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=memory.used,memory.total,utilization.gpu', 
             '--format=csv,noheader,nounits'],
            capture_output=True,
            text=True,
            check=True
        )
        
        line = result.stdout.strip().split('\n')[0]  # Get first GPU
        memory_used, memory_total, gpu_util = map(float, line.split(','))
        
        memory_percent = (memory_used / memory_total) * 100
        
        return {
            'memory_used': memory_used,
            'memory_total': memory_total,
            'memory_percent': memory_percent,
            'gpu_utilization': gpu_util
        }
    except Exception as e:
        logger.error(f"❌ Failed to get GPU stats: {e}")
        return None


# ============================================================================
# Backend Service Monitoring Functions
# ============================================================================

def check_backend_status():
    """
    Check backend service status using the /status endpoint.
    
    Returns:
        tuple: (is_idle, active_count, service_state) or (None, None, None) if failed
    """
    global last_active_count
    
    try:
        response = requests.get(f"{BACKEND_URL}/status", timeout=5)
        
        if response.status_code == 200:
            data = response.json()
            
            is_idle = data.get('is_idle', False)
            active_count = data.get('tasks', {}).get('active', 0)
            service_state = data.get('service_state', 'unknown')
            
            # Log only when active count changes
            if active_count != last_active_count:
                if active_count > 0:
                    logger.info(f"⚙️  Backend: {active_count} active tasks (busy)")
                else:
                    logger.info(f"✅ Backend: No active tasks (idle)")
                last_active_count = active_count
            
            return is_idle, active_count, service_state
        else:
            logger.warning(f"⚠️  Backend /status returned HTTP {response.status_code}")
            return None, None, None
            
    except requests.exceptions.Timeout:
        logger.warning("⚠️  Backend /status endpoint timed out")
        return None, None, None
    except requests.exceptions.ConnectionError:
        logger.warning("⚠️  Cannot connect to backend")
        return None, None, None
    except Exception as e:
        logger.warning(f"⚠️  Error checking backend status: {e}")
        return None, None, None


# ============================================================================
# Container Management Functions
# ============================================================================

def restart_container(container_name):
    """
    Restart the specified Docker container.
    
    Args:
        container_name (str): Name of container to restart
        
    Returns:
        bool: True if successful, False otherwise
    """
    try:
        container = client.containers.get(container_name)
        logger.info(f"🔄 Restarting container: {container_name}")
        
        # Restart with 30 second timeout
        container.restart(timeout=30)
        
        logger.info(f"✅ Container '{container_name}' restarted successfully")
        logger.info(f"   GPU memory should be freed after service initialization")
        return True
        
    except docker.errors.NotFound:
        logger.error(f"❌ Container '{container_name}' not found")
        logger.error(f"   Available containers: {[c.name for c in client.containers.list()]}")
        return False
    except Exception as e:
        logger.error(f"❌ Failed to restart container: {e}")
        return False


# ============================================================================
# Main Monitoring Loop
# ============================================================================

def monitor_loop():
    """
    Main monitoring loop.
    
    Continuously monitors GPU and backend status, restarts container when:
    1. GPU memory exceeds threshold
    2. GPU utilization is below idle threshold
    3. Backend has no active tasks
    4. All conditions persist for IDLE_DURATION seconds
    """
    global idle_start_time, high_memory_detected
    
    # Print startup banner
    logger.info("=" * 70)
    logger.info("🚀 GPU MEMORY MONITOR STARTED")
    logger.info("=" * 70)
    logger.info(f"📋 Configuration:")
    logger.info(f"   Target Container    : {TARGET_CONTAINER}")
    logger.info(f"   Backend URL         : {BACKEND_URL}")
    logger.info(f"   GPU Memory Threshold: {GPU_MEMORY_THRESHOLD}%")
    logger.info(f"   GPU Idle Threshold  : {GPU_IDLE_THRESHOLD}%")
    logger.info(f"   Idle Duration       : {IDLE_DURATION}s")
    logger.info(f"   Check Interval      : {CHECK_INTERVAL}s")
    logger.info("=" * 70)
    logger.info("📊 Monitoring method: Task-based idle detection via /status endpoint")
    logger.info("=" * 70)
    
    while True:
        try:
            # Step 1: Get GPU statistics
            stats = get_gpu_stats()
            if not stats:
                logger.warning("⚠️  Skipping cycle - GPU stats unavailable")
                time.sleep(CHECK_INTERVAL)
                continue
            
            memory_percent = stats['memory_percent']
            gpu_util = stats['gpu_utilization']
            
            logger.info(
                f"📊 GPU - Memory: {memory_percent:.1f}% "
                f"({stats['memory_used']:.0f}/{stats['memory_total']:.0f} MB), "
                f"Utilization: {gpu_util:.1f}%"
            )
            
            # Step 2: Check if GPU memory is high
            if memory_percent > GPU_MEMORY_THRESHOLD:
                if not high_memory_detected:
                    logger.warning(f"⚠️  HIGH GPU MEMORY: {memory_percent:.1f}% > {GPU_MEMORY_THRESHOLD}%")
                    high_memory_detected = True
                
                # Step 3: Check if GPU is idle
                if gpu_util < GPU_IDLE_THRESHOLD:
                    
                    # Step 4: Check backend status
                    is_idle, active_count, service_state = check_backend_status()
                    
                    # If we can't check backend status, assume it's busy (safe default)
                    if is_idle is None:
                        logger.warning("⚠️  Cannot verify backend status - assuming busy for safety")
                        if idle_start_time is not None:
                            logger.info("⏸️  Pausing countdown due to backend check failure")
                        idle_start_time = None
                        time.sleep(CHECK_INTERVAL)
                        continue
                    
                    # Step 5: Check if backend is truly idle
                    if is_idle and active_count == 0:
                        # All conditions met - start or continue countdown
                        if idle_start_time is None:
                            idle_start_time = time.time()
                            logger.info("=" * 70)
                            logger.info("⏱️  ALL CONDITIONS MET - STARTING COUNTDOWN")
                            logger.info(f"   ✓ GPU Memory: {memory_percent:.1f}% > {GPU_MEMORY_THRESHOLD}%")
                            logger.info(f"   ✓ GPU Idle: {gpu_util:.1f}% < {GPU_IDLE_THRESHOLD}%")
                            logger.info(f"   ✓ Backend: 0 active tasks")
                            logger.info(f"   ⏳ Countdown: {IDLE_DURATION}s")
                            logger.info("=" * 70)
                        else:
                            idle_duration = time.time() - idle_start_time
                            remaining = IDLE_DURATION - idle_duration
                            
                            logger.info(
                                f"⏱️  Countdown: {idle_duration:.0f}s / {IDLE_DURATION}s "
                                f"(restart in {remaining:.0f}s)"
                            )
                            
                            # Step 6: Check if countdown complete
                            if idle_duration >= IDLE_DURATION:
                                logger.warning("=" * 70)
                                logger.warning("🎯 RESTART CONDITIONS SATISFIED!")
                                logger.warning(f"   GPU Memory   : {memory_percent:.1f}% (threshold: {GPU_MEMORY_THRESHOLD}%)")
                                logger.warning(f"   GPU Util     : {gpu_util:.1f}% (threshold: {GPU_IDLE_THRESHOLD}%)")
                                logger.warning(f"   Active Tasks : {active_count}")
                                logger.warning(f"   Idle Duration: {idle_duration:.0f}s (required: {IDLE_DURATION}s)")
                                logger.warning(f"   Time         : {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
                                logger.warning("=" * 70)
                                
                                # Restart container
                                if restart_container(TARGET_CONTAINER):
                                    logger.info("🎉 Restart successful!")
                                    logger.info("⏸️  Waiting 60 seconds for service to stabilize...")
                                    
                                    # Reset state
                                    idle_start_time = None
                                    high_memory_detected = False
                                    
                                    # Wait for service to restart and stabilize
                                    time.sleep(60)
                                    
                                    logger.info("✅ Resuming monitoring...")
                                else:
                                    logger.error("❌ Restart failed - will retry on next cycle")
                                    idle_start_time = None
                    else:
                        # Backend has active tasks
                        if idle_start_time is not None:
                            logger.info(f"⚙️  Backend active ({active_count} tasks) - resetting countdown")
                        idle_start_time = None
                else:
                    # GPU is being used
                    if idle_start_time is not None:
                        logger.info(f"🔥 GPU active ({gpu_util:.1f}%) - resetting countdown")
                    idle_start_time = None
            else:
                # Memory is below threshold - all good
                if high_memory_detected:
                    logger.info(f"✅ GPU memory normal: {memory_percent:.1f}% (threshold: {GPU_MEMORY_THRESHOLD}%)")
                high_memory_detected = False
                idle_start_time = None
            
        except KeyboardInterrupt:
            raise
        except Exception as e:
            logger.error(f"❌ Error in monitoring loop: {e}", exc_info=True)
            # Reset state on error to be safe
            idle_start_time = None
        
        # Wait before next check
        time.sleep(CHECK_INTERVAL)


# ============================================================================
# Startup and Main Execution
# ============================================================================

def test_connectivity():
    """Test connectivity to backend service."""
    logger.info("🔍 Testing backend connectivity...")
    
    try:
        response = requests.get(f"{BACKEND_URL}/health", timeout=5)
        if response.ok:
            logger.info("✅ Backend health check: OK")
            
            # Try status endpoint
            status_response = requests.get(f"{BACKEND_URL}/status", timeout=5)
            if status_response.ok:
                data = status_response.json()
                logger.info(f"✅ Backend /status endpoint: OK")
                logger.info(f"   Service state: {data.get('service_state', 'unknown')}")
                logger.info(f"   Active tasks: {data.get('tasks', {}).get('active', 0)}")
                return True
            else:
                logger.warning(f"⚠️  Backend /status returned: {status_response.status_code}")
                logger.warning("   Monitor will work but may have reduced functionality")
                return False
        else:
            logger.warning(f"⚠️  Backend health check returned: {response.status_code}")
            return False
    except Exception as e:
        logger.warning(f"⚠️  Cannot reach backend: {e}")
        logger.warning("   Monitor will continue but restart functionality may be limited")
        return False


if __name__ == "__main__":
    logger.info("⏳ Waiting 30 seconds for services to initialize...")
    time.sleep(30)
    
    # Test connectivity
    test_connectivity()
    
    logger.info("")
    logger.info("🎬 Starting main monitoring loop in 5 seconds...")
    time.sleep(5)
    
    try:
        monitor_loop()
    except KeyboardInterrupt:
        logger.info("")
        logger.info("=" * 70)
        logger.info("🛑 Monitor stopped by user")
        logger.info("=" * 70)
    except Exception as e:
        logger.error("")
        logger.error("=" * 70)
        logger.error(f"💥 Fatal error: {e}")
        logger.error("=" * 70)
        raise