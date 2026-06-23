import React, { useEffect, useState } from 'react';

const CopyNotification: React.FC = () => {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const handleCopy = () => {
      setShow(true);
    };

    document.addEventListener('copy', handleCopy);

    return () => {
      document.removeEventListener('copy', handleCopy);
    };
  }, []);

  useEffect(() => {
    if (show) {
      const timer = setTimeout(() => {
        setShow(false);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [show]);

  if (!show) return null;

  return (
    <div className="fixed top-4 right-4 z-[300] bg-text-primary text-bg-primary px-3 py-1.5 font-mono text-[0.7rem] uppercase tracking-widest shadow-md">
      Copied
    </div>
  );
};

export default CopyNotification;
