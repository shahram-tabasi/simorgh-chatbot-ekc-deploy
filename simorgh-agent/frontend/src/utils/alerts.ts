/**
 * Sweet Alert 2 Utility Wrapper
 * Provides beautiful, modern alerts to replace browser's default alert()
 */

import Swal from 'sweetalert2';

/**
 * Show a success alert
 */
export const showSuccess = (title: string, text?: string) => {
  return Swal.fire({
    icon: 'success',
    title,
    text,
    background: '#1a1f35',
    color: '#fff',
    confirmButtonColor: '#10b981',
    customClass: {
      popup: 'border border-white/20 rounded-2xl',
      confirmButton: 'px-6 py-2 rounded-lg font-semibold'
    }
  });
};

/**
 * Show an error alert
 */
export const showError = (title: string, text?: string) => {
  return Swal.fire({
    icon: 'error',
    title,
    text,
    background: '#1a1f35',
    color: '#fff',
    confirmButtonColor: '#ef4444',
    customClass: {
      popup: 'border border-white/20 rounded-2xl',
      confirmButton: 'px-6 py-2 rounded-lg font-semibold'
    }
  });
};

/**
 * Show a warning alert
 */
export const showWarning = (title: string, text?: string) => {
  return Swal.fire({
    icon: 'warning',
    title,
    text,
    background: '#1a1f35',
    color: '#fff',
    confirmButtonColor: '#f59e0b',
    customClass: {
      popup: 'border border-white/20 rounded-2xl',
      confirmButton: 'px-6 py-2 rounded-lg font-semibold'
    }
  });
};

/**
 * Show an info alert
 */
export const showInfo = (title: string, text?: string) => {
  return Swal.fire({
    icon: 'info',
    title,
    text,
    background: '#1a1f35',
    color: '#fff',
    confirmButtonColor: '#3b82f6',
    customClass: {
      popup: 'border border-white/20 rounded-2xl',
      confirmButton: 'px-6 py-2 rounded-lg font-semibold'
    }
  });
};

/**
 * Show a confirmation dialog
 */
export const showConfirm = (title: string, text?: string, confirmButtonText = 'Yes', cancelButtonText = 'Cancel') => {
  return Swal.fire({
    title,
    text,
    icon: 'question',
    showCancelButton: true,
    confirmButtonText,
    cancelButtonText,
    background: '#1a1f35',
    color: '#fff',
    confirmButtonColor: '#10b981',
    cancelButtonColor: '#6b7280',
    customClass: {
      popup: 'border border-white/20 rounded-2xl',
      confirmButton: 'px-6 py-2 rounded-lg font-semibold',
      cancelButton: 'px-6 py-2 rounded-lg font-semibold'
    }
  });
};

/**
 * Show a simple message (replaces alert())
 */
export const showMessage = (message: string) => {
  return Swal.fire({
    text: message,
    background: '#1a1f35',
    color: '#fff',
    confirmButtonColor: '#3b82f6',
    customClass: {
      popup: 'border border-white/20 rounded-2xl',
      confirmButton: 'px-6 py-2 rounded-lg font-semibold'
    }
  });
};

/**
 * Show a toast notification (non-blocking)
 */
export const showToast = (message: string, icon: 'success' | 'error' | 'warning' | 'info' = 'info') => {
  return Swal.fire({
    toast: true,
    position: 'top-end',
    icon,
    title: message,
    showConfirmButton: false,
    timer: 3000,
    timerProgressBar: true,
    background: '#1a1f35',
    color: '#fff',
    customClass: {
      popup: 'border border-white/20'
    }
  });
};
