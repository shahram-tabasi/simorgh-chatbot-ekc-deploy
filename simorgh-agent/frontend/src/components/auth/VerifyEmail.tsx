// src/components/auth/VerifyEmail.tsx
import React, { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, X, Loader, ArrowRight, Mail, Sparkles } from 'lucide-react';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

type VerificationStatus = 'loading' | 'success' | 'error';

export default function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const navigate = useNavigate();
  const { verifyEmail } = useAuth();

  const [status, setStatus] = useState<VerificationStatus>('loading');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const verify = async () => {
      if (!token) {
        setStatus('error');
        setErrorMessage('Invalid verification link');
        return;
      }

      try {
        await verifyEmail?.(token);
        setStatus('success');
      } catch (error: any) {
        setStatus('error');
        setErrorMessage(error.message || 'Verification failed. The link may have expired.');
      }
    };

    verify();
  }, [token, verifyEmail]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50 dark:bg-gray-900">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-md text-center"
      >
        {/* Logo */}
        <div className="mb-8">
          <div className="w-16 h-16 bg-gradient-to-br from-emerald-500 to-teal-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg">
            <Sparkles className="w-8 h-8 text-white" />
          </div>
        </div>

        {/* Loading State */}
        {status === 'loading' && (
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8">
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
              className="w-16 h-16 border-4 border-emerald-200 border-t-emerald-600 rounded-full mx-auto mb-6"
            />
            <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
              Verifying your email...
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              Please wait while we verify your email address.
            </p>
          </div>
        )}

        {/* Success State */}
        {status === 'success' && (
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.2, type: "spring" }}
              className="w-20 h-20 bg-emerald-100 dark:bg-emerald-900/30 rounded-full flex items-center justify-center mx-auto mb-6"
            >
              <Check className="w-10 h-10 text-emerald-600 dark:text-emerald-400" />
            </motion.div>

            <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-3">
              Email verified!
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mb-8">
              Your email has been verified successfully. You can now access all features of Simorgh AI.
            </p>

            <Link
              to="/login"
              className="inline-flex items-center gap-2 px-6 py-3 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition font-medium"
            >
              Sign in to your account
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        )}

        {/* Error State */}
        {status === 'error' && (
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.2, type: "spring" }}
              className="w-20 h-20 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mx-auto mb-6"
            >
              <X className="w-10 h-10 text-red-600 dark:text-red-400" />
            </motion.div>

            <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-3">
              Verification failed
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mb-8">
              {errorMessage}
            </p>

            <div className="space-y-4">
              <Link
                to="/login"
                className="block w-full px-6 py-3 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 transition font-medium"
              >
                Go to login
              </Link>
              <Link
                to="/signup"
                className="block w-full px-6 py-3 border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-700 transition font-medium"
              >
                Create new account
              </Link>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
