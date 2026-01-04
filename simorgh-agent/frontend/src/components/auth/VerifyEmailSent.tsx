// src/components/auth/VerifyEmailSent.tsx
import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Mail, ArrowLeft, RefreshCw, Loader, Sparkles } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

export default function VerifyEmailSent() {
  const location = useLocation();
  const email = location.state?.email || 'your email';
  const { resendVerification, isLoading } = useAuth();
  const [resent, setResent] = useState(false);

  const handleResend = async () => {
    try {
      await resendVerification?.(email);
      setResent(true);
      setTimeout(() => setResent(false), 30000); // Reset after 30 seconds
    } catch (error) {
      console.error('Resend error:', error);
    }
  };

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

        {/* Card */}
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2, type: "spring" }}
            className="w-20 h-20 bg-emerald-100 dark:bg-emerald-900/30 rounded-full flex items-center justify-center mx-auto mb-6"
          >
            <Mail className="w-10 h-10 text-emerald-600 dark:text-emerald-400" />
          </motion.div>

          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-3">
            Check your inbox
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mb-2">
            We've sent a verification link to
          </p>
          <p className="text-lg font-medium text-gray-900 dark:text-white mb-6">
            {email}
          </p>

          <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-4 mb-6">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Click the link in the email to verify your account. The link will expire in 24 hours.
            </p>
          </div>

          {/* Resend Button */}
          <button
            onClick={handleResend}
            disabled={isLoading || resent}
            className="inline-flex items-center gap-2 text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <>
                <Loader className="w-4 h-4 animate-spin" />
                <span>Sending...</span>
              </>
            ) : resent ? (
              <span>Email sent! Check your inbox.</span>
            ) : (
              <>
                <RefreshCw className="w-4 h-4" />
                <span>Resend verification email</span>
              </>
            )}
          </button>

          {/* Tips */}
          <div className="mt-8 pt-6 border-t border-gray-200 dark:border-gray-700">
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
              Didn't receive the email?
            </p>
            <ul className="text-sm text-gray-500 dark:text-gray-400 space-y-1">
              <li>• Check your spam or junk folder</li>
              <li>• Make sure the email address is correct</li>
              <li>• Wait a few minutes and try resending</li>
            </ul>
          </div>

          {/* Back to Login */}
          <div className="mt-6">
            <Link
              to="/login"
              className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200 text-sm"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to login
            </Link>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
