/**
 * Not Found (404) Page
 * Displays a user-friendly 404 error page when users navigate to non-existent routes
 * Logs the attempted route to console for debugging purposes
 */

import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { useSeoOverride } from "@/hooks/useDocumentTitle";

const NotFound = () => {
  const location = useLocation();
  useSeoOverride({ robots: "noindex,follow" });

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100">
      <div className="text-center">
        <h1 className="mb-4 text-4xl font-bold">404</h1>
        <p className="mb-4 text-xl text-gray-600">Oops! Page not found</p>
        <Link to="/" className="text-blue-500 underline hover:text-blue-700">
          Return to Home
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
