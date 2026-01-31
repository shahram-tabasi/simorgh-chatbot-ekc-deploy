import React from 'react';

// Get base URL for assets
const baseUrl = import.meta.env.BASE_URL || '/';

export default function CleanWhiteBackground() {
  return (
    <div
      className="fixed inset-0 pointer-events-none"
      style={{
        backgroundImage: `url(${baseUrl}digital-ekc.svg)`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        opacity: 0.3 // تنظیم شفافیت - عدد بین 0 تا 1
      }}
    />
  );
}
